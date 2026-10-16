import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import {
  dashboardFixture,
  key,
  policy,
  request,
} from './helpers/dashboard-fixture.mjs';
import { VelocityPolicy } from '../apps/firewall/src/velocity/index.ts';
import { PolicyReplay } from '../apps/firewall/src/policy-preview/replay.ts';
import { verifyAudit } from '../apps/firewall/src/audit/index.ts';
import { loadPolicy } from '../packages/policy/src/index.ts';

const url = process.env.AUDIT_TEST_DATABASE_URL;
const replayKey = '9'.repeat(64);
const reference = (domain, value) =>
  createHmac('sha256', Buffer.from(key, 'hex'))
    .update(JSON.stringify(['spendwall/velocity', 1, domain, value]))
    .digest('hex');
const scope = {
  merchantRef: reference('merchant', 'merchantA'),
  keyId: reference('key', 'continuity'),
};
async function fixture(t) {
  const f = await dashboardFixture(url);
  await f.owner.query(
    await readFile(
      new URL('../migrations/006-policy-replay.sql', import.meta.url),
      'utf8',
    ),
  );
  const group = (
    await f.owner.query('SELECT policy_replay.reader_role() AS name')
  ).rows[0].name;
  await f.owner.query(
    "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='replay_test_login') THEN CREATE ROLE replay_test_login LOGIN PASSWORD 'replay-test-only'; END IF; END $$",
  );
  await f.owner.query(
    `GRANT ${pg.escapeIdentifier(group)} TO replay_test_login`,
  );
  const target = new URL(url);
  target.username = 'replay_test_login';
  target.password = 'replay-test-only';
  const reader = new pg.Pool({
    connectionString: target.toString(),
    connectionTimeoutMillis: 2000,
  });
  t.after(async () => {
    await reader.end();
    await f.owner.query('DROP SCHEMA policy_replay CASCADE');
    await f.owner.query(`DROP OWNED BY ${pg.escapeIdentifier(group)}`);
    await f.owner.query(`DROP ROLE ${pg.escapeIdentifier(group)}`);
    await f.close();
  });
  const replay = new PolicyReplay(replayKey);
  return {
    ...f,
    reader,
    replay,
    velocity: new VelocityPolicy(f.app, { identityKey: key, replay }),
  };
}

test('Postgres encrypted policy preview', { skip: !url }, async (t) => {
  await t.test(
    'exact inputs, trusted aggregates, retry deduplication and no preview side effects',
    async (t) => {
      const f = await fixture(t);
      const original = loadPolicy(
        JSON.stringify({
          agents: {
            support: { tools: { allow: ['create_refund'], deny: [] } },
          },
          rules: [
            {
              id: 'limit',
              when: 'agg.refund_usd_24h + amount.usd <= 100 && customer.email == "private@example.invalid"',
              then: 'allow',
            },
          ],
          default: 'deny',
        }),
      );
      const input = request();
      input.context.agg = { refund_usd_24h: -100000 };
      const first = await f.velocity.evaluateAndReserve(original, input);
      assert.equal(first.decision, 'allow');
      assert.equal(
        (await f.velocity.evaluateAndReserve(original, input)).replayed,
        true,
      );
      assert.equal(
        (await f.velocity.evaluateAndReserve(original, request())).decision,
        'deny',
      );
      const rows = (
        await f.owner.query('SELECT payload FROM policy_replay.snapshots')
      ).rows;
      assert.equal(rows.length, 2);
      assert.ok(
        rows.every(
          (r) => !r.payload.includes(Buffer.from('private@example.invalid')),
        ),
      );
      const before = await verifyAudit(f.app);
      const same = await f.replay.preview(f.reader, scope, original);
      assert.deepEqual(
        [
          same.total,
          same.replayed,
          same.changed,
          same.unchanged,
          same.unavailable,
        ],
        [2, 2, 0, 2, 0],
      );
      const changed = await f.replay.preview(
        f.reader,
        scope,
        policy('require_approval'),
      );
      assert.deepEqual([changed.changed, changed.unchanged], [2, 0]);
      assert.equal(changed.coverage, 'complete');
      const aggregateCheck = loadPolicy(
        JSON.stringify({
          agents: {
            support: { tools: { allow: ['create_refund'], deny: [] } },
          },
          rules: [
            { id: 'negative', when: 'agg.refund_usd_24h < 0', then: 'allow' },
          ],
          default: 'deny',
        }),
      );
      const aggregateResult = await f.replay.preview(
        f.reader,
        scope,
        aggregateCheck,
      );
      assert.deepEqual(
        [aggregateResult.changed, aggregateResult.unchanged],
        [1, 1],
        'Replay must use authoritative historical aggregates, not caller hints',
      );
      assert.ok(!JSON.stringify(changed).includes('private@example.invalid'));
      assert.deepEqual(await verifyAudit(f.app), before);
      assert.equal(f.executions, 0);
    },
  );
  await t.test(
    'legacy, deleted, tampered and wrong-key snapshots remain unavailable',
    async (t) => {
      const f = await fixture(t);
      await f.velocity.evaluateAndReserve(policy('allow'), request());
      await new VelocityPolicy(f.app, { identityKey: key }).evaluateAndReserve(
        policy('deny'),
        request(),
      );
      let result = await f.replay.preview(f.reader, scope, policy('deny'));
      assert.deepEqual(
        [result.total, result.replayed, result.changed, result.unavailable],
        [2, 1, 1, 1],
      );
      assert.equal(result.coverage, 'partial');
      assert.equal(
        (
          await new PolicyReplay('a'.repeat(64)).preview(
            f.reader,
            scope,
            policy('deny'),
          )
        ).unavailable,
        2,
      );
      await f.owner.query(
        'UPDATE policy_replay.snapshots SET payload=set_byte(payload,28,get_byte(payload,28)#1)',
      );
      assert.equal(
        (await f.replay.preview(f.reader, scope, policy('deny'))).unavailable,
        2,
      );
      await f.owner.query('DELETE FROM policy_replay.snapshots');
      assert.equal(
        (await f.replay.preview(f.reader, scope, policy('deny'))).replayed,
        0,
      );
    },
  );
  await t.test(
    'merchant, ciphertext row binding and key continuity are enforced',
    async (t) => {
      const f = await fixture(t);
      await f.velocity.evaluateAndReserve(policy('allow'), request());
      await f.velocity.evaluateAndReserve(
        policy('deny'),
        request('60.00', 'support', 'merchantB'),
      );
      const result = await f.replay.preview(f.reader, scope, policy('deny'));
      assert.deepEqual([result.total, result.changed], [1, 1]);
      await f.owner.query(
        'UPDATE policy_replay.snapshots SET payload=(SELECT payload FROM policy_replay.snapshots ORDER BY event_id DESC LIMIT 1)',
      );
      assert.equal(
        (await f.replay.preview(f.reader, scope, policy('deny'))).unavailable,
        1,
      );
      await assert.rejects(
        () =>
          f.replay.preview(
            f.reader,
            { ...scope, keyId: '0'.repeat(64) },
            policy('deny'),
          ),
        /Replay unavailable/,
      );
      assert.throws(
        () =>
          new VelocityPolicy(f.app, {
            identityKey: key,
            replay: new PolicyReplay(key),
          }),
        /independent/,
      );
    },
  );
  await t.test(
    'foreign merchant ciphertext cannot exhaust the scoped budget',
    async (t) => {
      const f = await fixture(t);
      await f.velocity.evaluateAndReserve(policy('allow'), request());
      for (let i = 0; i < 33; i++)
        await f.velocity.evaluateAndReserve(
          policy('deny'),
          request('60.00', 'support', 'merchantB'),
        );
      // Owner-only corruption supplies a realistic ciphertext byte budget without disclosing data.
      await f.owner.query(
        'UPDATE policy_replay.snapshots SET payload=$1 WHERE merchant_ref=$2',
        [Buffer.alloc(262144), reference('merchant', 'merchantB')],
      );
      const result = await f.replay.preview(f.reader, scope, policy('deny'));
      assert.deepEqual(
        [result.total, result.replayed, result.changed],
        [1, 1, 1],
      );
      await assert.rejects(
        () =>
          f.replay.preview(
            f.reader,
            { ...scope, merchantRef: reference('merchant', 'merchantB') },
            policy('deny'),
          ),
        /Replay unavailable/,
      );
    },
  );
  await t.test(
    'expiry cleanup commits bounded batches without touching live records',
    async (t) => {
      const f = await fixture(t);
      for (let i = 0; i < 1002; i++)
        await f.velocity.evaluateAndReserve(policy('deny'), request());
      const before = await verifyAudit(f.app);
      await f.owner.query(
        "UPDATE policy_replay.snapshots SET expires_at=clock_timestamp()-interval '1 day' WHERE event_id <> (SELECT max(event_id) FROM policy_replay.snapshots)",
      );
      await f.replay.purge(f.reader);
      const remaining = () =>
        f.owner
          .query('SELECT count(*)::int AS n FROM policy_replay.snapshots')
          .then((r) => r.rows[0].n);
      assert.equal(
        await remaining(),
        2,
        'One cleanup must commit no more than 1000 expired rows',
      );
      await f.replay.purge(f.reader);
      assert.equal(await remaining(), 1);
      assert.deepEqual(await verifyAudit(f.app), before);
    },
  );
  await t.test(
    'snapshot failure rolls back audit and allowance; old behavior remains opt-in',
    async (t) => {
      const f = await fixture(t);
      const before = await verifyAudit(f.app);
      const group = (await f.owner.query('SELECT audit.app_role() AS name'))
        .rows[0].name;
      await f.owner.query(
        `REVOKE INSERT(event_id,merchant_ref,payload) ON policy_replay.snapshots FROM ${pg.escapeIdentifier(group)}`,
      );
      const result = await f.velocity.evaluateAndReserve(
        policy('allow'),
        request(),
      );
      assert.equal(result.decision, 'deny');
      assert.equal(result.reason, 'velocity_unavailable');
      assert.deepEqual(await verifyAudit(f.app), before);
      assert.equal(
        (
          await new VelocityPolicy(f.app, {
            identityKey: key,
          }).evaluateAndReserve(policy('allow'), request())
        ).decision,
        'allow',
      );
    },
  );
  await t.test(
    'HTTP dry-run uses actual encrypted records and reports legacy coverage',
    async (t) => {
      const f = await fixture(t);
      const { startDashboardServer } =
        await import('../apps/firewall/src/dashboard/server.ts');
      const source = JSON.stringify({
        agents: { support: { tools: { allow: ['create_refund'], deny: [] } } },
        rules: [{ id: 'limit', when: 'true', then: 'allow' }],
        default: 'deny',
      });
      await f.velocity.evaluateAndReserve(loadPolicy(source), request());
      await new VelocityPolicy(f.app, { identityKey: key }).evaluateAndReserve(
        policy('deny'),
        request(),
      );
      const server = await startDashboardServer({
        pool: f.app,
        identityKey: key,
        merchantId: 'merchantA',
        token: '8'.repeat(64),
        policyPreview: {
          pool: f.reader,
          replay: f.replay,
          loadPolicy: async () => source,
        },
      });
      t.after(() => server.close());
      const next = source.replace(
        '"then":"allow"',
        '"then":"require_approval"',
      );
      const before = await verifyAudit(f.app);
      const response = await fetch(server.url + '/policy/dry-run', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'8'.repeat(64)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          baseVersion: loadPolicy(source).policyVersion,
          candidateYaml: next,
          candidateVersion: loadPolicy(next).policyVersion,
        }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(
        [
          result.total,
          result.replayed,
          result.changed,
          result.unchanged,
          result.unavailable,
        ],
        [2, 1, 1, 0, 1],
      );
      assert.deepEqual(await verifyAudit(f.app), before);
    },
  );
  await t.test(
    'seven-day window excludes old calls and future rows fail closed',
    async (t) => {
      const f = await fixture(t);
      await f.velocity.evaluateAndReserve(policy('allow'), request());
      const expiry = (
        await f.owner.query(
          'SELECT extract(epoch FROM (expires_at-clock_timestamp()))::float8 AS seconds FROM policy_replay.snapshots',
        )
      ).rows[0].seconds;
      assert.ok(expiry > 604790 && expiry <= 604800);
      // Trusted fixture owner moves timestamps only to exercise the SQL window.
      await f.owner.query(
        "UPDATE audit.audit_events SET ts=clock_timestamp()-interval '7 days 1 second'",
      );
      assert.equal(
        (await f.replay.preview(f.reader, scope, policy('deny'))).total,
        0,
      );
      await f.owner.query(
        "UPDATE audit.audit_events SET ts=clock_timestamp()+interval '1 day'",
      );
      await assert.rejects(
        () => f.replay.preview(f.reader, scope, policy('deny')),
        /Replay unavailable/,
      );
    },
  );
  await t.test(
    'reader cannot mutate audit or snapshots and can purge only expired payloads',
    async (t) => {
      const f = await fixture(t);
      await f.velocity.evaluateAndReserve(policy('allow'), request());
      await f.velocity.evaluateAndReserve(policy('deny'), request());
      for (const sql of [
        'DELETE FROM policy_replay.snapshots',
        'UPDATE policy_replay.snapshots SET expires_at=now()',
        'DELETE FROM audit.audit_events',
        "UPDATE audit.audit_events SET decision='allow'",
      ])
        await assert.rejects(() => f.reader.query(sql), /permission denied/);
      const before = await verifyAudit(f.app);
      await f.owner.query(
        "UPDATE policy_replay.snapshots SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE event_id=(SELECT min(event_id) FROM policy_replay.snapshots)",
      );
      const result = await f.replay.preview(f.reader, scope, policy('deny'));
      assert.deepEqual(
        [result.total, result.replayed, result.unavailable],
        [2, 1, 1],
      );
      await f.replay.purge(f.reader);
      assert.equal(
        (
          await f.owner.query(
            'SELECT count(*)::int AS n FROM policy_replay.snapshots',
          )
        ).rows[0].n,
        1,
      );
      assert.deepEqual(await verifyAudit(f.app), before);
    },
  );
});
