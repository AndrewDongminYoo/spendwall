import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

// Table references use explicit schemas. This challenge binds separate reader
// credentials to the same live database, including when a database was cloned.
export async function assertReplayDatabase(
  primary: Pick<Pool, 'connect'>,
  replay: Pick<Pool, 'connect'>,
) {
  if (primary === replay) return;
  const clients: PoolClient[] = [];
  try {
    for (const pool of [primary, replay]) {
      const client = await pool.connect();
      clients.push(client);
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
    }
    const nonce = randomBytes(8);
    const key = [nonce.readInt32BE(0), nonce.readInt32BE(4)];
    const query =
      'SELECT pg_catalog.pg_try_advisory_xact_lock($1::int,$2::int) AS acquired';
    if ((await clients[0]!.query(query, key)).rows[0]?.acquired !== true)
      throw new Error();
    if ((await clients[1]!.query(query, key)).rows[0]?.acquired !== false)
      throw new Error();
  } catch {
    throw new Error('Replay database mismatch.');
  } finally {
    for (const client of clients) {
      let discard = false;
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      client.release(discard);
    }
  }
}
