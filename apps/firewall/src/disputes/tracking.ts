import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { LoadedPolicy } from '../../../../packages/policy/src/index.ts';
import { ApprovalKeys } from '../approvals/binding.ts';
import type { DeviceAuthority } from '../approver/identity.ts';
import type { ContextResolver } from '../context/index.ts';
import { disputeDeadline, disputeIdentifier } from '../context/dispute.ts';
import { email, fail, identifier, object, snapshot } from '../context/json.ts';
import type { VerifiedDispute } from '../webhooks/paypal.ts';
import { disputeEventTypes } from '../webhooks/paypal.ts';
import { DisputeDeadlineAlerts } from './alerts.ts';
import { DisputePolicy } from './index.ts';
import type { DisputeResult } from './index.ts';

type Database = Pick<Pool | PoolClient, 'query'>;
export type DisputeOutcome =
  | 'unmapped'
  | 'dispute_unavailable'
  | 'not_acceptable'
  | 'policy_denied'
  | 'not_provided'
  | 'scheduled'
  | 'due_soon'
  | 'overdue'
  | 'resolved';
type Ending = 'resolved' | 'overdue' | 'exhausted' | 'expired';
// The deployment's own authenticated customer record for a sale, or undefined.
export type SaleCustomer = (
  sellerTransactionId: string,
) =>
  | Promise<{ id: string; email: string } | undefined>
  | { id: string; email: string }
  | undefined;
type Row = {
  id: string;
  dispute_id: string;
  seller_transaction_id: string;
  event_version: string;
  failures: number;
  failing_since: Date | null;
  first_event_at: Date;
  claim_id: string;
  claimed_at: Date;
};
type Settlement = {
  nextCheckAt?: number;
  failures: number;
  failingSince: number | null;
  outcome?: DisputeOutcome;
  ended: Ending | null;
  alert?: DisputeResult;
};

const minute = 60_000,
  hour = 3_600_000,
  day = 86_400_000;
export const failureBoundMs = 7 * day;
export const trackingBoundMs = 180 * day;
// Server-owned; it enters the review's bindingHash and is never sent to PayPal.
export const reviewNote = 'Spendwall_deadline_review';

// The next check time for an outcome that continues tracking, or undefined
// when the outcome ends tracking.
export function nextCheck(
  outcome: DisputeOutcome,
  now: number,
  options: { dueAt?: string; failures?: number } = {},
): number | undefined {
  const due =
    options.dueAt === undefined
      ? undefined
      : Date.parse(disputeDeadline(options.dueAt));
  switch (outcome) {
    case 'overdue':
    case 'resolved':
      return undefined;
    case 'scheduled':
      if (due === undefined) fail();
      return Math.min(due - day, now + day);
    case 'due_soon':
      if (due === undefined) fail();
      return due;
    case 'not_provided':
    case 'policy_denied':
      return now + day;
    case 'not_acceptable':
      if (due === undefined || now >= due) return now + day;
      if (now < due - day) return Math.min(due - day, now + day);
      return now + hour;
    case 'unmapped':
    case 'dispute_unavailable': {
      const failures = options.failures ?? 1;
      if (!Number.isSafeInteger(failures) || failures < 1) fail();
      return now + Math.min(hour, minute * 2 ** Math.min(failures - 1, 6));
    }
  }
}

// The receiver's store of verified dispute events. An event is a trigger and
// a lookup key; the database trigger inserts or advances the tracked row.
export class DisputeEvents {
  readonly #keys: ApprovalKeys;
  readonly merchantRef: string;
  private readonly adapterRef: string;
  constructor(options: {
    identityKey: string;
    merchantId: string;
    adapterRef: string;
  }) {
    try {
      if (!/^[a-f0-9]{64}$/.test(options.adapterRef)) fail();
      this.#keys = new ApprovalKeys(options.identityKey);
      // The same reference DeviceAuthority.merchantRef() derives.
      this.merchantRef = this.#keys.reference(
        'merchant',
        identifier(options.merchantId),
      );
    } catch {
      throw new Error('Invalid dispute event configuration.');
    }
    this.adapterRef = options.adapterRef;
  }
  async receive(db: Database, event: VerifiedDispute): Promise<void> {
    if (
      event?.kind !== 'dispute' ||
      !(disputeEventTypes as readonly string[]).includes(event.eventType)
    )
      throw new Error('Invalid dispute observation.');
    const values = [
      this.adapterRef,
      this.merchantRef,
      this.#keys.reference('dispute-event', identifier(event.eventId, 1, 255)),
      this.#keys.reference('dispute-payload', snapshot(event.payload)),
      event.eventType,
      disputeIdentifier(event.disputeId),
      disputeIdentifier(event.sellerTransactionId),
    ];
    const inserted = await db.query(
      `INSERT INTO disputes.events (adapter_ref,merchant_ref,event_ref,payload_hash,event_type,dispute_id,seller_transaction_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING event_ref`,
      values,
    );
    if (inserted.rowCount === 1) return;
    const { rows } = await db.query<{ matches: boolean }>(
      `SELECT payload_hash=$4 AND event_type=$5 AND dispute_id=$6 AND seller_transaction_id=$7 AS matches
      FROM disputes.events WHERE adapter_ref=$1 AND merchant_ref=$2 AND event_ref=$3`,
      values,
    );
    if (rows[0]?.matches !== true)
      throw new Error('Conflicting webhook event.');
  }
}

// Re-evaluates tracked disputes of one merchant and passes each due_soon or
// overdue review to the alert outbox. It never accepts a claim, follows a
// provider link or changes a policy decision.
export class DisputeTracker {
  private closing = false;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly pool: Pick<Pool, 'connect'>;
  private readonly merchantRef: string;
  private readonly resolver: ContextResolver;
  private readonly disputes: DisputePolicy;
  private readonly alerts: Pick<DisputeDeadlineAlerts, 'record'>;
  private readonly policy: LoadedPolicy;
  private readonly agentId: string;
  private readonly saleCustomer: SaleCustomer;
  // A test clock. Without one, the tracker follows the database clock that
  // the event trigger uses: each claim returns it, and evaluation runs on
  // the local clock shifted by the difference.
  private readonly clock: (() => number) | undefined;
  private offset = 0;
  constructor(options: {
    pool: Pick<Pool, 'connect'>;
    devices: DeviceAuthority;
    resolver: ContextResolver;
    policy: LoadedPolicy;
    agentId: string;
    saleCustomer: SaleCustomer;
    now?: () => number;
    alerts?: Pick<DisputeDeadlineAlerts, 'record'>;
  }) {
    try {
      if (
        typeof options.saleCustomer !== 'function' ||
        typeof options.policy?.policyVersion !== 'string' ||
        !options.devices.servesMerchant(
          identifier(options.resolver.merchant.id),
        )
      )
        fail();
      this.agentId = identifier(options.agentId);
      this.merchantRef = options.devices.merchantRef();
    } catch {
      throw new Error('Invalid dispute tracker configuration.');
    }
    this.pool = options.pool;
    this.resolver = options.resolver;
    this.policy = options.policy;
    this.saleCustomer = options.saleCustomer;
    this.clock = options.now;
    this.disputes = new DisputePolicy({
      resolver: options.resolver,
      now: () => this.time(),
    });
    this.alerts =
      options.alerts ??
      new DisputeDeadlineAlerts(options.pool, options.devices);
  }
  // One tick per instance every 60 seconds.
  start() {
    if (this.closing || this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, 60_000);
  }
  tick() {
    if (this.closing) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }
  private time() {
    const value = this.clock
      ? this.clock()
      : Math.round(Date.now() + this.offset);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Invalid tracker clock.');
    return value;
  }
  // At most ten rows per tick, each evaluated at most once; a row that an
  // event made stale is read again on the next tick. An evaluation or
  // settlement that throws is a failed evaluation of that row only.
  private async run() {
    const seen: string[] = [];
    for (let index = 0; index < 10 && !this.closing; index++) {
      const row = await this.claim(seen);
      if (!row) return;
      seen.push(row.id);
      try {
        await this.evaluate(row);
      } catch {
        try {
          await this.settle(row, this.failure(row, 'dispute_unavailable'));
        } catch {
          // The claim lease expires and a later tick reads the row again.
        }
      }
    }
  }
  // The due check and the lease use one instant: the test clock, or the
  // database clock as the alert outbox does.
  private async claim(seen: string[]): Promise<Row | undefined> {
    const now = this.clock ? new Date(this.time()).toISOString() : null;
    const client = await this.pool.connect();
    try {
      const result = await client.query<Row>(
        `WITH clock AS (SELECT COALESCE($2::timestamptz,statement_timestamp()) AS instant),
        due AS (SELECT id FROM disputes.tracked WHERE merchant_ref=$1 AND ended IS NULL
          AND next_check_at<=(SELECT instant FROM clock) AND (claim_id IS NULL OR leased_until<=(SELECT instant FROM clock)) AND id<>ALL($4::uuid[])
          ORDER BY next_check_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE disputes.tracked t SET claim_id=$3::uuid,leased_until=(SELECT instant FROM clock)+interval '30 seconds'
        FROM due WHERE t.id=due.id
        RETURNING t.id,t.dispute_id,t.seller_transaction_id,t.event_version::text,t.failures,t.failing_since,t.first_event_at,t.claim_id,
          (SELECT instant FROM clock) AS claimed_at`,
        [this.merchantRef, now, randomUUID(), seen],
      );
      const row = result.rows[0];
      if (row && !this.clock)
        this.offset = row.claimed_at.getTime() - Date.now();
      return row;
    } finally {
      client.release();
    }
  }
  private failure(
    row: Row,
    outcome: 'unmapped' | 'dispute_unavailable',
  ): Settlement {
    const now = this.time();
    const failures = row.failures + 1;
    const since = row.failing_since?.getTime();
    return {
      nextCheckAt: nextCheck(outcome, now, { failures })!,
      failures,
      failingSince: since ?? now,
      outcome,
      ended:
        since !== undefined && now - since >= failureBoundMs
          ? 'exhausted'
          : null,
    };
  }
  private async customer(row: Row) {
    try {
      const value = object(
        snapshot(await this.saleCustomer(row.seller_transaction_id)),
      );
      if (Object.keys(value).length !== 2) fail();
      return {
        id: identifier(value.id),
        email: email(value.email),
        seller_transaction_id: row.seller_transaction_id,
      };
    } catch {
      return undefined;
    }
  }
  private async evaluate(row: Row) {
    const now = this.time();
    const success = (
      outcome: DisputeOutcome,
      dueAt?: string,
      alert?: DisputeResult,
    ): Settlement => {
      const next = nextCheck(
        outcome,
        now,
        dueAt === undefined ? {} : { dueAt },
      );
      return {
        ...(next === undefined ? {} : { nextCheckAt: next }),
        failures: 0,
        failingSince: null,
        outcome,
        ended:
          outcome === 'overdue'
            ? 'overdue'
            : outcome === 'resolved'
              ? 'resolved'
              : null,
        ...(alert ? { alert } : {}),
      };
    };
    const failure = (outcome: 'unmapped' | 'dispute_unavailable') =>
      this.failure(row, outcome);
    // Expiry can only suppress alerts, so it spends no provider read.
    if (now >= row.first_event_at.getTime() + trackingBoundMs)
      return this.settle(row, {
        failures: row.failures,
        failingSince: row.failing_since?.getTime() ?? null,
        ended: 'expired',
      });
    const customer = await this.customer(row);
    if (!customer) return this.settle(row, failure('unmapped'));
    const trusted = { agent: { id: this.agentId }, customer, agg: {} };
    const disputeId = row.dispute_id;
    this.resolver.invalidateDispute(disputeId);
    const read = await this.resolver.resolve(
      { tool: 'get_dispute', args: { dispute_id: disputeId } },
      trusted,
    );
    if (!read.ok) return this.settle(row, failure('dispute_unavailable'));
    const facts = object(read.resolvedCtx.dispute);
    if (facts.status === 'RESOLVED')
      return this.settle(row, success('resolved'));
    if (facts.can_accept !== true) {
      const due = facts.seller_response_due_date;
      return this.settle(
        row,
        success(
          'not_acceptable',
          typeof due === 'string' ? disputeDeadline(due) : undefined,
        ),
      );
    }
    const result = await this.disputes.evaluate(
      this.policy,
      {
        tool: 'accept_dispute_claim',
        args: { dispute_id: disputeId, note: reviewNote },
      },
      trusted,
    );
    if (!result.review)
      return this.settle(
        row,
        result.reason === 'policy_denied'
          ? success('policy_denied')
          : failure('dispute_unavailable'),
      );
    const { status, dueAt } = result.review.deadline;
    return this.settle(
      row,
      success(
        status,
        dueAt,
        status === 'due_soon' || status === 'overdue' ? result : undefined,
      ),
    );
  }
  // One transaction bound to the claim and the event version it observed. An
  // event stored after the claim makes the read stale: no alert, no schedule.
  private async settle(row: Row, write: Settlement) {
    const client = await this.pool.connect();
    let opened = false,
      broken = false;
    try {
      await client.query('BEGIN');
      opened = true;
      await client.query("SET LOCAL statement_timeout='5s'");
      const locked = await client.query(
        'SELECT id FROM disputes.tracked WHERE id=$1 AND claim_id=$2::uuid AND event_version=$3::bigint AND ended IS NULL FOR UPDATE',
        [row.id, row.claim_id, row.event_version],
      );
      if (locked.rowCount !== 1) {
        await client.query(
          'UPDATE disputes.tracked SET claim_id=NULL,leased_until=NULL WHERE id=$1 AND claim_id=$2::uuid AND ended IS NULL',
          [row.id, row.claim_id],
        );
      } else {
        if (write.alert)
          await this.alerts.record(write.alert, this.agentId, client);
        await client.query(
          `UPDATE disputes.tracked SET next_check_at=COALESCE($4::timestamptz,next_check_at),failures=$5,
          failing_since=$6::timestamptz,last_outcome=COALESCE($7,last_outcome),ended=$8,claim_id=NULL,leased_until=NULL
          WHERE id=$1 AND claim_id=$2::uuid AND event_version=$3::bigint`,
          [
            row.id,
            row.claim_id,
            row.event_version,
            write.nextCheckAt === undefined
              ? null
              : new Date(write.nextCheckAt).toISOString(),
            write.failures,
            write.failingSince === null
              ? null
              : new Date(write.failingSince).toISOString(),
            write.outcome ?? null,
            write.ended,
          ],
        );
      }
      await client.query('COMMIT');
      opened = false;
    } finally {
      if (opened)
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
      client.release(broken);
    }
  }
}
