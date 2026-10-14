import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { prepareEvent } from './event.ts';
import type { AuditEvent } from './event.ts';

export type { AuditEvent } from './event.ts';
export type AuditReceipt = { id: string; row_hash: string };

export class AuditLog {
  private readonly db: Pick<Pool | PoolClient, 'query'>;
  constructor(db: Pick<Pool | PoolClient, 'query'>) {
    this.db = db;
  }

  // With a Pool this statement commits before resolving. With a PoolClient,
  // the caller owns commit/rollback and must await commit before acting.
  async append(input: AuditEvent): Promise<AuditReceipt> {
    const payload = prepareEvent(input);
    try {
      const result = await this.db.query<AuditReceipt>(
        'SELECT * FROM audit.append_event($1::jsonb)',
        [JSON.stringify(payload)],
      );
      if (!result.rows[0]) throw new Error();
      return result.rows[0];
    } catch {
      throw new Error('Audit append failed.');
    }
  }
}

export type Verification =
  | { ok: true; count: number; headHash: string }
  | {
      ok: false;
      id: string | null;
      position: number;
      reason: 'row_hash' | 'prev_hash' | 'head';
    };

type VerifiedRow = AuditReceipt & { prev_hash: string; payload: string };

export async function verifyAudit(
  pool: Pick<Pool, 'connect'>,
): Promise<Verification> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: heads } = await client.query<{
      event_id: string | null;
      row_hash: string;
    }>('SELECT event_id::text, row_hash FROM audit.chain_head WHERE singleton');
    let expected = '0'.repeat(64);
    let after = '0';
    let count = 0;
    for (;;) {
      const { rows } = await client.query<VerifiedRow>(
        'SELECT id::text, prev_hash, row_hash, audit.event_payload(e) AS payload FROM audit.audit_events e WHERE e.id > $1::bigint ORDER BY e.id LIMIT 1000',
        [after],
      );
      for (const row of rows) {
        count++;
        const hash = createHash('sha256')
          .update(row.payload, 'utf8')
          .digest('hex');
        if (hash !== row.row_hash)
          return { ok: false, id: row.id, position: count, reason: 'row_hash' };
        if (row.prev_hash !== expected)
          return {
            ok: false,
            id: row.id,
            position: count,
            reason: 'prev_hash',
          };
        expected = hash;
        after = row.id;
      }
      if (rows.length < 1000) break;
    }
    const head = heads[0];
    if (
      !head ||
      head.row_hash !== expected ||
      head.event_id !== (count === 0 ? null : after)
    )
      return {
        ok: false,
        id: head?.event_id ?? (count === 0 ? null : after),
        position: count + 1,
        reason: 'head',
      };
    return { ok: true, count, headHash: expected };
  } catch {
    throw new Error('Audit verification failed.');
  } finally {
    if (client) {
      // Always finish the read snapshot, including early integrity failures.
      try {
        await client.query('ROLLBACK');
      } catch {
        client.release(true);
        client = undefined;
      }
      client?.release();
    }
  }
}
