import type { PolicyReplay } from '../policy-preview/replay.ts';
import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  evaluatePolicy,
  normalizeAmount,
} from '../../../../packages/policy/src/index.ts';
import type {
  LoadedPolicy,
  PolicyDecision,
} from '../../../../packages/policy/src/index.ts';
import { AuditLog } from '../audit/index.ts';
import type { AuditReceipt } from '../audit/index.ts';
import { prepareEvent } from '../audit/event.ts';
import { parseVelocityMetadata } from '../audit/velocity.ts';
import { identifier, object, snapshot } from '../context/json.ts';
import type { Json } from '../context/json.ts';
import { foldHistory } from './aggregate.ts';
import type { HistoryRow } from './aggregate.ts';
import { encodeRuleReferences, decodeRuleReferences } from './references.ts';

export type VelocityResult = PolicyDecision &
  Readonly<{
    replayed: boolean;
    receipt?: AuditReceipt;
    approvalId?: string;
    reason?: 'velocity_unavailable' | 'request_conflict';
  }>;

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export class VelocityPolicy {
  readonly #key: Buffer;
  private readonly replay: PolicyReplay | undefined;
  private readonly pool: Pick<Pool, 'connect'>;
  private readonly clock: (() => number) | undefined;
  constructor(
    pool: Pick<Pool, 'connect'>,
    options: {
      identityKey: string;
      clock?: () => number;
      replay?: PolicyReplay;
    },
  ) {
    if (
      typeof options?.identityKey !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(options.identityKey) ||
      (options.clock !== undefined && typeof options.clock !== 'function')
    )
      throw new Error('Invalid velocity configuration.');
    this.#key = Buffer.from(options.identityKey, 'hex');
    options.replay?.assertIndependent(options.identityKey);
    this.replay = options.replay;
    this.pool = pool;
    this.clock = options.clock;
  }

  private reference(domain: string, value: Json): string {
    return createHmac('sha256', this.#key)
      .update(canonical(['spendwall/velocity', 1, domain, value]))
      .digest('hex');
  }

  async evaluateAndReserve(
    policy: LoadedPolicy,
    input: unknown,
  ): Promise<VelocityResult> {
    const denied = (
      reason: 'velocity_unavailable' | 'request_conflict',
    ): VelocityResult =>
      Object.freeze({
        decision: 'deny',
        matchedRules: Object.freeze([]),
        policyVersion: policy.policyVersion,
        replayed: false,
        reason,
      });
    let client: PoolClient | undefined;
    let committed = false;
    const started = performance.now();
    try {
      const submitted = object(snapshot(input));
      if (
        Object.keys(submitted).some(
          (key) => !['requestId', 'context', 'resolvedCtx'].includes(key),
        )
      )
        throw new Error();
      const context = object(submitted.context);
      const expected = [
        'tool',
        'args',
        'amount',
        'agent',
        'customer',
        'merchant',
        'agg',
      ];
      if (
        Object.keys(context).length !== expected.length ||
        expected.some((key) => !Object.hasOwn(context, key)) ||
        context.tool !== 'create_refund'
      )
        throw new Error();
      object(context.args);
      const agentId = identifier(object(context.agent).id);
      const auditAgentId = `agent:${this.reference('agent', agentId)}`;
      const merchantId = identifier(object(context.merchant).id);
      const customerId = identifier(object(context.customer).id);
      const amount = normalizeAmount(context.amount);
      const resolvedCtx = object(submitted.resolvedCtx ?? {});
      const metadata = parseVelocityMetadata({
        v: 1,
        key_id: this.reference('key', 'continuity'),
        merchant_ref: this.reference('merchant', merchantId),
        customer_ref: this.reference('customer', [merchantId, customerId]),
        request_id:
          typeof submitted.requestId === 'string'
            ? submitted.requestId.toLowerCase()
            : submitted.requestId,
        binding_hash: this.reference('request', {
          requestId:
            typeof submitted.requestId === 'string'
              ? submitted.requestId.toLowerCase()
              : null,
          context: { ...context, agg: {} },
          resolvedCtx,
          policyVersion: policy.policyVersion,
        }),
        usd_cents: Math.round(amount.usd * 100),
      });
      const auditInput = {
        agentId: auditAgentId,
        tool: 'create_refund',
        args: context.args,
        resolvedCtx,
        decision: 'deny' as const,
        matchedRules: [] as string[],
        policyVersion: policy.policyVersion,
        eventKind: 'tool_call' as const,
        latencyMs: 0,
        velocity: metadata,
      };
      // Validate the exact audit input before opening a transaction.
      prepareEvent(auditInput);
      client = await this.pool.connect();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`spendwall/velocity/v1/${metadata.merchant_ref}`],
      );
      const { rows } = await client.query<HistoryRow>(
        `SELECT id::text, row_hash, (extract(epoch FROM ts) * 1000)::float8 AS ts_ms, agent_id, tool, args_hash, decision, event_kind, approval_id, upstream_status, upstream_result_ref, policy_version, matched_rules, resolved_ctx FROM audit.audit_events e WHERE tool = 'create_refund' AND (decision <> 'deny' OR resolved_ctx ? 'velocity') ORDER BY e.id LIMIT 10001`,
      );
      const now = this.clock
        ? this.clock()
        : (
            await client.query<{ now: number }>(
              'SELECT (extract(epoch FROM clock_timestamp()::timestamptz(3)) * 1000)::float8 AS now',
            )
          ).rows[0]!.now;
      const history = foldHistory(rows, {
        now,
        merchantRef: metadata.merchant_ref,
        customerRef: metadata.customer_ref,
        agentId: auditAgentId,
        keyId: metadata.key_id,
      });
      const previous = history.requests.get(metadata.request_id);
      if (previous) {
        if (
          previous.metadata.binding_hash !== metadata.binding_hash ||
          previous.initial.policy_version !== policy.policyVersion
        )
          return denied('request_conflict');
        const initial = previous.initial;
        const result: VelocityResult = Object.freeze({
          decision: initial.decision,
          matchedRules: Object.freeze(
            decodeRuleReferences(policy.rules, initial.matched_rules),
          ),
          policyVersion: initial.policy_version,
          receipt: Object.freeze({
            id: initial.id,
            row_hash: initial.row_hash,
          }),
          replayed: true,
          ...(initial.approval_id ? { approvalId: initial.approval_id } : {}),
        });
        await client.query('COMMIT');
        committed = true;
        return result;
      }
      const evaluationContext = { ...context, agg: history.agg };
      const decision = evaluatePolicy(policy, evaluationContext);
      const approvalId =
        decision.decision === 'require_approval' ? randomUUID() : undefined;
      const receipt = await new AuditLog(client).append({
        ...auditInput,
        ...decision,
        matchedRules: encodeRuleReferences(policy.rules, decision.matchedRules),
        ...(approvalId ? { approvalId } : {}),
        latencyMs: Math.min(
          2_147_483_647,
          Math.max(0, Math.floor(performance.now() - started)),
        ),
      });
      await this.replay?.record(client, receipt, evaluationContext, policy);
      // A server missing migration 002 would silently redact these references.
      // Check the actual stored row before committing an allowance/reservation.
      const stored = (
        await client.query<{ velocity: unknown }>(
          "SELECT resolved_ctx -> 'velocity' AS velocity FROM audit.audit_events WHERE id = $1::bigint",
          [receipt.id],
        )
      ).rows[0];
      if (
        !stored ||
        canonical(parseVelocityMetadata(stored.velocity)) !==
          canonical(metadata)
      )
        throw new Error();
      await client.query('COMMIT');
      committed = true;
      return Object.freeze({
        ...decision,
        receipt: Object.freeze(receipt),
        replayed: false,
        ...(approvalId ? { approvalId } : {}),
      });
    } catch {
      return denied('velocity_unavailable');
    } finally {
      if (client) {
        let discard = false;
        if (!committed) {
          try {
            await client.query('ROLLBACK');
          } catch {
            discard = true;
          }
        }
        client.release(discard);
      }
    }
  }
}
