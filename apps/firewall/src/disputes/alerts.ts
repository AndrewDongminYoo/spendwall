import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DeviceAuthority } from '../approver/identity.ts';
import { FcmFailure } from '../approver/fcm.ts';
import type { DisputeAlertStage } from '../approver/fcm.ts';
import { disputeDeadline, disputeIdentifier } from '../context/dispute.ts';
import { fail, identifier, object } from '../context/json.ts';
import type { DisputeResult } from './index.ts';

type Alert = {
  id: string;
  dispute_id: string;
  stage: DisputeAlertStage;
  owner_ref: string;
  device_ref: string;
  generation: number;
  attempts: number;
  claim_id: string;
};
type Notifier = {
  sendDisputeDeadline(
    token: string,
    disputeId: string,
    stage: DisputeAlertStage,
  ): Promise<void>;
};

// A durable push outbox for review-time deadline stages. It never changes a
// dispute decision, creates an approval record or contacts PayPal.
export class DisputeDeadlineAlerts {
  private closing = false;
  private readonly pool: Pick<Pool, 'connect'>;
  private readonly devices: DeviceAuthority;
  private readonly notifier: Notifier | undefined;
  private running: Promise<void> | undefined;
  constructor(
    pool: Pick<Pool, 'connect'>,
    devices: DeviceAuthority,
    notifier?: Notifier,
  ) {
    this.pool = pool;
    this.devices = devices;
    this.notifier = notifier;
  }
  // Records one alert per active device of the reviewing agent's owner and
  // returns the number of new rows. A repeated stage is a no-op.
  async record(result: DisputeResult, agentId: string): Promise<number> {
    const review = result?.decision === 'require_approval' && result.review;
    if (!review) return 0;
    const stage = review.deadline.status;
    if (stage !== 'due_soon' && stage !== 'overdue') return 0;
    const agent = identifier(agentId);
    if (object(review.context.agent).id !== agent) fail();
    const disputeId = disputeIdentifier(
      object(review.resolvedCtx.dispute).dispute_id,
    );
    const dueAt = disputeDeadline(review.deadline.dueAt);
    if (!/^[a-f0-9]{64}$/.test(review.bindingHash)) fail();
    const client = await this.pool.connect();
    try {
      const inserted = await client.query(
        `INSERT INTO approvals.dispute_alerts(merchant_ref,dispute_id,stage,due_at,binding_hash,owner_ref,device_ref,generation)
        SELECT $1,$2,$3,$4::timestamptz,$5,owner_ref,device_ref,generation FROM approvals.devices WHERE owner_ref=$6 AND active
        ON CONFLICT(merchant_ref,dispute_id,stage,device_ref,generation) DO NOTHING`,
        [
          this.devices.merchantRef(),
          disputeId,
          stage,
          dueAt,
          review.bindingHash,
          this.devices.ownerRef(agent),
        ],
      );
      return inserted.rowCount ?? 0;
    } finally {
      client.release();
    }
  }
  drain() {
    if (this.closing || !this.notifier) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  async close() {
    this.closing = true;
    await this.running;
  }
  private async claim(): Promise<Alert | undefined> {
    const client = await this.pool.connect();
    let opened = false,
      broken = false;
    try {
      await client.query('BEGIN');
      opened = true;
      await client.query("SET LOCAL statement_timeout='5s'");
      const merchant = this.devices.merchantRef();
      await client.query(
        `WITH expired AS (SELECT id FROM approvals.dispute_alerts WHERE merchant_ref=$1 AND state IN ('ready','sending') AND (expires_at<=clock_timestamp() OR attempts>=100) FOR UPDATE SKIP LOCKED LIMIT 100)
        UPDATE approvals.dispute_alerts SET state='skipped',claim_id=NULL,leased_until=NULL WHERE id IN (SELECT id FROM expired)`,
        [merchant],
      );
      const result = await client.query<Alert>(
        `WITH candidate AS (
        SELECT id FROM approvals.dispute_alerts WHERE merchant_ref=$2 AND expires_at>clock_timestamp() AND attempts<100
          AND ((state='ready' AND next_attempt_at<=clock_timestamp()) OR (state='sending' AND leased_until<=clock_timestamp()))
        ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE approvals.dispute_alerts a SET state='sending',attempts=a.attempts+1,claim_id=$1::uuid,leased_until=clock_timestamp()+interval '30 seconds'
        FROM candidate WHERE a.id=candidate.id RETURNING a.*`,
        [randomUUID(), merchant],
      );
      await client.query('COMMIT');
      opened = false;
      return result.rows[0];
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
  private async settle(
    row: Alert,
    state: 'ready' | 'sent' | 'skipped',
    retryAfterSeconds: number,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE approvals.dispute_alerts SET state=$3,claim_id=NULL,leased_until=NULL,
      next_attempt_at=clock_timestamp()+($4::double precision*interval '1 second') WHERE id=$1::uuid AND claim_id=$2::uuid AND state='sending'`,
        [
          row.id,
          row.claim_id,
          state,
          Math.max(
            retryAfterSeconds,
            Math.min(60, 2 ** Math.min(row.attempts, 6)),
          ),
        ],
      );
    } finally {
      client.release();
    }
  }
  private async run() {
    for (let index = 0; index < 10 && !this.closing; index++) {
      const row = await this.claim();
      if (!row) return;
      let next: 'ready' | 'sent' | 'skipped' = 'ready';
      let retryAfterSeconds = 0;
      try {
        const device = await this.devices.deliveryDevice(
          row.device_ref,
          row.generation,
        );
        if (!device || device.ownerRef !== row.owner_ref) next = 'skipped';
        else {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              this.notifier!.sendDisputeDeadline(
                device.token,
                row.dispute_id,
                row.stage,
              ),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new FcmFailure()), 10000);
              }),
            ]);
          } finally {
            if (timeout) clearTimeout(timeout);
          }
          next = 'sent';
        }
      } catch (error) {
        if (error instanceof FcmFailure) {
          if (!error.retryable) next = 'skipped';
          retryAfterSeconds = error.retryAfterSeconds;
        }
      }
      await this.settle(row, next, retryAfterSeconds);
    }
  }
}
