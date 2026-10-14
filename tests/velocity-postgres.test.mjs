import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { AuditLog, verifyAudit } from '../apps/firewall/src/audit/index.ts';
import { prepareEvent } from '../apps/firewall/src/audit/event.ts';
import { VelocityPolicy } from '../apps/firewall/src/velocity/index.ts';
import { loadPolicy } from '../packages/policy/src/index.ts';

const url = process.env.AUDIT_TEST_DATABASE_URL;
const key = '7'.repeat(64);
function policy(
  when = 'agg.refund_usd_24h + amount.usd <= 100',
  then = 'allow',
) {
  return loadPolicy(
    JSON.stringify({
      agents: Object.fromEntries(
        ['support', 'other'].map((id) => [
          id,
          { tools: { allow: ['create_refund'], deny: [] } },
        ]),
      ),
      rules: [{ id: 'limit', when, then }],
      default: 'deny',
    }),
  );
}
function request(changes = {}) {
  return {
    requestId: randomUUID(),
    context: {
      tool: 'create_refund',
      args: { capture_id: 'synthetic-capture' },
      amount: { value: '60.00', currency: 'USD' },
      agent: { id: 'support' },
      customer: { id: 'customerA', email: 'private@example.invalid' },
      merchant: { id: 'merchantA', email: 'merchant@example.invalid' },
      agg: {
        refund_usd_24h: -1_000_000,
        refund_count_1h: -1,
        customer_refund_count_7d: -1,
      },
      ...changes,
    },
    resolvedCtx: {
      capture: { remaining_minor: 10000 },
      email: 'private@example.invalid',
    },
  };
}
const sampleEvent = {
  agentId: 'support',
  tool: 'create_refund',
  args: {},
  resolvedCtx: {},
  decision: 'deny',
  matchedRules: [],
  policyVersion: 'a'.repeat(64),
  eventKind: 'tool_call',
  latencyMs: 0,
};
async function migration(owner, name) {
  await owner.query(
    await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'),
  );
}
async function fixture(t, extension = true) {
  const target = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/spendwall_audit_test');
  const owner = new pg.Pool({ connectionString: url });
  let app, group;
  t.after(async () => {
    await app?.end();
    try {
      if (group) {
        await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(group)}`);
        await owner.query(`DROP ROLE ${pg.escapeIdentifier(group)}`);
      }
    } finally {
      await owner.end();
    }
  });
  await owner.query('DROP SCHEMA IF EXISTS audit CASCADE');
  await migration(owner, '001-audit.sql');
  group = (await owner.query('SELECT audit.app_role() AS name')).rows[0].name;
  await owner.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='audit_test_login') THEN CREATE ROLE audit_test_login LOGIN PASSWORD 'audit-test-only'; END IF; END $$`,
  );
  await owner.query(`GRANT ${pg.escapeIdentifier(group)} TO audit_test_login`);
  if (extension) await migration(owner, '002-velocity.sql');
  target.username = 'audit_test_login';
  target.password = 'audit-test-only';
  app = new pg.Pool({ connectionString: target.toString(), max: 4 });
  return {
    owner,
    app,
    group,
    service: new VelocityPolicy(app, { identityKey: key }),
  };
}
async function race(owner, app, service, loaded, inputs) {
  await service.evaluateAndReserve(policy('false'), request());
  const ref = (
    await owner.query(
      "SELECT resolved_ctx->'velocity'->>'merchant_ref' AS ref FROM audit.audit_events ORDER BY id DESC LIMIT 1",
    )
  ).rows[0].ref;
  const first = await app.connect(),
    second = await app.connect();
  assert.notEqual(
    (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
    (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
  );
  first.release();
  second.release();
  const blocker = await owner.connect();
  let result,
    waiters = 0,
    finished = false;
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`spendwall/velocity/v1/${ref}`],
    );
    result = Promise.all(
      inputs.map((input) => service.evaluateAndReserve(loaded, input)),
    ).finally(() => {
      finished = true;
    });
    for (let i = 0; i < 100 && !finished; i++) {
      waiters = Number(
        (
          await owner.query(
            "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted",
          )
        ).rows[0].count,
      );
      if (waiters >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  const results = await result;
  assert.ok(
    waiters >= 2,
    'Both real clients must overlap at the merchant lock',
  );
  return results;
}

test('Postgres velocity boundary', { skip: !url }, async (t) => {
  await t.test(
    'incremental metadata migration preserves historical hashes and app restrictions',
    async (t) => {
      const { owner, app } = await fixture(t, false);
      const audit = new AuditLog(app);
      await audit.append(sampleEvent);
      const before = await verifyAudit(app);
      await migration(owner, '002-velocity.sql');
      assert.deepEqual(await verifyAudit(app), before);
      const meta = {
        v: 1,
        key_id: '1'.repeat(64),
        merchant_ref: '2'.repeat(64),
        customer_ref: '3'.repeat(64),
        request_id: randomUUID(),
        binding_hash: '4'.repeat(64),
        usd_cents: 123,
      };
      const receipt = await audit.append({
        ...sampleEvent,
        decision: 'allow',
        velocity: meta,
      });
      const stored = (
        await app.query(
          'SELECT resolved_ctx FROM audit.audit_events WHERE id=$1',
          [receipt.id],
        )
      ).rows[0].resolved_ctx;
      assert.deepEqual(stored, { velocity: meta });
      assert.equal((await verifyAudit(app)).count, 2);
      for (const name of ['redact', 'redact_payment_v1'])
        await assert.rejects(
          app.query(`SELECT audit.${name}('{}'::jsonb, 0)`),
          (e) => e.code === '42501',
        );
      const payload = structuredClone(
        prepareEvent({ ...sampleEvent, velocity: meta }),
      );
      payload.resolved_ctx.velocity.customer_ref = 'private@example.invalid';
      await assert.rejects(
        app.query('SELECT * FROM audit.append_event($1::jsonb)', [
          JSON.stringify(payload),
        ]),
        /Invalid velocity metadata/,
      );
      assert.equal((await verifyAudit(app)).count, 2);
    },
  );
  await t.test(
    'same-agent concurrent refunds cannot collectively exceed the money limit',
    async (t) => {
      const { owner, app, service } = await fixture(t);
      const results = await race(owner, app, service, policy(), [
        request(),
        request(),
      ]);
      assert.deepEqual(results.map((r) => r.decision).sort(), [
        'allow',
        'deny',
      ]);
      assert.equal(
        (
          await app.query(
            "SELECT count(*) FROM audit.audit_events WHERE decision='allow'",
          )
        ).rows[0].count,
        '1',
      );
      assert.equal((await verifyAudit(app)).ok, true);
    },
  );
  await t.test(
    'cross-agent calls serialize at the same customer limit',
    async (t) => {
      const { owner, app, service } = await fixture(t);
      const results = await race(
        owner,
        app,
        service,
        policy('agg.customer_refund_count_7d < 1'),
        [request(), request({ agent: { id: 'other' } })],
      );
      assert.deepEqual(results.map((r) => r.decision).sort(), [
        'allow',
        'deny',
      ]);
    },
  );
  await t.test(
    'concurrent exact retries return one original receipt and changed bindings deny',
    async (t) => {
      const { app, service } = await fixture(t);
      const input = request(),
        loaded = policy();
      const results = await Promise.all([
        service.evaluateAndReserve(loaded, input),
        service.evaluateAndReserve(loaded, structuredClone(input)),
      ]);
      assert.deepEqual(
        results.map((r) => r.decision),
        ['allow', 'allow'],
      );
      assert.deepEqual(results.map((r) => r.replayed).sort(), [false, true]);
      assert.equal(results[0].receipt.id, results[1].receipt.id);
      assert.equal((await verifyAudit(app)).count, 1);
      const reordered = structuredClone(input);
      reordered.context.amount = { currency: 'USD', value: '60.00' };
      reordered.context.agg = {};
      assert.equal(
        (await service.evaluateAndReserve(loaded, reordered)).replayed,
        true,
      );
      const changed = structuredClone(input);
      changed.context.args.capture_id = 'changed-capture';
      assert.equal(
        (await service.evaluateAndReserve(loaded, changed)).decision,
        'deny',
      );
      assert.equal(
        (await service.evaluateAndReserve(policy('true'), input)).decision,
        'deny',
      );
      assert.equal((await verifyAudit(app)).count, 1);
    },
  );
  await t.test(
    'source identifiers round-trip through strict audit references',
    async (t) => {
      for (const [name, agentId, ids] of [
        ['numeric agent', '123', ['limit']],
        ['credential-like agent', 'BearerAgent', ['limit']],
        ['underscore agent', '_support', ['limit']],
        ['spaced rule', 'support', ['refund limit']],
        ['long rule', 'support', ['refund '.repeat(100)]],
        [
          'many matches',
          'support',
          Array.from({ length: 129 }, (_, i) => `rule ${i}`),
        ],
      ]) {
        await t.test(name, async (t) => {
          const { app, service } = await fixture(t);
          const loaded = loadPolicy(
            JSON.stringify({
              agents: {
                [agentId]: { tools: { allow: ['create_refund'], deny: [] } },
              },
              rules: ids.map((id) => ({
                id,
                when: 'agg.refund_count_1h < 1',
                then: 'allow',
              })),
              default: 'deny',
            }),
          );
          const input = request({ agent: { id: agentId } });
          const initial = await service.evaluateAndReserve(loaded, input);
          assert.equal(initial.decision, 'allow');
          assert.deepEqual(initial.matchedRules, ids);
          const retry = await service.evaluateAndReserve(loaded, input);
          assert.equal(retry.replayed, true);
          assert.equal(retry.receipt.id, initial.receipt.id);
          assert.deepEqual(retry.matchedRules, ids);
          assert.equal(
            (
              await service.evaluateAndReserve(
                loaded,
                request({ agent: { id: agentId } }),
              )
            ).decision,
            'deny',
          );
          const stored = (
            await app.query(
              'SELECT agent_id, matched_rules FROM audit.audit_events WHERE id=$1',
              [initial.receipt.id],
            )
          ).rows[0];
          assert.match(stored.agent_id, /^agent:[a-f0-9]{64}$/);
          assert.ok(stored.matched_rules.length <= 128);
          for (const reference of stored.matched_rules)
            assert.match(reference, /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
          assert.equal((await verifyAudit(app)).ok, true);
        });
      }
    },
  );
  await t.test(
    'invalid stored rule references deny before using history',
    async (t) => {
      for (const [name, references, lifecycle] of [
        ['raw rule name', ['limit'], false],
        ['raw agent label', ['rules.v1:0'], false],
        ['duplicate positions', ['rules.v1:0:0'], false],
        ['noncanonical chunks', ['rules.v1:0', 'rules.v1:1'], false],
        ['changed lifecycle references', ['rules.v1:1'], true],
      ]) {
        await t.test(name, async (t) => {
          const { app, service } = await fixture(t);
          const loaded = policy('agg.refund_count_1h < 1', 'require_approval');
          const input = request();
          const first = await service.evaluateAndReserve(loaded, input);
          assert.equal(first.decision, 'require_approval');
          const initial = (
            await app.query('SELECT * FROM audit.audit_events WHERE id=$1', [
              first.receipt.id,
            ])
          ).rows[0];
          await new AuditLog(app).append({
            agentId: name === 'raw agent label' ? 'support' : initial.agent_id,
            tool: 'create_refund',
            args: input.context.args,
            resolvedCtx: input.resolvedCtx,
            matchedRules: references,
            policyVersion: first.policyVersion,
            latencyMs: 0,
            velocity: lifecycle
              ? initial.resolved_ctx.velocity
              : { ...initial.resolved_ctx.velocity, request_id: randomUUID() },
            decision: lifecycle ? 'deny' : 'allow',
            eventKind: lifecycle ? 'approval_decided' : 'tool_call',
            ...(lifecycle ? { approvalId: first.approvalId } : {}),
          });
          const result = await service.evaluateAndReserve(
            policy('true'),
            request(),
          );
          assert.equal(result.decision, 'deny');
          assert.equal(result.reason, 'velocity_unavailable');
          assert.equal((await verifyAudit(app)).count, 2);
        });
      }
    },
  );
  await t.test(
    'pending approval reserves capacity and same request is not counted twice',
    async (t) => {
      const { app, service } = await fixture(t);
      const loaded = policy(
        'agg.refund_usd_24h + amount.usd <= 100',
        'require_approval',
      );
      const input = request();
      const first = await service.evaluateAndReserve(loaded, input);
      assert.equal(first.decision, 'require_approval');
      assert.equal(
        (await service.evaluateAndReserve(loaded, input)).replayed,
        true,
      );
      assert.equal(
        (await service.evaluateAndReserve(loaded, request())).decision,
        'deny',
      );
      const rows = (
        await app.query(
          'SELECT approval_id, resolved_ctx FROM audit.audit_events ORDER BY id',
        )
      ).rows;
      assert.match(rows[0].approval_id, /^[a-f0-9-]{36}$/);
      assert.doesNotMatch(
        JSON.stringify(rows),
        /customerA|merchantA|private@example/,
      );
    },
  );
  await t.test(
    'unscoped historical allowance and changed keys fail closed',
    async (t) => {
      const { app, service } = await fixture(t);
      await new AuditLog(app).append({ ...sampleEvent, decision: 'allow' });
      assert.equal(
        (await service.evaluateAndReserve(policy(), request())).decision,
        'deny',
      );
      assert.equal((await verifyAudit(app)).count, 1);
    },
  );
  await t.test(
    'SQL lifecycle events release or convert one pending contribution',
    async (t) => {
      for (const outcome of ['deny', 'execute']) {
        await t.test(outcome, async (t) => {
          const { app, service } = await fixture(t);
          const loaded = policy(
            `agg.refund_count_1h < ${outcome === 'deny' ? 1 : 2}`,
            'require_approval',
          );
          const input = request();
          const first = await service.evaluateAndReserve(loaded, input);
          assert.equal(first.decision, 'require_approval');
          const initialAudit = (
            await app.query(
              "SELECT agent_id, matched_rules, resolved_ctx -> 'velocity' AS velocity FROM audit.audit_events WHERE id=$1",
              [first.receipt.id],
            )
          ).rows[0];
          const append = (eventKind, decision, extra = {}) =>
            new AuditLog(app).append({
              agentId: initialAudit.agent_id,
              tool: 'create_refund',
              args: input.context.args,
              resolvedCtx: input.resolvedCtx,
              matchedRules: initialAudit.matched_rules,
              policyVersion: first.policyVersion,
              approvalId: first.approvalId,
              latencyMs: 0,
              velocity: initialAudit.velocity,
              eventKind,
              decision,
              ...extra,
            });
          await append('approval_created', 'require_approval');
          await append(
            'approval_decided',
            outcome === 'deny' ? 'deny' : 'allow',
          );
          if (outcome === 'execute')
            await append('approval_executed', 'allow', {
              upstreamStatus: 201,
              upstreamResultRef: randomUUID(),
            });
          assert.equal(
            (await service.evaluateAndReserve(loaded, request())).decision,
            'require_approval',
          );
          if (outcome === 'execute')
            assert.equal(
              (await service.evaluateAndReserve(loaded, request())).decision,
              'deny',
            );
          assert.equal((await verifyAudit(app)).ok, true);
        });
      }
    },
  );
  await t.test(
    'injected clock reads actual stored timestamps and denies future history',
    async (t) => {
      const { app, service } = await fixture(t);
      assert.equal(
        (await service.evaluateAndReserve(policy(), request())).decision,
        'allow',
      );
      const ts = (
        await app.query(
          'SELECT (extract(epoch FROM ts)*1000)::float8 AS ts FROM audit.audit_events',
        )
      ).rows[0].ts;
      const staleClock = new VelocityPolicy(app, {
        identityKey: key,
        clock: () => ts - 1,
      });
      assert.equal(
        (await staleClock.evaluateAndReserve(policy(), request())).decision,
        'deny',
      );
      assert.equal((await verifyAudit(app)).count, 1);
    },
  );
  await t.test(
    'real history budget admits 10000 rows and rejects overflow without appending',
    async (t) => {
      const { owner, app, service } = await fixture(t);
      const loaded = policy('true');
      const seed = await service.evaluateAndReserve(
        loaded,
        request({
          agent: { id: 'other' },
          customer: { id: 'customerB' },
          amount: { value: '0', currency: 'USD' },
        }),
      );
      assert.equal(seed.decision, 'allow');
      const payload = (
        await owner.query(
          'SELECT to_jsonb(e) AS payload FROM audit.audit_events e WHERE id=$1',
          [seed.receipt.id],
        )
      ).rows[0].payload;
      // Opaque synthetic bindings exercise the reader's SQL limit, not HMAC generation.
      // Every seed goes through the real append boundary and remains in the chain.
      await owner.query(
        `SELECT audit.append_event(
      jsonb_set(jsonb_set($1::jsonb,
        '{resolved_ctx,velocity,request_id}', to_jsonb(gen_random_uuid()::text)),
        '{resolved_ctx,velocity,binding_hash}', to_jsonb(encode(sha256(convert_to('history-budget-' || n::text, 'UTF8')), 'hex'))))
      FROM generate_series(1, 9999) AS fixture(n)`,
        [JSON.stringify(payload)],
      );
      assert.equal(
        (await app.query('SELECT count(*) FROM audit.audit_events')).rows[0]
          .count,
        '10000',
      );
      const boundary = await service.evaluateAndReserve(loaded, request());
      assert.equal(boundary.decision, 'allow');
      assert.equal(
        (await app.query('SELECT count(*) FROM audit.audit_events')).rows[0]
          .count,
        '10001',
      );
      const overflow = await service.evaluateAndReserve(loaded, request());
      assert.equal(overflow.decision, 'deny');
      assert.equal(overflow.reason, 'velocity_unavailable');
      assert.equal(
        (await app.query('SELECT count(*) FROM audit.audit_events')).rows[0]
          .count,
        '10001',
      );
      assert.equal((await verifyAudit(app)).count, 10001);
    },
  );
  await t.test('key changes cannot hide committed usage', async (t) => {
    const { app, service } = await fixture(t);
    assert.equal(
      (await service.evaluateAndReserve(policy(), request())).decision,
      'allow',
    );
    const changedKey = new VelocityPolicy(app, { identityKey: '8'.repeat(64) });
    assert.equal(
      (await changedKey.evaluateAndReserve(policy(), request())).decision,
      'deny',
    );
    assert.equal((await verifyAudit(app)).count, 1);
  });
  await t.test(
    'missing migration rolls back an allowance instead of dropping its identity',
    async (t) => {
      const { app, service } = await fixture(t, false);
      assert.equal(
        (await service.evaluateAndReserve(policy(), request())).decision,
        'deny',
      );
      assert.equal((await verifyAudit(app)).count, 0);
    },
  );
  await t.test(
    'append failure denies safely and releases its transaction for a retry',
    async (t) => {
      const { owner, app, group, service } = await fixture(t);
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION audit.append_event(jsonb) FROM ${pg.escapeIdentifier(group)}`,
      );
      const input = request();
      const failed = await service.evaluateAndReserve(policy(), input);
      assert.equal(failed.decision, 'deny');
      assert.doesNotMatch(
        JSON.stringify(failed),
        /private@example|audit-test-only|postgresql:/,
      );
      assert.equal((await verifyAudit(app)).count, 0);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*) FROM pg_stat_activity WHERE usename='audit_test_login' AND state LIKE 'idle in transaction%'",
          )
        ).rows[0].count,
        '0',
      );
      await owner.query(
        `GRANT EXECUTE ON FUNCTION audit.append_event(jsonb) TO ${pg.escapeIdentifier(group)}`,
      );
      assert.equal(
        (await service.evaluateAndReserve(policy(), input)).decision,
        'allow',
      );
    },
  );
});
