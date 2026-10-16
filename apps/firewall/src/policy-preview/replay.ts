import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  evaluatePolicy,
  loadPolicy,
} from '../../../../packages/policy/src/index.ts';
import type { LoadedPolicy } from '../../../../packages/policy/src/index.ts';
import type { AuditReceipt } from '../audit/index.ts';
import { parseVelocityMetadata } from '../audit/velocity.ts';
import { object, snapshot } from '../context/json.ts';

const week = 7 * 86400000;
type Scope = { merchantRef: string; keyId: string };
type ReplayRow = {
  id: string;
  row_hash: string;
  ts_ms: number;
  decision: string;
  policy_version: string;
  resolved_ctx: { velocity?: unknown };
  payload: Buffer | null;
  expires_ms: number | null;
  merchant_ref: string | null;
};
function aad(row: { id: string; row_hash: string }, merchant: string) {
  return Buffer.from(
    JSON.stringify([
      'spendwall/policy-replay',
      1,
      row.id,
      row.row_hash,
      merchant,
    ]),
  );
}
export class PolicyReplay {
  readonly #key: Buffer;
  constructor(key: string) {
    if (!/^[a-f0-9]{64}$/i.test(key))
      throw new Error('Invalid replay configuration.');
    this.#key = Buffer.from(key, 'hex');
  }
  assertIndependent(value: string) {
    if (this.#key.equals(Buffer.from(value, 'hex')))
      throw new Error('Replay key must be independent.');
  }
  async record(
    client: PoolClient,
    receipt: AuditReceipt,
    context: unknown,
    policy: LoadedPolicy,
  ) {
    const row = (
      await client.query<{ resolved_ctx: { velocity: unknown } }>(
        'SELECT resolved_ctx FROM audit.audit_events WHERE id=$1::bigint AND row_hash=$2',
        [receipt.id, receipt.row_hash],
      )
    ).rows[0];
    if (!row) throw new Error('Replay unavailable.');
    const metadata = parseVelocityMetadata(row.resolved_ctx.velocity);
    const original = {
      agents: policy.agents,
      rules: policy.rules.map(({ id, when, then }) => ({ id, when, then })),
      default: policy.default,
    };
    if (
      loadPolicy(JSON.stringify(original)).policyVersion !==
      policy.policyVersion
    )
      throw new Error('Replay unavailable.');
    const body = Buffer.from(
      JSON.stringify({ v: 1, context: snapshot(context), policy: original }),
    );
    if (body.length > 262116) throw new Error('Replay unavailable.');
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(aad(receipt, metadata.merchant_ref));
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    await client.query('SELECT policy_replay.purge_expired()');
    await client.query(
      'INSERT INTO policy_replay.snapshots(event_id,merchant_ref,payload) VALUES($1,$2,$3)',
      [
        receipt.id,
        metadata.merchant_ref,
        Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
      ],
    );
  }
  async purge(pool: Pick<Pool, 'connect'>) {
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT policy_replay.purge_expired()');
      await client.query('COMMIT');
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      client.release(discard);
    }
  }
  async preview(
    pool: Pick<Pool, 'connect'>,
    scope: Scope,
    candidate: LoadedPolicy,
  ) {
    if (
      ![scope.merchantRef, scope.keyId].every((v) => /^[a-f0-9]{64}$/.test(v))
    )
      throw new Error('Replay unavailable.');
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const now = Number(
        (
          await client.query(
            'SELECT (extract(epoch FROM clock_timestamp())*1000)::float8 AS now',
          )
        ).rows[0].now,
      );
      // Reject unknown identity history before merchant filtering: a rotated HMAC key
      // cannot safely map old merchant references into the current scope.
      const continuity = await client.query(
        `SELECT 1 FROM audit.audit_events WHERE event_kind='tool_call' AND ts > to_timestamp($1::double precision/1000) AND ((resolved_ctx->'velocity'->>'key_id') IS DISTINCT FROM $2 OR COALESCE(resolved_ctx->'velocity'->>'merchant_ref','') !~ '^[a-f0-9]{64}$') LIMIT 1`,
        [now - week, scope.keyId],
      );
      if (continuity.rows.length) throw new Error();
      const budget = (
        await client.query<{ count: number; bytes: number }>(
          `SELECT count(*)::int AS count,COALESCE(sum(octet_length(s.payload)),0)::float8 AS bytes FROM audit.audit_events e LEFT JOIN policy_replay.snapshots s ON s.event_id=e.id WHERE e.event_kind='tool_call' AND e.ts > to_timestamp($1::double precision/1000) AND e.resolved_ctx->'velocity'->>'merchant_ref'=$2`,
          [now - week, scope.merchantRef],
        )
      ).rows[0];
      if (!budget || budget.count > 10000 || budget.bytes > 8 * 1024 * 1024)
        throw new Error();
      const { rows } = await client.query<ReplayRow>(
        `SELECT e.id::text,e.row_hash,(extract(epoch FROM e.ts)*1000)::float8 AS ts_ms,e.decision,e.policy_version,e.resolved_ctx,s.payload,(extract(epoch FROM s.expires_at)*1000)::float8 AS expires_ms,s.merchant_ref FROM audit.audit_events e LEFT JOIN policy_replay.snapshots s ON s.event_id=e.id WHERE e.event_kind='tool_call' AND e.ts > to_timestamp($1::double precision/1000) AND e.resolved_ctx->'velocity'->>'merchant_ref'=$2 ORDER BY e.id LIMIT 10001`,
        [now - week, scope.merchantRef],
      );
      if (rows.length > 10000) throw new Error();
      const result = {
        as_of: new Date(now).toISOString(),
        total: 0,
        replayed: 0,
        changed: 0,
        unchanged: 0,
        unavailable: 0,
        coverage: 'complete' as 'complete' | 'partial',
        semantics: 'Recorded inputs and aggregates; no payment simulation.',
      };
      for (const row of rows) {
        const metadata = parseVelocityMetadata(row.resolved_ctx.velocity);
        if (metadata.key_id !== scope.keyId || row.ts_ms > now)
          throw new Error();
        if (metadata.merchant_ref !== scope.merchantRef) continue;
        result.total++;
        try {
          if (
            !row.payload ||
            row.expires_ms === null ||
            row.expires_ms <= now ||
            row.merchant_ref !== scope.merchantRef
          )
            throw new Error();
          const bytes = row.payload;
          if (bytes.length < 29 || bytes.length > 262144) throw new Error();
          const cipher = createDecipheriv(
            'aes-256-gcm',
            this.#key,
            bytes.subarray(0, 12),
          );
          cipher.setAAD(aad(row, scope.merchantRef));
          cipher.setAuthTag(bytes.subarray(12, 28));
          const value = object(
            JSON.parse(
              Buffer.concat([
                cipher.update(bytes.subarray(28)),
                cipher.final(),
              ]).toString('utf8'),
            ),
          );
          const context = snapshot(value.context);
          if (value.v !== 1 || Object.keys(value).length !== 3)
            throw new Error();
          const original = loadPolicy(JSON.stringify(value.policy));
          if (
            original.policyVersion !== row.policy_version ||
            evaluatePolicy(original, context).decision !== row.decision
          )
            throw new Error();
          const next = evaluatePolicy(candidate, context).decision;
          result.replayed++;
          if (next === row.decision) result.unchanged++;
          else result.changed++;
        } catch {
          result.unavailable++;
        }
      }
      if (result.unavailable) result.coverage = 'partial';
      return result;
    } catch {
      throw new Error('Replay unavailable.');
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      client.release(discard);
    }
  }
}
