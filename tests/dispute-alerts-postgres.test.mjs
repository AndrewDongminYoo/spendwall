import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadPolicy } from '../packages/policy/src/index.ts';
import { DisputePolicy } from '../apps/firewall/src/disputes/index.ts';
import { DisputeDeadlineAlerts } from '../apps/firewall/src/disputes/alerts.ts';
import { DeviceAuthority } from '../apps/firewall/src/approver/identity.ts';
import { FcmSender } from '../apps/firewall/src/approver/fcm.ts';
import {
  accept,
  disputeId,
  fixture as disputeFixture,
  trusted,
} from './helpers/dispute-fixture.mjs';

const url = process.env.AUDIT_TEST_DATABASE_URL;
const key = '7'.repeat(64),
  signingKey = '8'.repeat(64);
const credential = (n) => Buffer.alloc(32, n).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const deadline = Date.parse('2026-10-17T12:00:00Z');
const unregistered = {
  error: {
    status: 'NOT_FOUND',
    details: [
      {
        '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
        errorCode: 'UNREGISTERED',
      },
    ],
  },
};
function policy(decision = 'allow') {
  return loadPolicy(`agents:
  support:
    tools:
      allow: [accept_dispute_claim]
      deny: []
rules:
  - id: acceptance
    when: tool == "accept_dispute_claim"
    then: ${decision}
default: deny
`);
}

async function fixture(t) {
  const target = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/spendwall_audit_test');
  const owner = new pg.Pool({ connectionString: url });
  await owner.query('DROP SCHEMA IF EXISTS approvals CASCADE');
  await owner.query('DROP SCHEMA IF EXISTS audit CASCADE');
  for (const file of [
    '001-audit.sql',
    '002-velocity.sql',
    '003-approvals.sql',
    '011-approval-guards.sql',
    '004-approval-api.sql',
    '012-dispute-deadline-alerts.sql',
  ])
    await owner.query(
      await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'),
    );
  const group = (await owner.query('SELECT audit.app_role() AS name')).rows[0]
    .name;
  await owner.query(
    "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='dispute_alert_test_login') THEN CREATE ROLE dispute_alert_test_login LOGIN PASSWORD 'alert-test-only'; END IF; END $$",
  );
  await owner.query(
    `GRANT ${pg.escapeIdentifier(group)} TO dispute_alert_test_login`,
  );
  target.username = 'dispute_alert_test_login';
  target.password = 'alert-test-only';
  const pool = new pg.Pool({
    connectionString: target.toString(),
    max: 8,
    connectionTimeoutMillis: 2000,
  });
  const grants = [
    {
      deviceId: 'deviceA',
      agentId: 'support',
      enrollmentHash: hash(credential(1)),
    },
    {
      deviceId: 'deviceC',
      agentId: 'support',
      enrollmentHash: hash(credential(3)),
    },
    {
      deviceId: 'deviceB',
      agentId: 'other-agent',
      enrollmentHash: hash(credential(2)),
    },
    {
      deviceId: 'deviceA',
      agentId: 'support',
      enrollmentHash: hash(credential(4)),
    },
  ];
  let active = grants.slice(0, 3);
  const devices = new DeviceAuthority(pool, {
    identityKey: key,
    signingKey,
    merchantId: 'MERCHANT12345',
    devices: () => active,
  });
  const notifications = [];
  let respond = () =>
    Response.json({ name: 'projects/synthetic-project/messages/one' });
  let beforePush = async () => {};
  const sender = new FcmSender({
    projectId: 'synthetic-project',
    getAccessToken: async () => 'synthetic-google-token',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      notifications.push(body.message);
      const queued = (
        await pool.query(
          "SELECT count(*) FROM approvals.dispute_alerts WHERE state='sending'",
        )
      ).rows[0].count;
      assert.notEqual(queued, '0');
      await beforePush(notifications.length);
      return respond();
    },
  });
  const workers = [];
  const worker = (notifier = sender, authority = devices) => {
    const alerts = new DisputeDeadlineAlerts(pool, authority, notifier);
    workers.push(alerts);
    return alerts;
  };
  const dispute = disputeFixture();
  const service = new DisputePolicy({
    resolver: dispute.resolver,
    now: dispute.now,
  });
  t.after(async () => {
    for (const alerts of workers) await alerts.close();
    await pool.end();
    await owner.query('DROP SCHEMA IF EXISTS approvals CASCADE');
    await owner.query('DROP SCHEMA IF EXISTS audit CASCADE');
    await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(group)}`);
    await owner.query(`DROP ROLE ${pg.escapeIdentifier(group)}`);
    await owner.end();
  });
  await devices.enroll('deviceA', 'synthetic-token-A', credential(1));
  await devices.enroll('deviceC', 'synthetic-token-C', credential(3));
  await devices.enroll('deviceB', 'synthetic-token-B', credential(2));
  return {
    owner,
    pool,
    group,
    devices,
    notifications,
    worker,
    otherMerchant: (granted = []) =>
      new DeviceAuthority(pool, {
        identityKey: key,
        signingKey,
        merchantId: 'merchantB',
        devices: () => granted,
      }),
    review: async (at = deadline - 86_400_000, decision = 'allow') => {
      dispute.setClock(at);
      dispute.resolver.invalidateDispute(disputeId);
      return service.evaluate(policy(decision), accept(), trusted);
    },
    dispute,
    rows: async () =>
      (
        await owner.query(
          'SELECT a.*,d.owner_ref AS device_owner FROM approvals.dispute_alerts a JOIN approvals.devices d USING(device_ref) ORDER BY stage,device_ref',
        )
      ).rows,
    respond: (fn) => {
      respond = fn;
    },
    beforePush: (fn) => {
      beforePush = fn;
    },
    enrollAgainA: async () => {
      active = [grants[3], grants[1], grants[2]];
      await devices.enroll('deviceA', 'synthetic-token-A2', credential(4));
    },
  };
}

test('dispute deadline alerts in PostgreSQL', { skip: !url }, async (t) => {
  await t.test(
    'records one alert per stage and active owner device, once',
    async (t) => {
      const f = await fixture(t);
      const soon = await f.review();
      assert.equal(soon.review.deadline.status, 'due_soon');
      const alerts = f.worker();
      assert.equal(await alerts.record(soon, 'support'), 2);
      assert.equal(await alerts.record(soon, 'support'), 0);
      assert.equal(await alerts.record(await f.review(), 'support'), 0);
      let rows = await f.rows();
      assert.equal(rows.length, 2);
      const owner = f.devices.ownerRef('support');
      for (const row of rows) {
        assert.equal(row.stage, 'due_soon');
        assert.equal(row.dispute_id, disputeId);
        assert.equal(row.merchant_ref, f.devices.merchantRef());
        assert.equal(row.owner_ref, owner);
        assert.equal(row.device_owner, owner);
        assert.equal(row.due_at.toISOString(), '2026-10-17T12:00:00.000Z');
        assert.equal(row.binding_hash, soon.review.bindingHash);
        assert.equal(row.state, 'ready');
        assert.equal(row.attempts, 0);
        assert.equal(
          row.expires_at.getTime() - row.created_at.getTime(),
          72 * 3_600_000,
        );
      }
      assert.deepEqual(
        new Set(rows.map((row) => row.device_ref)),
        new Set([
          f.devices.deviceRef('deviceA'),
          f.devices.deviceRef('deviceC'),
        ]),
      );
      const overdue = await f.review(deadline + 1000);
      assert.equal(overdue.review.deadline.status, 'overdue');
      assert.equal(await alerts.record(overdue, 'support'), 2);
      assert.equal(await alerts.record(overdue, 'support'), 0);
      rows = await f.rows();
      assert.deepEqual(
        rows.map((row) => row.stage),
        ['due_soon', 'due_soon', 'overdue', 'overdue'],
      );
      assert.equal(
        (await f.owner.query('SELECT count(*) FROM approvals.requests')).rows[0]
          .count,
        '0',
      );
      assert.equal(
        (await f.owner.query('SELECT count(*) FROM audit.audit_events')).rows[0]
          .count,
        '0',
      );
      assert.equal(f.notifications.length, 0);
    },
  );
  await t.test(
    'deny, scheduled, missing deadlines and inactive devices record nothing',
    async (t) => {
      const f = await fixture(t);
      const alerts = f.worker();
      const denied = await f.review(undefined, 'deny');
      assert.equal(denied.decision, 'deny');
      assert.equal(await alerts.record(denied, 'support'), 0);
      const scheduled = await f.review(deadline - 2 * 86_400_000);
      assert.equal(scheduled.review.deadline.status, 'scheduled');
      assert.equal(await alerts.record(scheduled, 'support'), 0);
      delete f.dispute.record.seller_response_due_date;
      const missing = await f.review();
      assert.equal(missing.review.deadline.status, 'not_provided');
      assert.equal(await alerts.record(missing, 'support'), 0);
      assert.equal(
        await alerts.record(
          { decision: 'require_approval', dispatchAllowed: false },
          'support',
        ),
        0,
      );
      f.dispute.record.seller_response_due_date = '2026-10-17T12:00:00Z';
      const soon = await f.review();
      await assert.rejects(alerts.record(soon, 'other-agent'));
      await f.owner.query('UPDATE approvals.devices SET active=false');
      assert.equal(await alerts.record(soon, 'support'), 0);
      assert.equal((await f.rows()).length, 0);
    },
  );
  await t.test(
    'concurrent drains send each alert once with only the dispute ID and stage',
    async (t) => {
      const f = await fixture(t);
      const first = f.worker();
      assert.equal(await first.record(await f.review(), 'support'), 2);
      assert.equal(
        await first.record(
          await f.review(deadline + 30 * 86_400_000),
          'support',
        ),
        2,
      );
      f.beforePush(() => new Promise((resolve) => setTimeout(resolve, 20)));
      await Promise.all([
        first.drain(),
        f.worker().drain(),
        f.worker().drain(),
      ]);
      assert.equal(f.notifications.length, 4);
      const seen = f.notifications.map((message) => {
        assert.deepEqual(Object.keys(message).sort(), [
          'data',
          'notification',
          'token',
        ]);
        assert.deepEqual(Object.keys(message.data).sort(), [
          'dispute_id',
          'stage',
        ]);
        assert.equal(message.data.dispute_id, disputeId);
        return `${message.token}:${message.data.stage}`;
      });
      assert.deepEqual(seen.sort(), [
        'synthetic-token-A:due_soon',
        'synthetic-token-A:overdue',
        'synthetic-token-C:due_soon',
        'synthetic-token-C:overdue',
      ]);
      for (const row of await f.rows()) {
        assert.equal(row.state, 'sent');
        assert.equal(row.attempts, 1);
        assert.equal(row.claim_id, null);
      }
      await first.drain();
      assert.equal(f.notifications.length, 4);
    },
  );
  await t.test(
    'a retryable failure backs off and honors Retry-After',
    async (t) => {
      const f = await fixture(t);
      const alerts = f.worker();
      await alerts.record(await f.review(), 'support');
      await f.pool.query(
        "UPDATE approvals.dispute_alerts SET state='skipped' WHERE device_ref=$1",
        [f.devices.deviceRef('deviceC')],
      );
      f.respond(() =>
        Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 }),
      );
      await alerts.drain();
      assert.equal(f.notifications.length, 1);
      let row = (
        await f.pool.query(
          "SELECT state,attempts,next_attempt_at>clock_timestamp()+interval '1 second' AS delayed FROM approvals.dispute_alerts WHERE state<>'skipped'",
        )
      ).rows[0];
      assert.deepEqual(row, { state: 'ready', attempts: 1, delayed: true });
      await alerts.drain();
      assert.equal(f.notifications.length, 1);
      await f.pool.query(
        "UPDATE approvals.dispute_alerts SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE state='ready'",
      );
      f.respond(() =>
        Response.json(
          { error: { status: 'UNAVAILABLE' } },
          { status: 503, headers: { 'retry-after': '120' } },
        ),
      );
      await alerts.drain();
      row = (
        await f.pool.query(
          "SELECT state,attempts,next_attempt_at>=clock_timestamp()+interval '119 seconds' AS delayed FROM approvals.dispute_alerts WHERE state<>'skipped'",
        )
      ).rows[0];
      assert.deepEqual(row, { state: 'ready', attempts: 2, delayed: true });
      await f.pool.query(
        "UPDATE approvals.dispute_alerts SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE state='ready'",
      );
      f.respond(() =>
        Response.json({ name: 'projects/synthetic-project/messages/one' }),
      );
      await alerts.drain();
      row = (
        await f.pool.query(
          'SELECT state,attempts FROM approvals.dispute_alerts WHERE device_ref=$1',
          [f.devices.deviceRef('deviceA')],
        )
      ).rows[0];
      assert.deepEqual(row, { state: 'sent', attempts: 3 });
      assert.equal(f.notifications.length, 3);
    },
  );
  await t.test(
    'unregistered tokens, revoked devices and changed generations are skipped',
    async (t) => {
      const f = await fixture(t);
      const alerts = f.worker();
      await alerts.record(await f.review(), 'support');
      f.respond(() => Response.json(unregistered, { status: 404 }));
      await f.pool.query(
        'UPDATE approvals.devices SET active=false WHERE device_ref=$1',
        [f.devices.deviceRef('deviceC')],
      );
      await alerts.drain();
      assert.deepEqual(
        f.notifications.map((message) => message.token),
        ['synthetic-token-A'],
      );
      for (const row of await f.rows()) assert.equal(row.state, 'skipped');
      f.respond(() =>
        Response.json({ name: 'projects/synthetic-project/messages/one' }),
      );
      await alerts.record(await f.review(deadline), 'support');
      await f.enrollAgainA();
      await alerts.drain();
      assert.equal(f.notifications.length, 1);
      for (const row of await f.rows()) assert.equal(row.state, 'skipped');
    },
  );
  await t.test(
    'attempt and age bounds end undeliverable alerts without a send',
    async (t) => {
      const f = await fixture(t);
      const alerts = f.worker();
      await alerts.record(await f.review(), 'support');
      await f.pool.query(
        'UPDATE approvals.dispute_alerts SET attempts=100 WHERE device_ref=$1',
        [f.devices.deviceRef('deviceA')],
      );
      await f.owner.query(
        'ALTER TABLE approvals.dispute_alerts DISABLE TRIGGER USER',
      );
      await f.owner.query(
        "UPDATE approvals.dispute_alerts SET created_at=created_at-interval '73 hours',expires_at=expires_at-interval '73 hours' WHERE device_ref=$1",
        [f.devices.deviceRef('deviceC')],
      );
      await f.owner.query(
        'ALTER TABLE approvals.dispute_alerts ENABLE TRIGGER USER',
      );
      await alerts.drain();
      assert.equal(f.notifications.length, 0);
      for (const row of await f.rows()) assert.equal(row.state, 'skipped');
      await assert.rejects(
        f.pool.query('UPDATE approvals.dispute_alerts SET attempts=101'),
      );
    },
  );
  for (const bound of ['attempt', 'age'])
    await t.test(
      `a concurrent drain ends a sending alert at its ${bound} bound only after the lease`,
      async (t) => {
        const f = await fixture(t);
        const alerts = f.worker();
        await alerts.record(await f.review(), 'support');
        const deviceA = f.devices.deviceRef('deviceA');
        const deviceC = f.devices.deviceRef('deviceC');
        // deviceC: an abandoned final attempt whose lease has elapsed.
        await f.pool.query(
          `UPDATE approvals.dispute_alerts SET state='sending',attempts=100,claim_id=gen_random_uuid(),
          leased_until=clock_timestamp()-interval '1 second' WHERE device_ref=$1`,
          [deviceC],
        );
        if (bound === 'attempt')
          await f.pool.query(
            'UPDATE approvals.dispute_alerts SET attempts=99 WHERE device_ref=$1',
            [deviceA],
          );
        let during;
        f.beforePush(async () => {
          if (bound === 'age') {
            await f.owner.query(
              'ALTER TABLE approvals.dispute_alerts DISABLE TRIGGER USER',
            );
            await f.owner.query(
              "UPDATE approvals.dispute_alerts SET created_at=created_at-interval '73 hours',expires_at=expires_at-interval '73 hours' WHERE device_ref=$1",
              [deviceA],
            );
            await f.owner.query(
              'ALTER TABLE approvals.dispute_alerts ENABLE TRIGGER USER',
            );
          }
          await f.worker().drain();
          during = (
            await f.pool.query(
              'SELECT state FROM approvals.dispute_alerts WHERE device_ref=$1',
              [deviceA],
            )
          ).rows[0].state;
        });
        await alerts.drain();
        assert.equal(during, 'sending');
        assert.deepEqual(
          f.notifications.map((message) => message.token),
          ['synthetic-token-A'],
        );
        const states = (
          await f.pool.query(
            'SELECT device_ref,state,attempts,claim_id FROM approvals.dispute_alerts',
          )
        ).rows;
        assert.deepEqual(
          states.find((row) => row.device_ref === deviceA),
          {
            device_ref: deviceA,
            state: 'sent',
            attempts: bound === 'attempt' ? 100 : 1,
            claim_id: null,
          },
        );
        assert.deepEqual(
          states.find((row) => row.device_ref === deviceC),
          {
            device_ref: deviceC,
            state: 'skipped',
            attempts: 100,
            claim_id: null,
          },
        );
      },
    );
  await t.test(
    "a review is recorded only for its own merchant's devices",
    async (t) => {
      const f = await fixture(t);
      const devices = f.otherMerchant([
        {
          deviceId: 'deviceD',
          agentId: 'support',
          enrollmentHash: hash(credential(5)),
        },
      ]);
      await devices.enroll('deviceD', 'synthetic-token-D', credential(5));
      const soon = await f.review();
      assert.equal(soon.review.context.merchant.id, 'MERCHANT12345');
      await assert.rejects(
        f.worker(undefined, devices).record(soon, 'support'),
      );
      assert.equal(
        (await f.owner.query('SELECT count(*) FROM approvals.dispute_alerts'))
          .rows[0].count,
        '0',
      );
      assert.equal(await f.worker().record(soon, 'support'), 2);
    },
  );
  await t.test(
    "a drain claims and expires only its own merchant's alerts",
    async (t) => {
      const f = await fixture(t);
      await f.worker().record(await f.review(), 'support');
      const other = f.worker(undefined, f.otherMerchant());
      const untouched = async () => {
        const rows = await f.rows();
        assert.equal(rows.length, 2);
        for (const row of rows) {
          assert.equal(row.state, 'ready');
          assert.equal(row.attempts, 0);
          assert.equal(row.claim_id, null);
        }
      };
      await other.drain();
      assert.equal(f.notifications.length, 0);
      await untouched();
      await f.owner.query(
        'ALTER TABLE approvals.dispute_alerts DISABLE TRIGGER USER',
      );
      await f.owner.query(
        "UPDATE approvals.dispute_alerts SET created_at=created_at-interval '73 hours',expires_at=expires_at-interval '73 hours'",
      );
      await f.owner.query(
        'ALTER TABLE approvals.dispute_alerts ENABLE TRIGGER USER',
      );
      await other.drain();
      await untouched();
      await f.worker().drain();
      assert.equal(f.notifications.length, 0);
      for (const row of await f.rows()) assert.equal(row.state, 'skipped');
    },
  );
  await t.test(
    'the application role cannot delete alerts or rewrite their identity',
    async (t) => {
      const f = await fixture(t);
      const alerts = f.worker();
      await alerts.record(await f.review(), 'support');
      await assert.rejects(
        f.pool.query('DELETE FROM approvals.dispute_alerts'),
        /permission denied/,
      );
      await assert.rejects(
        f.pool.query('TRUNCATE approvals.dispute_alerts'),
        /permission denied/,
      );
      // Identity columns are not granted to the application role, and the
      // trigger refuses the same rewrites from the owner.
      for (const assignment of [
        "dispute_id='PP-D-OTHER'",
        "stage='overdue'",
        "due_at=due_at+interval '1 day'",
        "binding_hash=repeat('0',64)",
        "owner_ref=repeat('0',64)",
        'generation=generation+1',
        "merchant_ref=repeat('0',64)",
        "expires_at=expires_at+interval '1 day'",
        "created_at=created_at+interval '1 second'",
        'id=gen_random_uuid()',
      ]) {
        await assert.rejects(
          f.pool.query(`UPDATE approvals.dispute_alerts SET ${assignment}`),
          /permission denied/,
          assignment,
        );
        await assert.rejects(
          f.owner.query(`UPDATE approvals.dispute_alerts SET ${assignment}`),
          /Invalid dispute alert transition/,
          assignment,
        );
      }
      await f.pool.query("UPDATE approvals.dispute_alerts SET state='sent'");
      await assert.rejects(
        f.pool.query("UPDATE approvals.dispute_alerts SET state='ready'"),
        /Invalid dispute alert transition/,
      );
      const [row] = await f.rows();
      await assert.rejects(
        f.pool.query(
          `INSERT INTO approvals.dispute_alerts(merchant_ref,dispute_id,stage,due_at,binding_hash,owner_ref,device_ref,generation,created_at,expires_at,state)
          SELECT merchant_ref,'PP-D-NEW',stage,due_at,binding_hash,owner_ref,device_ref,generation,clock_timestamp(),clock_timestamp()+interval '72 hours','sent'
          FROM approvals.dispute_alerts WHERE id=$1`,
          [row.id],
        ),
        /Invalid dispute alert/,
      );
      await assert.rejects(
        f.pool.query(
          `INSERT INTO approvals.dispute_alerts(merchant_ref,dispute_id,stage,due_at,binding_hash,owner_ref,device_ref,generation,created_at,expires_at)
          SELECT merchant_ref,'PP-D-NEW',stage,due_at,binding_hash,repeat('0',64),device_ref,generation,clock_timestamp(),clock_timestamp()+interval '72 hours'
          FROM approvals.dispute_alerts WHERE id=$1`,
          [row.id],
        ),
        /Invalid dispute alert/,
      );
      const privileges = (
        await f.owner.query(
          `SELECT has_table_privilege($1,'approvals.dispute_alerts','DELETE') AS del,
            has_table_privilege($1,'approvals.dispute_alerts','TRUNCATE') AS trunc,
            has_table_privilege($1,'approvals.dispute_alerts','INSERT') AS ins,
            has_table_privilege($1,'approvals.dispute_alerts','UPDATE') AS table_update,
            (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute
              WHERE attrelid='approvals.dispute_alerts'::regclass AND attnum>0 AND NOT attisdropped
              AND has_column_privilege($1,attrelid,attnum,'UPDATE')) AS updatable,
            (SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='approvals' AND table_name='dispute_alerts' AND grantee='PUBLIC') AS public_grants,
            has_function_privilege('public','approvals.guard_dispute_alert()','EXECUTE') AS public_guard`,
          [f.group],
        )
      ).rows[0];
      assert.deepEqual(privileges, {
        del: false,
        trunc: false,
        ins: true,
        table_update: false,
        updatable: [
          'attempts',
          'claim_id',
          'leased_until',
          'next_attempt_at',
          'state',
        ],
        public_grants: '0',
        public_guard: false,
      });
    },
  );
  await t.test('close waits for the running drain', async (t) => {
    const f = await fixture(t);
    const alerts = f.worker();
    await alerts.record(await f.review(), 'support');
    let enter, release;
    const entered = new Promise((resolve) => (enter = resolve)),
      gate = new Promise((resolve) => (release = resolve));
    f.beforePush(async (index) => {
      if (index === 1) {
        enter();
        await gate;
      }
    });
    const drain = alerts.drain();
    await entered;
    let closed = false;
    const closing = alerts.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, false);
    release();
    await closing;
    await drain;
    assert.equal(f.notifications.length, 1);
    await alerts.drain();
    assert.equal(f.notifications.length, 1);
  });
});
