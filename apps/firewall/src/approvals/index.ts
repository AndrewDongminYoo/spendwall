import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { LoadedPolicy } from '../../../../packages/policy/src/index.ts';
import { AuditLog } from '../audit/index.ts';
import { prepareEvent } from '../audit/event.ts';
import type { AuditEvent } from '../audit/event.ts';
import { parseVelocityMetadata } from '../audit/velocity.ts';
import { identifier, object } from '../context/json.ts';
import { RefundExecutor, canonical } from '../refunds.ts';
import type { RefundResult } from '../refunds.ts';
import { VelocityPolicy } from '../velocity/index.ts';
import {
  ApprovalKeys,
  approvalId,
  invalid,
  prepareApproval,
} from './binding.ts';
import type { PreparedApproval } from './binding.ts';

type State = 'pending' | 'approved' | 'denied' | 'expired';
type ExecutionState = 'in_flight' | 'succeeded' | 'failed' | 'unknown';
type Row = {
  approval_id: string;
  reservation_id: string;
  owner_ref: string;
  adapter_ref: string;
  binding_ref: string;
  request_sealed: string;
  result_sealed: string | null;
  created_at: Date;
  expires_at: Date;
  approval_state: State;
  execution_state: ExecutionState | null;
  execution_id: string | null;
  started_at: Date | null;
  audit_agent: string;
  args_hash: string;
  matched_rules: string[];
  policy_version: string;
  resolved_ctx: { velocity?: unknown };
};
type Source = {
  id: string;
  row_hash: string;
  approval_id: string;
  decision: string;
  event_kind: string;
  ts: Date;
  resolved_ctx: { velocity?: unknown };
};
export type ApprovalView = Readonly<{
  approval_id: string;
  status: State;
  execution_state: ExecutionState | null;
  execution_id: string | null;
  result: RefundResult | null;
}>;
type Options = {
  identityKey: string;
  merchantId: string;
  executor: Pick<RefundExecutor, 'identity' | 'execute' | 'reconcile'>;
  clock?: () => number | undefined;
};
const selectRow = `SELECT p.*, e.agent_id AS audit_agent,e.args_hash,e.matched_rules,e.policy_version,e.resolved_ctx
 FROM approvals.requests p JOIN audit.audit_events e ON e.id=p.reservation_id
 WHERE p.approval_id=$1::uuid AND p.owner_ref=$2`;

export class ApprovalService {
  private readonly pool: Pick<Pool, 'connect'>;
  private readonly keys: ApprovalKeys;
  private readonly velocity: VelocityPolicy;
  private readonly executor: Options['executor'];
  private readonly merchant: string;
  private readonly adapter: string;
  private readonly clock: Options['clock'];
  constructor(pool: Pick<Pool, 'connect'>, options: Options) {
    this.pool = pool;
    this.keys = new ApprovalKeys(options.identityKey);
    this.merchant = identifier(options.merchantId);
    this.executor = options.executor;
    this.adapter = options.executor.identity;
    this.clock = options.clock;
    if (
      !/^[a-f0-9]{64}$/.test(this.adapter) ||
      (this.clock !== undefined && typeof this.clock !== 'function')
    )
      invalid();
    this.velocity = new VelocityPolicy(pool, {
      identityKey: options.identityKey,
    });
  }
  private prepared(policy: LoadedPolicy, input: unknown) {
    if (this.executor.identity !== this.adapter) invalid();
    return prepareApproval(
      policy.policyVersion,
      input,
      this.merchant,
      this.adapter,
    );
  }
  private owner(agent: string) {
    return this.keys.reference('owner', [this.merchant, identifier(agent)]);
  }
  private aad(
    row: Pick<
      Row,
      | 'approval_id'
      | 'reservation_id'
      | 'owner_ref'
      | 'adapter_ref'
      | 'binding_ref'
    >,
  ) {
    return canonical([
      'approval.v1',
      row.approval_id,
      row.reservation_id,
      row.owner_ref,
      row.adapter_ref,
      row.binding_ref,
    ]);
  }
  private async now(client: PoolClient) {
    const now =
      this.clock?.() ??
      (
        await client.query<{ now: number }>(
          'SELECT (extract(epoch FROM clock_timestamp()::timestamptz(3))*1000)::float8 AS now',
        )
      ).rows[0]!.now;
    if (!Number.isSafeInteger(now) || now < 0) invalid();
    return now;
  }
  private async begin(client: PoolClient, ref: string) {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `spendwall/velocity/v1/${ref}`,
    ]);
  }
  private async source(client: PoolClient, id: string) {
    const row = (
      await client.query<Source>(
        `SELECT id::text,row_hash,approval_id,decision,event_kind,ts,resolved_ctx FROM audit.audit_events WHERE approval_id=$1::uuid AND event_kind='tool_call' ORDER BY audit_events.id LIMIT 2`,
        [id],
      )
    ).rows;
    if (row.length !== 1 || row[0]!.decision !== 'require_approval') invalid();
    return row[0]!;
  }
  private async row(
    client: PoolClient,
    id: string,
    agent: string,
    lock = false,
  ) {
    const row = (
      await client.query<Row>(selectRow + (lock ? ' FOR UPDATE OF p' : ''), [
        id,
        this.owner(agent),
      ])
    ).rows[0];
    if (!row) invalid();
    return row;
  }
  private stored(row: Row) {
    if (row.adapter_ref !== this.keys.reference('adapter', this.adapter))
      invalid();
    const payload = object(this.keys.open(row.request_sealed, this.aad(row)));
    const data = prepareApproval(
      row.policy_version,
      payload.input,
      this.merchant,
      this.adapter,
    );
    if (
      payload.policyVersion !== row.policy_version ||
      this.keys.reference('binding', data.binding) !== row.binding_ref ||
      this.owner(data.binding.agentId) !== row.owner_ref
    )
      invalid();
    if (
      prepareEvent(
        this.event(row, data, 'approval_created', 'require_approval'),
      ).args_hash !== row.args_hash
    )
      invalid();
    return data;
  }
  private event(
    row: Row,
    data: PreparedApproval,
    kind: AuditEvent['eventKind'],
    decision: AuditEvent['decision'],
    confirmed = false,
  ): AuditEvent {
    return {
      agentId: row.audit_agent,
      tool: 'create_refund',
      args: data.input.context.args,
      resolvedCtx: data.input.resolvedCtx,
      matchedRules: row.matched_rules,
      policyVersion: row.policy_version,
      approvalId: row.approval_id,
      latencyMs: 0,
      eventKind: kind,
      decision,
      velocity: parseVelocityMetadata(row.resolved_ctx.velocity),
      ...(confirmed
        ? { upstreamStatus: 200, upstreamResultRef: row.execution_id! }
        : {}),
    };
  }
  private result(row: Row): RefundResult | null {
    if (!row.result_sealed) return null;
    return this.checkedResult(
      this.keys.open(
        row.result_sealed,
        this.aad(row) + ':result:' + row.execution_id,
      ),
      row,
      this.stored(row),
    );
  }
  private checkedResult(
    input: unknown,
    row: Row,
    data: PreparedApproval,
  ): RefundResult {
    const v = object(input),
      money = object(v.amount);
    if (
      v.executionId !== row.execution_id ||
      v.captureId !== data.binding.args.capture_id ||
      typeof v.id !== 'string' ||
      !['COMPLETED', 'PENDING', 'FAILED', 'CANCELLED'].includes(
        String(v.status),
      ) ||
      canonical(money) !== canonical(data.binding.amount)
    )
      invalid();
    identifier(v.id, 15, 32);
    return {
      executionId: row.execution_id!,
      captureId: String(v.captureId),
      id: v.id,
      status: v.status as RefundResult['status'],
      amount: data.binding.amount,
    };
  }
  private view(row: Row): ApprovalView {
    return Object.freeze({
      approval_id: row.approval_id,
      status: row.approval_state,
      execution_state: row.execution_state,
      execution_id: row.execution_id,
      result: this.result(row),
    });
  }
  private async expire(
    client: PoolClient,
    row: Row,
    data: PreparedApproval,
    now: number,
  ) {
    if (now < row.created_at.getTime()) invalid();
    if (row.approval_state === 'pending' && now >= row.expires_at.getTime()) {
      await client.query(
        "UPDATE approvals.requests SET approval_state='expired' WHERE approval_id=$1::uuid",
        [row.approval_id],
      );
      await new AuditLog(client).append(
        this.event(row, data, 'approval_decided', 'deny'),
      );
      row.approval_state = 'expired';
    }
  }
  private async release(client: PoolClient, lockedId?: string) {
    let discard = false;
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    if (lockedId && !discard) {
      try {
        const r = await client.query<{ released: boolean }>(
          'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS released',
          [`spendwall/approval/v1/${lockedId}`],
        );
        if (!r.rows[0]?.released) discard = true;
      } catch {
        discard = true;
      }
    }
    client.release(discard);
  }
  async request(policy: LoadedPolicy, input: unknown) {
    let client: PoolClient | undefined;
    try {
      const data = this.prepared(policy, input),
        reservation = await this.velocity.evaluateAndReserve(
          policy,
          data.input,
        );
      if (reservation.decision !== 'require_approval') return reservation;
      if (!reservation.approvalId || !reservation.receipt) invalid();
      const id = approvalId(reservation.approvalId);
      client = await this.pool.connect();
      const source = await this.source(client, id);
      if (
        source.id !== reservation.receipt.id ||
        source.row_hash !== reservation.receipt.row_hash
      )
        invalid();
      await this.begin(
        client,
        parseVelocityMetadata(source.resolved_ctx.velocity).merchant_ref,
      );
      const seed = {
        approval_id: id,
        reservation_id: source.id,
        owner_ref: this.owner(data.binding.agentId),
        adapter_ref: this.keys.reference('adapter', this.adapter),
        binding_ref: this.keys.reference('binding', data.binding),
      };
      const sealed = this.keys.seal(
        { input: data.input, policyVersion: policy.policyVersion },
        this.aad(seed),
      );
      const inserted = await client.query(
        `INSERT INTO approvals.requests(approval_id,reservation_id,owner_ref,adapter_ref,binding_ref,request_sealed,created_at,expires_at)
        VALUES($1,$2::bigint,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz+interval '15 minutes') ON CONFLICT(approval_id) DO NOTHING RETURNING approval_id`,
        [
          id,
          source.id,
          seed.owner_ref,
          seed.adapter_ref,
          seed.binding_ref,
          sealed,
          source.ts,
        ],
      );
      const row = await this.row(client, id, data.binding.agentId, true),
        stored = this.stored(row);
      if (
        row.reservation_id !== source.id ||
        row.binding_ref !== seed.binding_ref
      )
        invalid();
      if (inserted.rows.length)
        await new AuditLog(client).append(
          this.event(row, stored, 'approval_created', 'require_approval'),
        );
      await this.expire(client, row, stored, await this.now(client));
      await client.query('COMMIT');
      return row.approval_state === 'pending'
        ? Object.freeze({
            status: 'pending_approval' as const,
            approval_id: id,
          })
        : this.view(row);
    } catch {
      return invalid();
    } finally {
      if (client) await this.release(client);
    }
  }
  check(input: { agentId: string; approvalId: string }) {
    return this.handle('check', input.approvalId, input.agentId);
  }
  deny(id: string, agentId: string) {
    return this.handle('deny', id, agentId);
  }
  approve(id: string, policy: LoadedPolicy, input: unknown) {
    try {
      const data = this.prepared(policy, input);
      return this.handle('approve', id, data.binding.agentId, data);
    } catch {
      return Promise.reject(new Error('Approval unavailable.'));
    }
  }
  recover(id: string, policy: LoadedPolicy, input: unknown) {
    try {
      const data = this.prepared(policy, input);
      return this.handle('recover', id, data.binding.agentId, data);
    } catch {
      return Promise.reject(new Error('Approval unavailable.'));
    }
  }
  private async handle(
    mode: 'check' | 'deny' | 'approve' | 'recover',
    submittedId: string,
    agent: string,
    fresh?: PreparedApproval,
  ): Promise<ApprovalView> {
    let client: PoolClient | undefined,
      locked = false,
      id: string | undefined;
    try {
      id = approvalId(submittedId);
      identifier(agent);
      client = await this.pool.connect();
      locked = (
        await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
          [`spendwall/approval/v1/${id}`],
        )
      ).rows[0]!.locked;
      if (!locked) {
        const row = await this.row(client, id, agent);
        this.stored(row);
        if (
          fresh &&
          row.binding_ref !== this.keys.reference('binding', fresh.binding)
        )
          invalid();
        return this.view(row);
      }
      const source = await this.source(client, id);
      const ref = parseVelocityMetadata(
        source.resolved_ctx.velocity,
      ).merchant_ref;
      await this.begin(client, ref);
      let row = await this.row(client, id, agent, true);
      const data = this.stored(row),
        now = await this.now(client);
      if (
        fresh &&
        row.binding_ref !== this.keys.reference('binding', fresh.binding)
      )
        invalid();
      await this.expire(client, row, data, now);
      if (mode === 'check') {
        if (row.execution_state === 'in_flight') {
          await client.query(
            "UPDATE approvals.requests SET execution_state='unknown' WHERE approval_id=$1",
            [id],
          );
          await new AuditLog(client).append(
            this.event(row, data, 'approval_executed', 'deny'),
          );
          row.execution_state = 'unknown';
        }
        await client.query('COMMIT');
        return this.view(row);
      }
      if (mode === 'deny') {
        if (row.approval_state === 'approved') invalid();
        if (row.approval_state === 'pending') {
          await client.query(
            "UPDATE approvals.requests SET approval_state='denied' WHERE approval_id=$1",
            [id],
          );
          await new AuditLog(client).append(
            this.event(row, data, 'approval_decided', 'deny'),
          );
          row.approval_state = 'denied';
        }
        await client.query('COMMIT');
        return this.view(row);
      }
      if (row.approval_state === 'denied') invalid();
      if (row.approval_state === 'expired') {
        await client.query('COMMIT');
        return this.view(row);
      }
      if (row.approval_state === 'pending') {
        if (mode === 'recover') invalid();
        const execution = randomUUID();
        const updated = await client.query<Row>(
          `UPDATE approvals.requests SET approval_state='approved',execution_state='in_flight',execution_id=$2::uuid,started_at=to_timestamp($3::double precision/1000) WHERE approval_id=$1 RETURNING *`,
          [id, execution, now],
        );
        row = { ...row, ...updated.rows[0]! };
        await new AuditLog(client).append(
          this.event(row, data, 'approval_decided', 'allow'),
        );
      } else {
        if (
          mode !== 'recover' ||
          row.execution_state === 'succeeded' ||
          row.execution_state === 'failed'
        ) {
          await client.query('COMMIT');
          return this.view(row);
        }
        await client.query(
          "UPDATE approvals.requests SET execution_state='in_flight' WHERE approval_id=$1",
          [id],
        );
        row.execution_state = 'in_flight';
      }
      await client.query('COMMIT');
      let result: RefundResult | null = null;
      try {
        const readOnly =
          row.result_sealed !== null ||
          now - row.started_at!.getTime() >= 24 * 60 * 60 * 1000;
        result = this.checkedResult(
          await (readOnly
            ? this.executor.reconcile(row.execution_id!, data.binding.args)
            : this.executor.execute(row.execution_id!, data.binding.args, {
                notAfter: row.started_at!.getTime() + 24 * 60 * 60 * 1000,
              })),
          row,
          data,
        );
      } catch {
        /* An unconfirmed outcome never releases the reservation. */
      }
      await this.begin(client, ref);
      const latest = await this.row(client, id, agent, true);
      this.stored(latest);
      if (
        latest.execution_id !== row.execution_id ||
        latest.execution_state !== 'in_flight'
      )
        invalid();
      const state: ExecutionState =
        result?.status === 'COMPLETED'
          ? 'succeeded'
          : result && ['FAILED', 'CANCELLED'].includes(result.status)
            ? 'failed'
            : 'unknown';
      const sealedResult = result
        ? this.keys.seal(result, this.aad(row) + ':result:' + row.execution_id)
        : row.result_sealed;
      await client.query(
        'UPDATE approvals.requests SET execution_state=$2,result_sealed=$3 WHERE approval_id=$1',
        [id, state, sealedResult],
      );
      await new AuditLog(client).append(
        this.event(
          row,
          data,
          'approval_executed',
          state === 'succeeded' ? 'allow' : 'deny',
          state === 'succeeded',
        ),
      );
      row.execution_state = state;
      row.result_sealed = sealedResult;
      await client.query('COMMIT');
      return this.view(row);
    } catch {
      return invalid();
    } finally {
      if (client) await this.release(client, locked ? id : undefined);
    }
  }
}
