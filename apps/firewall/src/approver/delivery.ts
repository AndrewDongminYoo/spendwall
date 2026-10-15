import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DeviceAuthority } from './identity.ts';
import { FcmFailure } from './fcm.ts';

type Delivery = {
  id: string;
  approval_id: string;
  device_ref: string;
  generation: number;
  attempts: number;
  claim_id: string;
};
type Notifier = { send(token: string, approvalId: string): Promise<void> };
export class ApprovalDelivery {
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
  enqueue = async (
    client: PoolClient,
    event: { approvalId: string; agentId: string; expiresAt: Date },
  ) => {
    await client.query(
      `INSERT INTO approvals.deliveries(approval_id,device_ref,generation,expires_at)
      SELECT $1::uuid,device_ref,generation,$3::timestamptz FROM approvals.devices WHERE owner_ref=$2 AND active
      ON CONFLICT(approval_id,device_ref,generation) DO NOTHING`,
      [event.approvalId, this.devices.ownerRef(event.agentId), event.expiresAt],
    );
  };
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
  private async claim(): Promise<Delivery | undefined> {
    const client = await this.pool.connect();
    let opened = false,
      broken = false;
    try {
      await client.query('BEGIN');
      opened = true;
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query(`WITH expired AS (SELECT id FROM approvals.deliveries WHERE state IN ('ready','sending') AND (expires_at<=clock_timestamp() OR attempts>=100) FOR UPDATE SKIP LOCKED LIMIT 100)
        UPDATE approvals.deliveries SET state='skipped',claim_id=NULL,leased_until=NULL WHERE id IN (SELECT id FROM expired)`);
      const result = await client.query<Delivery>(
        `WITH candidate AS (
        SELECT id FROM approvals.deliveries WHERE expires_at>clock_timestamp() AND attempts<100
          AND ((state='ready' AND next_attempt_at<=clock_timestamp()) OR (state='sending' AND leased_until<=clock_timestamp()))
        ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE approvals.deliveries d SET state='sending',attempts=d.attempts+1,claim_id=$1::uuid,leased_until=clock_timestamp()+interval '30 seconds'
        FROM candidate WHERE d.id=candidate.id RETURNING d.*`,
        [randomUUID()],
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
  private async record(
    row: Delivery,
    state: 'ready' | 'sent' | 'skipped',
    retryAfterSeconds: number,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE approvals.deliveries SET state=$3,claim_id=NULL,leased_until=NULL,
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
        const client = await this.pool.connect();
        let pending = false;
        try {
          pending =
            (
              await client.query(
                `SELECT 1 FROM approvals.requests WHERE approval_id=$1::uuid AND owner_ref=$2 AND approval_state='pending' AND expires_at>clock_timestamp()`,
                [row.approval_id, device?.ownerRef ?? ''],
              )
            ).rows.length === 1;
        } finally {
          client.release();
        }
        if (!device || !pending) next = 'skipped';
        else {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              this.notifier!.send(device.token, row.approval_id),
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
      await this.record(row, next, retryAfterSeconds);
    }
  }
}
