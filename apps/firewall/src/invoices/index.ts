import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { evaluatePolicy } from '../../../../packages/policy/src/index.ts';
import type {
  LoadedPolicy,
  PolicyDecision,
} from '../../../../packages/policy/src/index.ts';
import { AuditLog } from '../audit/index.ts';
import type { AuditReceipt } from '../audit/index.ts';
import { prepareEvent } from '../audit/event.ts';
import type { ContextResolver, PolicyContext } from '../context/index.ts';
import {
  email,
  freeze,
  identifier,
  object,
  snapshot,
} from '../context/json.ts';
import { canonical } from '../refunds.ts';
import {
  encodeRuleReferences,
  decodeRuleReferences,
} from '../velocity/references.ts';

export type InvoiceResult = PolicyDecision &
  Readonly<{
    replayed: boolean;
    dispatchAllowed: boolean;
    expiresAt?: string;
    receipt?: AuditReceipt;
    reason?:
      | 'invoice_unavailable'
      | 'request_conflict'
      | 'invoice_reserved'
      | 'approval_unsupported';
  }>;
type Stored = {
  merchant_ref: string;
  request_id: string;
  key_id: string;
  customer_ref: string;
  binding_hash: string;
  invoice_ref: string | null;
  agent_id: string;
  tool: string;
  args_hash: string;
  policy_version: string;
  decision: 'allow' | 'deny';
  day: string;
  audit_id: string;
  audit_hash: string;
  matched_rules: string[];
  valid: boolean;
};

// Trusted server composition only. This class never sends an invoice.
export class InvoicePolicy {
  readonly #key: Buffer;
  private readonly pool: Pick<Pool, 'connect'>;
  private readonly resolver: ContextResolver;
  constructor(
    pool: Pick<Pool, 'connect'>,
    options: { identityKey: string; resolver: ContextResolver },
  ) {
    if (
      typeof options.identityKey !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(options.identityKey)
    )
      throw new Error('Invalid invoice policy configuration.');
    this.#key = Buffer.from(options.identityKey, 'hex');
    this.pool = pool;
    this.resolver = options.resolver;
  }
  private ref(domain: string, value: unknown): string {
    return createHmac('sha256', this.#key)
      .update(canonical(['spendwall/invoice-policy', 1, domain, value]))
      .digest('hex');
  }
  async evaluateAndReserve(
    policy: LoadedPolicy,
    input: unknown,
    trustedContext: unknown,
  ): Promise<InvoiceResult> {
    const deny = (
      reason: NonNullable<InvoiceResult['reason']>,
    ): InvoiceResult =>
      freeze({
        decision: 'deny',
        matchedRules: [],
        policyVersion: policy.policyVersion,
        replayed: false,
        dispatchAllowed: false,
        reason,
      });
    let client: PoolClient | undefined;
    let committed = false;
    try {
      const submitted = object(snapshot(input));
      if (
        Object.keys(submitted).length !== 3 ||
        !['requestId', 'tool', 'args'].every((k) =>
          Object.hasOwn(submitted, k),
        ) ||
        typeof submitted.requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          submitted.requestId,
        ) ||
        !['create_invoice', 'send_invoice'].includes(String(submitted.tool))
      )
        return deny('invoice_unavailable');
      object(submitted.args);
      const trusted = object(snapshot(trustedContext));
      client = await this.pool.connect();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('spendwall/invoice-policy/v1',0))",
      );
      // Resolve only after the queue wait, so expired pre-lock facts cannot authorize a reservation.
      const resolution = await this.resolver.resolve(
        { tool: submitted.tool, args: submitted.args },
        { ...trusted, agg: {} },
      );
      if (!resolution.ok) return deny('invoice_unavailable');
      const context: PolicyContext = {
        ...resolution.context,
        customer: {
          ...resolution.context.customer,
          email_domain: email(resolution.context.customer.email).split('@')[1]!,
        },
        agg: {},
      };
      const merchantId = identifier(context.merchant.id);
      const requestId = submitted.requestId.toLowerCase();
      const metadata = {
        merchant_ref: this.ref('merchant', merchantId),
        request_id: requestId,
        key_id: this.ref('key', 'continuity'),
        customer_ref: this.ref('customer', [
          merchantId,
          identifier(context.customer.id),
        ]),
        binding_hash: this.ref('request', {
          requestId,
          context,
          resolvedCtx: resolution.resolvedCtx,
          policyVersion: policy.policyVersion,
        }),
        invoice_ref:
          context.tool === 'send_invoice'
            ? this.ref('invoice', [
                merchantId,
                identifier(context.args.invoice_id, 1, 127),
              ])
            : null,
      };
      const auditInput = {
        agentId: `agent:${this.ref('agent', identifier(context.agent.id))}`,
        tool: context.tool,
        args: context.args,
        resolvedCtx: resolution.resolvedCtx,
        decision: 'deny' as const,
        matchedRules: [] as string[],
        policyVersion: policy.policyVersion,
        eventKind: 'tool_call' as const,
        latencyMs: 0,
      };
      const prepared = prepareEvent(auditInput);
      const { rows } =
        await client.query<Stored>(`SELECT d.*, d.day::text AS day, d.audit_id::text AS audit_id, e.matched_rules,
        COALESCE(e.row_hash=d.audit_hash AND e.agent_id=d.agent_id AND e.tool=d.tool AND e.args_hash=d.args_hash
          AND e.policy_version=d.policy_version AND e.decision=d.decision AND e.event_kind='tool_call'
          AND e.approval_id IS NULL AND e.upstream_status IS NULL AND e.upstream_result_ref IS NULL,false) AS valid
        FROM invoice_policy.decisions d LEFT JOIN audit.audit_events e ON e.id=d.audit_id ORDER BY d.audit_id LIMIT 10001`);
      if (
        rows.length > 10000 ||
        rows.some((row) => !row.valid || row.key_id !== metadata.key_id)
      )
        throw new Error();
      // Earlier invoice allowances outside this composition cannot be treated as zero history.
      const orphan = await client.query<{
        missing: boolean;
      }>(`SELECT EXISTS (SELECT FROM audit.audit_events e
        WHERE e.tool IN ('create_invoice','send_invoice') AND e.decision<>'deny'
          AND NOT EXISTS (SELECT FROM invoice_policy.decisions d WHERE d.audit_id=e.id)) AS missing`);
      if (orphan.rows[0]?.missing !== false) throw new Error();
      const now = (
        await client.query<{
          day: string;
          expires_at: string;
        }>(`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day,
        (((clock_timestamp() AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC')::text AS expires_at`)
      ).rows[0]!;
      if (rows.some((row) => row.day > now.day)) throw new Error();
      const previous = rows.find(
        (row) =>
          row.merchant_ref === metadata.merchant_ref &&
          row.request_id === requestId,
      );
      if (previous) {
        if (
          previous.binding_hash !== metadata.binding_hash ||
          previous.policy_version !== policy.policyVersion
        )
          return deny('request_conflict');
        const result: InvoiceResult = freeze({
          decision: previous.decision,
          matchedRules: decodeRuleReferences(
            policy.rules,
            previous.matched_rules,
          ),
          policyVersion: previous.policy_version,
          receipt: { id: previous.audit_id, row_hash: previous.audit_hash },
          replayed: true,
          dispatchAllowed: false,
        });
        await client.query('COMMIT');
        committed = true;
        return result;
      }
      if (
        metadata.invoice_ref &&
        rows.some(
          (row) =>
            row.merchant_ref === metadata.merchant_ref &&
            row.invoice_ref === metadata.invoice_ref &&
            row.decision === 'allow',
        )
      )
        return deny('invoice_reserved');
      const count = rows.filter(
        (row) =>
          row.merchant_ref === metadata.merchant_ref &&
          row.customer_ref === metadata.customer_ref &&
          row.day === now.day &&
          row.tool === 'send_invoice' &&
          row.decision === 'allow',
      ).length;
      const evaluation = evaluatePolicy(policy, {
        ...context,
        agg: { invoice_send_count_day: count },
      });
      const unsupported = evaluation.decision === 'require_approval';
      const decision = {
        ...evaluation,
        decision: unsupported ? ('deny' as const) : evaluation.decision,
      };
      const receipt = await new AuditLog(client).append({
        ...auditInput,
        ...decision,
        matchedRules: encodeRuleReferences(policy.rules, decision.matchedRules),
      });
      const record = JSON.stringify({
        ...metadata,
        agent_id: prepared.agent_id,
        tool: context.tool,
        args_hash: prepared.args_hash,
        policy_version: policy.policyVersion,
        decision: decision.decision,
        day: now.day,
        audit_id: receipt.id,
        audit_hash: receipt.row_hash,
      });
      await client.query('SELECT invoice_policy.record_decision($1::jsonb)', [
        record,
      ]);
      const stored = await client.query<{ recorded: boolean }>(
        `SELECT EXISTS (SELECT FROM invoice_policy.decisions d
        WHERE d IS NOT DISTINCT FROM jsonb_populate_record(NULL::invoice_policy.decisions,$1::jsonb)) AS recorded`,
        [record],
      );
      if (stored.rows[0]?.recorded !== true) throw new Error();
      await client.query('COMMIT');
      committed = true;
      return freeze({
        ...decision,
        receipt,
        replayed: false,
        dispatchAllowed: decision.decision === 'allow',
        expiresAt: new Date(now.expires_at).toISOString(),
        ...(unsupported ? { reason: 'approval_unsupported' as const } : {}),
      });
    } catch {
      return deny('invoice_unavailable');
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
