import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  dashboardFixture,
  policy,
  request,
  token,
  key,
} from './helpers/dashboard-fixture.mjs';
import { verifyAudit } from '../apps/firewall/src/audit/index.ts';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';
import { auditPrompts } from '../apps/firewall/src/dashboard/query-contract.ts';

const url = process.env.AUDIT_TEST_DATABASE_URL;
test('Postgres dashboard read boundary', { skip: !url }, async (t) => {
  const fixture = await dashboardFixture(url, undefined, {
    classify: async (question) => ({
      intent:
        auditPrompts.find((p) => p.prompt === question)?.intent ??
        'unsupported',
    }),
    queryMode: 'synthetic',
  });
  t.after(() => fixture.close());
  const get = (path, headers = { authorization: `Bearer ${token}` }) =>
    fetch(fixture.server.url + path, { headers });
  await t.test('empty tracked history returns an empty snapshot', async () => {
    const response = await get('/stats');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).confirmed_usd, 0);
  });
  const pending = await fixture.addPending();
  const paid = await fixture.addPending('25.00', 'returns');
  assert.equal((await fixture.approve(paid)).execution_state, 'succeeded');
  await fixture.velocity.evaluateAndReserve(policy('allow'), request('12.00'));
  await fixture.velocity.evaluateAndReserve(policy('deny'), request('95.00'));
  await fixture.velocity.evaluateAndReserve(
    policy('allow'),
    request('999.00', 'support', 'foreign-merchant'),
  );
  await t.test(
    'all audit intents read merchant-bound data repeatedly without creating payments or audit events',
    async () => {
      const before = (
        await fixture.owner.query(
          'SELECT count(*)::int AS n FROM audit.audit_events',
        )
      ).rows[0].n;
      for (let repeat = 0; repeat < 3; repeat++) {
        const answers = [];
        for (const prompt of auditPrompts) {
          const response = await fetch(fixture.server.url + '/query', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ question: prompt.prompt }),
          });
          assert.equal(response.status, 200);
          answers.push(await response.json());
        }
        assert.deepEqual(answers[0].rows, []); // The only >100 attempt belongs to another merchant.
        assert.equal(answers[1].rows[0].count, 1);
        assert.equal(answers[2].rows.at(-1).reserved_usd, 72);
        assert.equal(answers[2].rows.at(-1).utilization, 0.36);
        assert.ok(!JSON.stringify(answers).includes('private-customer'));
      }
      assert.equal(
        (
          await fixture.owner.query(
            'SELECT count(*)::int AS n FROM audit.audit_events',
          )
        ).rows[0].n,
        before,
      );
      assert.equal(fixture.executions, 1);
    },
  );
  await t.test(
    'identity continuity precedes merchant filtering on every read',
    async () => {
      for (const identityKey of [key, '6'.repeat(64)]) {
        const server = await startDashboardServer({
          pool: fixture.app,
          identityKey,
          merchantId: 'merchant-without-history',
          token,
          classify: async () => ({ intent: 'weekly_refunds' }),
        });
        try {
          for (const endpoint of ['/stats', '/audit', '/query']) {
            const response = await fetch(server.url + endpoint, {
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
              },
              ...(endpoint === '/query'
                ? {
                    method: 'POST',
                    body: JSON.stringify({ question: auditPrompts[0].prompt }),
                  }
                : {}),
            });
            assert.equal(response.status, identityKey === key ? 200 : 503);
            const body = await response.json();
            if (identityKey !== key)
              assert.deepEqual(body, { error: 'Dashboard data unavailable.' });
            else if (endpoint === '/stats') assert.equal(body.confirmed_usd, 0);
            else
              assert.deepEqual(
                endpoint === '/query' ? body.rows : body.items,
                [],
              );
          }
        } finally {
          await server.close();
        }
      }
    },
  );
  await t.test(
    'HTTP stats and audit agree with actual lifecycle and exclude foreign scope',
    async () => {
      const before = (
        await fixture.owner.query(
          'SELECT count(*)::int AS n FROM audit.audit_events',
        )
      ).rows[0].n;
      const stats = await (await get('/stats')).json(),
        audit = await (await get('/audit')).json();
      assert.equal(stats.confirmed_usd, 25);
      assert.equal(stats.pending.length, 1);
      assert.equal(stats.pending[0].approval_id, pending.id);
      assert.deepEqual(
        stats.decisions.map((r) => r.count),
        [1, 2, 1],
      );
      assert.equal(audit.items.length, 4);
      assert.equal(
        stats.agents.find((r) => r.agent === 'Support bot').reserved_usd,
        72,
      );
      assert.equal(stats.rules[0].count, 1);
      for (const secret of [
        'private-customer',
        'private@example.invalid',
        'request_sealed',
        'binding_hash',
        'customer_ref',
        'merchant_ref',
        'args_hash',
        'CAPTURE12345678901',
        'foreign-merchant',
      ])
        assert.ok(!JSON.stringify({ stats, audit }).includes(secret), secret);
      assert.equal(
        (
          await fixture.owner.query(
            'SELECT count(*)::int AS n FROM audit.audit_events',
          )
        ).rows[0].n,
        before,
      );
      assert.equal(fixture.executions, 1);
      assert.equal((await verifyAudit(fixture.app)).ok, true);
    },
  );
  await t.test(
    'mismatched stored execution identity makes confirmed money unavailable',
    async () => {
      const original = (
        await fixture.owner.query(
          'SELECT execution_id FROM approvals.requests WHERE approval_id=$1',
          [paid.id],
        )
      ).rows[0].execution_id;
      // Only the disposable database owner can manufacture this corrupt state.
      await fixture.owner.query(
        'ALTER TABLE approvals.requests DISABLE TRIGGER immutable_approval',
      );
      try {
        await fixture.owner.query(
          'UPDATE approvals.requests SET execution_id=$2 WHERE approval_id=$1',
          [paid.id, randomUUID()],
        );
        const response = await get('/stats');
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          error: 'Dashboard data unavailable.',
        });
      } finally {
        try {
          await fixture.owner.query(
            'UPDATE approvals.requests SET execution_id=$2 WHERE approval_id=$1',
            [paid.id, original],
          );
        } finally {
          await fixture.owner.query(
            'ALTER TABLE approvals.requests ENABLE TRIGGER immutable_approval',
          );
        }
      }
    },
  );
  await t.test(
    'missing/wrong credentials and foreign origin never disclose audit data',
    async () => {
      assert.equal((await get('/stats', {})).status, 401);
      assert.equal(
        (await get('/audit', { authorization: `Bearer ${'9'.repeat(64)}` }))
          .status,
        401,
      );
      assert.equal(
        (
          await get('/stats', {
            authorization: `Bearer ${token}`,
            origin: 'https://foreign.invalid',
          })
        ).status,
        403,
      );
      assert.equal((await get('/stats?merchant=foreign')).status, 400);
      assert.equal(
        (
          await fetch(fixture.server.url + '/stats', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
        405,
      );
    },
  );
  await t.test('processed approvals disappear after refresh', async () => {
    await fixture.service.deny(pending.id, 'support');
    assert.equal((await (await get('/stats')).json()).pending.length, 0);
  });
  await t.test(
    'missing schema returns unavailable without SQL details or misleading empty data',
    async () => {
      await fixture.owner.query(
        'ALTER TABLE audit.audit_events RENAME TO hidden_events',
      );
      try {
        const response = await get('/stats');
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          error: 'Dashboard data unavailable.',
        });
      } finally {
        await fixture.owner.query(
          'ALTER TABLE audit.hidden_events RENAME TO audit_events',
        );
      }
    },
  );
});
