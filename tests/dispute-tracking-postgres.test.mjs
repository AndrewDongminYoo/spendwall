import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadPolicy } from '../packages/policy/src/index.ts';
import { ContextResolver } from '../apps/firewall/src/context/index.ts';
import { DeviceAuthority } from '../apps/firewall/src/approver/identity.ts';
import { DisputeDeadlineAlerts } from '../apps/firewall/src/disputes/alerts.ts';
import {
  DisputeEvents,
  DisputeTracker,
} from '../apps/firewall/src/disputes/tracking.ts';
import { checkWebhookReceiver } from '../apps/firewall/src/webhooks/reconciliation.ts';
import { checkHostedReader } from '../apps/firewall/src/dashboard/hosted-reader.ts';

const url = process.env.AUDIT_TEST_DATABASE_URL;
const key = '7'.repeat(64),
  signingKey = '8'.repeat(64),
  adapterRef = 'a'.repeat(64);
const merchant = { id: 'MERCHANT12345', email: 'merchant@example.invalid' };
const sale = 'SALE12345678901234';
const hour = 3_600_000,
  day = 86_400_000;
const appLogin = 'dispute_track_test_login',
  receiverLogin = 'dispute_track_receiver_login';
const credential = (n) => Buffer.alloc(32, n).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const policy = () =>
  loadPolicy(`agents:
  support:
    tools:
      allow: [accept_dispute_claim]
      deny: []
  other-agent:
    tools:
      allow: []
      deny: [accept_dispute_claim]
rules:
  - id: acceptance
    when: tool == "accept_dispute_claim"
    then: allow
default: deny
`);
function disputeRecord(id, dueAt, options = {}) {
  return {
    dispute_id: id,
    status: options.status ?? 'WAITING_FOR_SELLER_RESPONSE',
    dispute_life_cycle_stage: 'CHARGEBACK',
    dispute_amount: { value: '25.00', currency_code: 'USD' },
    ...(dueAt === undefined ? {} : { seller_response_due_date: iso(dueAt) }),
    disputed_transactions: [
      {
        seller_transaction_id: options.sale ?? sale,
        transaction_status: 'COMPLETED',
        gross_amount: { value: '100.00', currency_code: 'USD' },
        seller: {
          merchant_id: options.merchantId ?? merchant.id,
          email: merchant.email,
        },
      },
    ],
    allowed_response_options: {
      accept_claim: { accept_claim_types: ['REFUND'] },
    },
    links:
      options.acceptable === false
        ? []
        : [
            {
              rel: 'accept-claim',
              method: 'POST',
              href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${id}/accept-claim`,
            },
          ],
  };
}
async function login(owner, name, group, password) {
  await owner.query(
    `CREATE ROLE ${pg.escapeIdentifier(name)} LOGIN PASSWORD '${password}'`,
  );
  await owner.query(
    `GRANT ${pg.escapeIdentifier(group)} TO ${pg.escapeIdentifier(name)}`,
  );
  const target = new URL(url);
  target.username = name;
  target.password = password;
  return target.toString();
}

async function fixture(t) {
  const target = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/spendwall_audit_test');
  const owner = new pg.Pool({ connectionString: url });
  for (const schema of ['disputes', 'reconciliation', 'approvals', 'audit'])
    await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  for (const file of [
    '001-audit.sql',
    '002-velocity.sql',
    '003-approvals.sql',
    '011-approval-guards.sql',
    '004-approval-api.sql',
    '012-dispute-deadline-alerts.sql',
    '007-reconciliation.sql',
    '013-dispute-tracking.sql',
  ])
    await owner.query(
      await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'),
    );
  const group = (await owner.query('SELECT audit.app_role() AS name')).rows[0]
    .name;
  const receiverGroup = (
    await owner.query('SELECT reconciliation.receiver_role() AS name')
  ).rows[0].name;
  const pools = [];
  const open = (connectionString, max = 8) => {
    const pool = new pg.Pool({
      connectionString,
      max,
      connectionTimeoutMillis: 2000,
    });
    pools.push(pool);
    return pool;
  };
  const appUrl = await login(owner, appLogin, group, 'track-test-only');
  const pool = open(appUrl);
  const receiver = open(
    await login(owner, receiverLogin, receiverGroup, 'receiver-test-only'),
  );
  const trackers = [];
  t.after(async () => {
    for (const tracker of trackers) await tracker.close();
    for (const p of pools) await p.end();
    for (const schema of ['disputes', 'reconciliation', 'approvals', 'audit'])
      await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of [appLogin, receiverLogin, receiverGroup, group]) {
      await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(role)}`);
      await owner.query(`DROP ROLE ${pg.escapeIdentifier(role)}`);
    }
    await owner.end();
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
  ];
  const authority = (merchantId = merchant.id, db = pool) =>
    new DeviceAuthority(db, {
      identityKey: key,
      signingKey,
      merchantId,
      devices: () => grants,
    });
  const devices = authority();
  await devices.enroll('deviceA', 'synthetic-token-A', credential(1));
  await devices.enroll('deviceC', 'synthetic-token-C', credential(3));
  await devices.enroll('deviceB', 'synthetic-token-B', credential(2));
  // Ahead of the database clock, so trigger-set check times are already due.
  let clock = Math.ceil(Date.now() / 1000) * 1000 + 10 * 60_000;
  const base = clock;
  const now = () => clock;
  const records = new Map();
  const gets = new Map();
  let onGet = async () => {};
  const resolver = () =>
    new ContextResolver({
      merchant,
      now,
      tokens: {
        get: async () => 'synthetic-dispute-token',
        isSensitive: (v) =>
          JSON.stringify(v).includes('synthetic-dispute-token'),
      },
      fetchImpl: async (input, init) => {
        assert.equal(init.method, 'GET');
        assert.equal(init.body, undefined);
        const id = new URL(String(input)).pathname.split('/').at(-1);
        assert.equal(
          String(input),
          `https://api-m.sandbox.paypal.com/v1/customer/disputes/${id}`,
        );
        gets.set(id, (gets.get(id) ?? 0) + 1);
        const record = records.get(id);
        await onGet(id);
        return record
          ? Response.json(record)
          : Response.json({}, { status: 404 });
      },
    });
  const customers = new Map([
    [sale, { id: 'customer-1', email: 'buyer@example.invalid' }],
  ]);
  const tracker = (options = {}) => {
    const value = new DisputeTracker({
      pool: options.pool ?? pool,
      devices: options.devices ?? devices,
      resolver: options.resolver ?? resolver(),
      policy: policy(),
      agentId: options.agentId ?? 'support',
      saleCustomer: options.saleCustomer ?? (async (id) => customers.get(id)),
      ...(options.databaseClock ? {} : { now }),
      ...(options.alerts ? { alerts: options.alerts } : {}),
    });
    trackers.push(value);
    return value;
  };
  const events = new DisputeEvents({
    identityKey: key,
    merchantId: merchant.id,
    adapterRef,
  });
  let counter = 0;
  const event = (
    disputeId,
    type = 'CUSTOMER.DISPUTE.UPDATED',
    options = {},
  ) => {
    const n = options.n ?? ++counter;
    return {
      kind: 'dispute',
      eventId: `WH-DISPUTE-${n}`,
      eventType: type,
      disputeId,
      sellerTransactionId: options.sale ?? sale,
      payload: { id: `WH-DISPUTE-${n}`, event_type: type, ...options.payload },
    };
  };
  const receive = (disputeId, type, options) =>
    events.receive(receiver, event(disputeId, type, options));
  return {
    owner,
    pool,
    appUrl,
    open,
    receiver,
    receiverGroup,
    devices,
    authority,
    tracker,
    resolver,
    events,
    event,
    receive,
    records,
    customers,
    gets: (id) => gets.get(id) ?? 0,
    onGet: (fn) => {
      onGet = fn;
    },
    base,
    now,
    setClock: (value) => {
      clock = value;
    },
    row: async (id) =>
      (
        await owner.query(
          'SELECT *,event_version::int AS version FROM disputes.tracked WHERE dispute_id=$1',
          [id],
        )
      ).rows[0],
    alerts: async (id) =>
      (
        await owner.query(
          'SELECT stage,device_ref,due_at FROM approvals.dispute_alerts WHERE dispute_id=$1 ORDER BY stage,device_ref',
          [id],
        )
      ).rows,
  };
}

test('dispute tracking in PostgreSQL', { skip: !url }, async (t) => {
  await t.test(
    'receiver grants, the event trigger and the tracked-row guards',
    async (t) => {
      const f = await fixture(t);
      const app = f.pool;
      assert.deepEqual(await checkWebhookReceiver(f.receiver), {
        disputeTracking: true,
      });
      await assert.rejects(checkWebhookReceiver(app), /receiver/i);
      await assert.rejects(checkWebhookReceiver(f.owner), /receiver/i);
      // The receiver has no privilege on tracked rows or EXECUTE on the
      // trigger function, yet a stored event creates the tracked row.
      const first = f.event('PP-D-ONE', 'CUSTOMER.DISPUTE.CREATED');
      await f.events.receive(f.receiver, first);
      await f.events.receive(f.receiver, first);
      let row = await f.row('PP-D-ONE');
      assert.equal(row.version, 1);
      assert.equal(row.ended, null);
      assert.equal(row.seller_transaction_id, sale);
      assert.equal(row.merchant_ref, f.devices.merchantRef());
      assert.equal(row.next_check_at.getTime(), row.first_event_at.getTime());
      await assert.rejects(
        f.events.receive(f.receiver, {
          ...first,
          payload: { ...first.payload, changed: true },
        }),
        /Conflicting/,
      );
      await assert.rejects(
        f.events.receive(f.receiver, {
          ...first,
          eventType: 'CUSTOMER.DISPUTE.RESOLVED',
        }),
        /Conflicting/,
      );
      // A later event never rewrites the stored sale identity.
      await f.receive('PP-D-ONE', 'CUSTOMER.DISPUTE.UPDATED', {
        sale: 'SALE-OTHER-0000001',
      });
      row = await f.row('PP-D-ONE');
      assert.equal(row.version, 2);
      assert.equal(row.seller_transaction_id, sale);
      const stored = await f.owner.query(
        'SELECT * FROM disputes.events ORDER BY received_at',
      );
      assert.equal(stored.rows.length, 2);
      assert.equal(JSON.stringify(stored.rows).includes('WH-DISPUTE'), false);
      for (const sql of [
        'SELECT * FROM disputes.tracked',
        'UPDATE disputes.tracked SET next_check_at=clock_timestamp()',
        'DELETE FROM disputes.events',
        "UPDATE disputes.events SET event_type='CUSTOMER.DISPUTE.RESOLVED'",
        'INSERT INTO disputes.events (received_at) VALUES (clock_timestamp())',
        "INSERT INTO disputes.tracked (merchant_ref) VALUES ('x')",
        'SELECT * FROM approvals.dispute_alerts',
        'TRUNCATE disputes.events',
      ])
        await assert.rejects(f.receiver.query(sql), { code: '42501' }, sql);
      for (const sql of [
        "INSERT INTO disputes.tracked (merchant_ref,dispute_id,seller_transaction_id,first_event_at,last_event_at,event_version,next_check_at) SELECT merchant_ref,'PP-D-FORGED',seller_transaction_id,now(),now(),1,now() FROM disputes.tracked LIMIT 1",
        'DELETE FROM disputes.tracked',
        'TRUNCATE disputes.tracked',
        'SELECT * FROM disputes.events',
        "INSERT INTO disputes.events (event_type) VALUES ('CUSTOMER.DISPUTE.CREATED')",
        'UPDATE disputes.tracked SET event_version=event_version+1',
        "UPDATE disputes.tracked SET dispute_id='PP-D-OTHER'",
        "UPDATE disputes.tracked SET seller_transaction_id='SALE-OTHER-0000001'",
        "UPDATE disputes.tracked SET merchant_ref=repeat('b',64)",
        'UPDATE disputes.tracked SET last_event_at=clock_timestamp()',
      ])
        await assert.rejects(app.query(sql), { code: '42501' }, sql);
      assert.equal(
        (await app.query('SELECT count(*)::int AS n FROM disputes.tracked'))
          .rows[0].n,
        1,
      );
      // Extra receiver privileges are refused, and missing ones too.
      for (const [grant, revoke] of [
        [
          'GRANT SELECT ON disputes.tracked TO %I',
          'REVOKE SELECT ON disputes.tracked FROM %I',
        ],
        [
          'GRANT UPDATE (event_type) ON disputes.events TO %I',
          'REVOKE UPDATE (event_type) ON disputes.events FROM %I',
        ],
        [
          'GRANT INSERT (received_at) ON disputes.events TO %I',
          'REVOKE INSERT (received_at) ON disputes.events FROM %I',
        ],
        [
          'GRANT EXECUTE ON FUNCTION disputes.track_event() TO %I',
          'REVOKE EXECUTE ON FUNCTION disputes.track_event() FROM %I',
        ],
        [
          'REVOKE INSERT (seller_transaction_id) ON disputes.events FROM %I',
          'GRANT INSERT (seller_transaction_id) ON disputes.events TO %I',
        ],
        [
          'REVOKE USAGE ON SCHEMA disputes FROM %I',
          'GRANT USAGE ON SCHEMA disputes TO %I',
        ],
      ]) {
        const name = pg.escapeIdentifier(f.receiverGroup);
        await f.owner.query(grant.replace('%I', name));
        try {
          await assert.rejects(checkWebhookReceiver(f.receiver), /receiver/i);
        } finally {
          await f.owner.query(revoke.replace('%I', name));
        }
        await checkWebhookReceiver(f.receiver);
      }
      // The guards hold even for the owner.
      const update = (set) =>
        f.owner.query(
          `UPDATE disputes.tracked SET ${set} WHERE dispute_id='PP-D-ONE'`,
        );
      for (const set of [
        'event_version=event_version+1',
        'event_version=1',
        "last_event_at=last_event_at+interval '1 second'",
        "dispute_id='PP-D-OTHER'",
        "seller_transaction_id='SALE-OTHER-0000001'",
        "first_event_at=first_event_at-interval '1 day'",
      ])
        await assert.rejects(update(set), /Invalid tracked dispute/, set);
      await update("failures=1,failing_since=now(),last_outcome='unmapped'");
      await update("failures=2,last_outcome='dispute_unavailable'");
      for (const set of [
        'failures=1',
        'failures=0,failing_since=NULL',
        "failing_since=failing_since-interval '1 day'",
        'failing_since=NULL',
      ])
        await assert.rejects(update(set), /Invalid tracked dispute|check/, set);
      await update("failures=0,failing_since=NULL,last_outcome='scheduled'");
      await assert.rejects(update('failures=1'), /check/);
      await update("ended='overdue'");
      for (const set of [
        "ended='resolved'",
        'ended=NULL',
        'next_check_at=now()',
        'claim_id=NULL',
      ])
        await assert.rejects(update(set), /Invalid tracked dispute/, set);
      // An event after the ending is evidence only.
      await f.receive('PP-D-ONE', 'CUSTOMER.DISPUTE.UPDATED');
      assert.equal((await f.row('PP-D-ONE')).version, 2);
      assert.equal(
        (await f.owner.query('SELECT count(*)::int AS n FROM disputes.events'))
          .rows[0].n,
        3,
      );
    },
  );

  await t.test(
    'the hosted dashboard reader refuses any disputes privilege',
    async (t) => {
      const f = await fixture(t);
      await f.owner.query(
        await readFile(
          new URL('../scripts/hosting-reader.sql', import.meta.url),
          'utf8',
        ),
      );
      const reader = 'spendwall_dashboard_reader';
      await f.owner.query(`ALTER ROLE ${reader} PASSWORD 'hosted-test-only'`);
      const target = new URL(url);
      target.username = reader;
      target.password = 'hosted-test-only';
      const pool = new pg.Pool({ connectionString: target.toString() });
      try {
        await checkHostedReader(pool);
        for (const [grant, revoke] of [
          [
            'GRANT SELECT (dispute_id) ON disputes.tracked TO %I',
            'REVOKE SELECT (dispute_id) ON disputes.tracked FROM %I',
          ],
          [
            'GRANT SELECT (event_type) ON disputes.events TO %I',
            'REVOKE SELECT (event_type) ON disputes.events FROM %I',
          ],
          [
            'GRANT EXECUTE ON FUNCTION disputes.track_event() TO %I',
            'REVOKE EXECUTE ON FUNCTION disputes.track_event() FROM %I',
          ],
        ]) {
          await f.owner.query(grant.replace('%I', reader));
          try {
            await assert.rejects(checkHostedReader(pool), /unavailable/, grant);
          } finally {
            await f.owner.query(revoke.replace('%I', reader));
          }
          await checkHostedReader(pool);
        }
      } finally {
        await pool.end();
        await f.owner.query(`DROP OWNED BY ${reader}`);
        await f.owner.query(`DROP ROLE ${reader}`);
      }
    },
  );

  await t.test(
    'deterministic schedule: cap, exact boundaries, due_soon and overdue',
    async (t) => {
      const f = await fixture(t);
      const { base } = f;
      const cap = 'PP-D-CAP',
        edge = 'PP-D-EDGE',
        none = 'PP-D-NONE';
      f.records.set(cap, disputeRecord(cap, base + 3 * day));
      const edgeDue = base + day + 2 * hour;
      f.records.set(edge, disputeRecord(edge, edgeDue));
      f.records.set(none, disputeRecord(none, undefined));
      for (const id of [cap, edge, none])
        await f.receive(id, 'CUSTOMER.DISPUTE.CREATED');
      const tracker = f.tracker();
      await tracker.tick();
      let row = await f.row(cap);
      assert.equal(row.last_outcome, 'scheduled');
      assert.equal(row.next_check_at.getTime(), base + day, '24-hour cap');
      assert.equal(row.claim_id, null);
      assert.equal(row.failures, 0);
      row = await f.row(edge);
      assert.equal(row.last_outcome, 'scheduled');
      assert.equal(row.next_check_at.getTime(), edgeDue - day);
      row = await f.row(none);
      assert.equal(row.last_outcome, 'not_provided');
      assert.equal(row.next_check_at.getTime(), base + day);
      for (const id of [cap, edge, none]) assert.equal(f.gets(id), 1);
      // Nothing is due yet: the timer is a database query, not a provider read.
      await tracker.tick();
      for (const id of [cap, edge, none]) assert.equal(f.gets(id), 1);
      // Exactly dueAt - 24h is due_soon without earlier polling.
      f.setClock(edgeDue - day);
      await tracker.tick();
      assert.equal(f.gets(edge), 2);
      assert.equal(f.gets(cap), 1);
      row = await f.row(edge);
      assert.equal(row.last_outcome, 'due_soon');
      assert.equal(row.next_check_at.getTime(), edgeDue);
      let alerts = await f.alerts(edge);
      assert.deepEqual(
        alerts.map((a) => a.stage),
        ['due_soon', 'due_soon'],
      );
      assert.equal(alerts[0].due_at.getTime(), edgeDue);
      // The cap re-reads a deadline that moved without an event we received.
      f.records.set(cap, disputeRecord(cap, base + day + 12 * hour));
      f.setClock(base + day);
      await tracker.tick();
      assert.equal(f.gets(cap), 2);
      row = await f.row(cap);
      assert.equal(row.last_outcome, 'due_soon');
      assert.equal(row.next_check_at.getTime(), base + day + 12 * hour);
      assert.equal((await f.alerts(cap)).length, 2);
      f.setClock(edgeDue - 1);
      await tracker.tick();
      assert.equal(f.gets(edge), 2);
      // The exact due instant is overdue and ends tracking.
      f.setClock(edgeDue);
      await tracker.tick();
      assert.equal(f.gets(edge), 3);
      row = await f.row(edge);
      assert.equal(row.ended, 'overdue');
      assert.equal(row.last_outcome, 'overdue');
      alerts = await f.alerts(edge);
      assert.deepEqual(
        alerts.map((a) => a.stage),
        ['due_soon', 'due_soon', 'overdue', 'overdue'],
      );
      row = await f.row(none);
      assert.equal(row.next_check_at.getTime(), base + 2 * day);
      assert.equal((await f.alerts(none)).length, 0);
      f.setClock(base + 20 * day);
      await tracker.tick();
      assert.equal(f.gets(edge), 3, 'an ended row is never read again');
    },
  );

  await t.test(
    'the failure bound ends a streak at seven days and a success restarts it',
    async (t) => {
      const f = await fixture(t);
      const { base } = f;
      const lost = 'PP-D-LOST',
        back = 'PP-D-BACK';
      const backSale = 'SALE-BACK-00000001',
        lostSale = 'SALE-LOST-00000001';
      f.records.set(
        lost,
        disputeRecord(lost, base + 30 * day, { sale: lostSale }),
      );
      f.records.set(
        back,
        disputeRecord(back, base + 30 * day, { sale: backSale }),
      );
      await f.receive(lost, 'CUSTOMER.DISPUTE.CREATED', { sale: lostSale });
      await f.receive(back, 'CUSTOMER.DISPUTE.CREATED', { sale: backSale });
      const tracker = f.tracker();
      await tracker.tick();
      for (const id of [lost, back]) {
        const row = await f.row(id);
        assert.equal(row.last_outcome, 'unmapped');
        assert.equal(row.failures, 1);
        assert.equal(row.failing_since.getTime(), base);
        assert.equal(row.next_check_at.getTime(), base + 60_000);
        assert.equal(f.gets(id), 0, 'no resolver call without a mapping');
      }
      f.setClock(base + 3 * day);
      f.customers.set(backSale, {
        id: 'customer-2',
        email: 'two@example.invalid',
      });
      await tracker.tick();
      let row = await f.row(back);
      assert.equal(row.last_outcome, 'scheduled');
      assert.equal(row.failures, 0);
      assert.equal(row.failing_since, null);
      row = await f.row(lost);
      assert.equal(row.failures, 2);
      assert.equal(row.failing_since.getTime(), base);
      assert.equal(row.next_check_at.getTime(), base + 3 * day + 120_000);
      // The third failure is inside the bound and schedules the fourth at it.
      f.setClock(base + 7 * day - 4 * 60_000);
      await tracker.tick();
      row = await f.row(lost);
      assert.equal(row.ended, null);
      assert.equal(row.failures, 3);
      assert.equal(row.next_check_at.getTime(), base + 7 * day);
      f.setClock(base + 7 * day);
      await tracker.tick();
      row = await f.row(lost);
      assert.equal(row.ended, 'exhausted');
      assert.equal(row.failures, 4);
      assert.equal(row.failing_since.getTime(), base);
      // A new streak starts at the first failure after the success.
      f.customers.delete(backSale);
      f.setClock(base + 8 * day);
      await tracker.tick();
      row = await f.row(back);
      assert.equal(row.failures, 1);
      assert.equal(row.failing_since.getTime(), base + 8 * day);
      f.setClock(base + 15 * day - 2 * 60_000);
      await tracker.tick();
      row = await f.row(back);
      assert.equal(row.ended, null);
      assert.equal(row.failures, 2);
      assert.equal(row.next_check_at.getTime(), base + 15 * day);
      f.setClock(base + 15 * day);
      await tracker.tick();
      assert.equal((await f.row(back)).ended, 'exhausted');
      assert.equal(
        (await f.alerts(lost)).length + (await f.alerts(back)).length,
        0,
      );
    },
  );

  await t.test(
    'missing, invalid or mismatched customer mapping records no alert',
    async (t) => {
      const f = await fixture(t);
      const due = f.base + hour;
      const lookups = [
        undefined,
        { id: 'bad id', email: 'buyer@example.invalid' },
        { id: 'customer-1', email: 'not-an-email' },
        { id: 'customer-1', email: 'buyer@example.invalid', extra: true },
        { id: 'customer-1' },
        'customer-1',
      ];
      for (const [index, answer] of lookups.entries()) {
        const id = `PP-D-MAP-${index}`;
        f.records.set(id, disputeRecord(id, due));
        await f.receive(id, 'CUSTOMER.DISPUTE.CREATED');
        await f.tracker({ saleCustomer: async () => answer }).tick();
        const row = await f.row(id);
        assert.equal(row.last_outcome, 'unmapped', `lookup ${index}`);
        assert.equal(f.gets(id), 0);
      }
      const thrown = 'PP-D-MAP-THROWN';
      f.records.set(thrown, disputeRecord(thrown, due));
      await f.receive(thrown, 'CUSTOMER.DISPUTE.CREATED');
      await f
        .tracker({
          saleCustomer: async () => {
            throw new Error('private lookup failure');
          },
        })
        .tick();
      assert.equal((await f.row(thrown)).last_outcome, 'unmapped');
      // The event's sale differs from the provider's transaction.
      const other = 'PP-D-OTHER-SALE';
      f.records.set(other, disputeRecord(other, due));
      f.customers.set('SALE-FORGED-000001', {
        id: 'customer-1',
        email: 'buyer@example.invalid',
      });
      await f.receive(other, 'CUSTOMER.DISPUTE.CREATED', {
        sale: 'SALE-FORGED-000001',
      });
      await f.tracker().tick();
      const row = await f.row(other);
      assert.equal(row.last_outcome, 'dispute_unavailable');
      assert.equal(row.failures, 1);
      assert.equal(f.gets(other), 1);
      assert.equal(
        (
          await f.owner.query(
            'SELECT count(*)::int AS n FROM approvals.dispute_alerts',
          )
        ).rows[0].n,
        0,
      );
    },
  );

  await t.test(
    'a dispute that cannot be accepted is a success and alerts once acceptable',
    async (t) => {
      const f = await fixture(t);
      const { base } = f;
      const id = 'PP-D-WAIT';
      const due = base + 2 * day;
      f.records.set(id, disputeRecord(id, due, { acceptable: false }));
      await f.receive(id, 'CUSTOMER.DISPUTE.CREATED');
      let mapped = false;
      const tracker = f.tracker({
        saleCustomer: async (value) =>
          mapped ? f.customers.get(value) : undefined,
      });
      await tracker.tick();
      assert.equal((await f.row(id)).failures, 1);
      mapped = true;
      f.setClock(base + 60_000);
      await tracker.tick();
      let row = await f.row(id);
      assert.equal(row.last_outcome, 'not_acceptable');
      assert.equal(row.failures, 0);
      assert.equal(row.failing_since, null);
      assert.equal(row.next_check_at.getTime(), due - day);
      assert.equal(f.gets(id), 1);
      f.setClock(due - day);
      await tracker.tick();
      row = await f.row(id);
      assert.equal(row.last_outcome, 'not_acceptable');
      assert.equal(row.next_check_at.getTime(), due - day + hour);
      assert.equal((await f.alerts(id)).length, 0);
      // Once acceptable inside the window, the next check alerts.
      f.records.set(id, disputeRecord(id, due));
      f.setClock(due - day + hour);
      await tracker.tick();
      row = await f.row(id);
      assert.equal(row.last_outcome, 'due_soon');
      assert.equal(row.next_check_at.getTime(), due);
      assert.deepEqual(
        (await f.alerts(id)).map((a) => a.stage),
        ['due_soon', 'due_soon'],
      );
    },
  );

  await t.test(
    'cross-merchant disputes and rows produce no alert',
    async (t) => {
      const f = await fixture(t);
      const foreign = 'PP-D-FOREIGN';
      f.records.set(
        foreign,
        disputeRecord(foreign, f.base + hour, { merchantId: 'merchantB' }),
      );
      await f.receive(foreign, 'CUSTOMER.DISPUTE.CREATED');
      // Another merchant's tracked row is never claimed by this tracker.
      const theirs = 'PP-D-THEIRS';
      f.records.set(theirs, disputeRecord(theirs, f.base + hour));
      const otherEvents = new DisputeEvents({
        identityKey: key,
        merchantId: 'merchantB',
        adapterRef,
      });
      await otherEvents.receive(
        f.receiver,
        f.event(theirs, 'CUSTOMER.DISPUTE.CREATED'),
      );
      await f.tracker().tick();
      const row = await f.row(foreign);
      assert.equal(row.last_outcome, 'dispute_unavailable');
      const other = await f.row(theirs);
      assert.equal(other.merchant_ref, otherEvents.merchantRef);
      assert.equal(other.claim_id, null);
      assert.equal(other.last_outcome, null);
      assert.equal(f.gets(theirs), 0);
      assert.throws(
        () => f.tracker({ devices: f.authority('merchantB') }),
        /configuration/,
      );
      assert.equal(
        (
          await f.owner.query(
            'SELECT count(*)::int AS n FROM approvals.dispute_alerts',
          )
        ).rows[0].n,
        0,
      );
    },
  );

  await t.test(
    'a review agent the policy does not admit is policy_denied',
    async (t) => {
      const f = await fixture(t);
      const id = 'PP-D-DENIED';
      f.records.set(id, disputeRecord(id, f.base + hour));
      await f.receive(id, 'CUSTOMER.DISPUTE.CREATED');
      await f.tracker({ agentId: 'other-agent' }).tick();
      const row = await f.row(id);
      assert.equal(row.last_outcome, 'policy_denied');
      assert.equal(row.failures, 0);
      assert.equal(row.next_check_at.getTime(), f.base + day);
      assert.equal(f.gets(id), 1);
      assert.equal((await f.alerts(id)).length, 0);
    },
  );

  await t.test('resolution and expiry end tracking', async (t) => {
    const f = await fixture(t);
    const event = 'PP-D-EVENT-RESOLVED',
      read = 'PP-D-READ-RESOLVED',
      old = 'PP-D-OLD';
    for (const id of [event, read, old])
      f.records.set(id, disputeRecord(id, f.base + hour));
    f.records.set(
      read,
      disputeRecord(read, f.base + hour, { status: 'RESOLVED' }),
    );
    await f.receive(event, 'CUSTOMER.DISPUTE.CREATED');
    await f.receive(event, 'CUSTOMER.DISPUTE.RESOLVED');
    assert.equal((await f.row(event)).ended, 'resolved');
    await f.receive(event, 'CUSTOMER.DISPUTE.UPDATED');
    assert.equal((await f.row(event)).version, 2);
    await f.receive(read, 'CUSTOMER.DISPUTE.CREATED');
    // A RESOLVED event for an unseen dispute creates an ended row.
    await f.receive('PP-D-ONLY-RESOLVED', 'CUSTOMER.DISPUTE.RESOLVED');
    assert.equal((await f.row('PP-D-ONLY-RESOLVED')).ended, 'resolved');
    await f.receive(old, 'CUSTOMER.DISPUTE.CREATED');
    const tracker = f.tracker();
    f.setClock((await f.row(old)).first_event_at.getTime() + 180 * day);
    await tracker.tick();
    assert.equal(
      f.gets(event),
      0,
      'a resolved event ends tracking without a read',
    );
    assert.equal(f.gets('PP-D-ONLY-RESOLVED'), 0);
    assert.equal(f.gets(old), 0, 'expiry spends no provider read');
    assert.equal((await f.row(old)).ended, 'expired');
    assert.equal((await f.row(read)).ended, 'expired');
    // Before the bound, a provider resolution ends tracking.
    const fresh = 'PP-D-FRESH-RESOLVED';
    f.records.set(
      fresh,
      disputeRecord(fresh, f.base + hour, { status: 'RESOLVED' }),
    );
    f.setClock(f.base);
    await f.receive(fresh, 'CUSTOMER.DISPUTE.CREATED');
    await tracker.tick();
    const row = await f.row(fresh);
    assert.equal(row.ended, 'resolved');
    assert.equal(row.last_outcome, 'resolved');
    assert.equal(f.gets(fresh), 1);
    assert.equal(
      (
        await f.owner.query(
          'SELECT count(*)::int AS n FROM approvals.dispute_alerts',
        )
      ).rows[0].n,
      0,
    );
  });

  await t.test(
    'concurrent schedulers claim each row once per lease and alert once',
    async (t) => {
      const f = await fixture(t);
      const ids = Array.from({ length: 6 }, (_, i) => `PP-D-MANY-${i}`);
      for (const id of ids) {
        f.records.set(id, disputeRecord(id, f.base + hour));
        await f.receive(id, 'CUSTOMER.DISPUTE.CREATED');
      }
      const a = f.tracker(),
        b = f.tracker();
      await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
      for (const id of ids) {
        assert.equal(f.gets(id), 1, id);
        assert.deepEqual(
          (await f.alerts(id)).map((x) => x.stage),
          ['due_soon', 'due_soon'],
        );
      }
      // A process whose lease expired and was claimed again records nothing.
      const slow = 'PP-D-SLOW';
      f.records.set(slow, disputeRecord(slow, f.base + 2 * hour));
      await f.receive(slow, 'CUSTOMER.DISPUTE.CREATED');
      let release, reached;
      const paused = new Promise((resolve) => {
        reached = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      f.onGet(async (id) => {
        if (id === slow && f.gets(slow) === 1) {
          reached();
          await gate;
        }
      });
      const first = a.tick();
      await paused;
      await b.tick();
      assert.equal(f.gets(slow), 1, 'an active lease is not claimed again');
      f.setClock(f.base + 30_000);
      await b.tick();
      assert.equal(f.gets(slow), 2);
      release();
      await first;
      assert.equal((await f.alerts(slow)).length, 2);
      const row = await f.row(slow);
      assert.equal(row.last_outcome, 'due_soon');
      assert.equal(row.claim_id, null);
    },
  );

  await t.test(
    'without a test clock, the claim, lease and schedule follow the database clock',
    async (t) => {
      const f = await fixture(t);
      const id = 'PP-D-SKEW';
      const dbNow = async () =>
        (
          await f.owner.query('SELECT clock_timestamp() AS at')
        ).rows[0].at.getTime();
      f.records.set(id, disputeRecord(id, (await dbNow()) + 3 * day));
      await f.receive(id, 'CUSTOMER.DISPUTE.CREATED');
      const tracker = f.tracker({ databaseClock: true });
      let lease;
      f.onGet(async () => {
        lease = (await f.row(id)).leased_until.getTime();
      });
      // The application clock runs ten minutes behind the database.
      const realNow = Date.now;
      const skew = 10 * 60_000;
      const before = await dbNow();
      Date.now = () => realNow() - skew;
      try {
        await tracker.tick();
      } finally {
        Date.now = realNow;
      }
      const after = await dbNow();
      assert.equal(f.gets(id), 1, 'a trigger-set check is due at once');
      assert.ok(lease >= before + 30_000 && lease <= after + 30_000, 'lease');
      const row = await f.row(id);
      assert.equal(row.last_outcome, 'scheduled');
      assert.equal(row.claim_id, null);
      const next = row.next_check_at.getTime();
      assert.ok(next >= before + day - 1000 && next <= after + day, 'schedule');
    },
  );

  await t.test(
    'an event stored during the provider read keeps the trigger schedule',
    async (t) => {
      const f = await fixture(t);
      const { base } = f;
      const moved = 'PP-D-MOVED',
        extended = 'PP-D-EXTENDED';
      f.records.set(moved, disputeRecord(moved, base + 3 * day));
      f.records.set(extended, disputeRecord(extended, base + 12 * hour));
      await f.receive(moved, 'CUSTOMER.DISPUTE.CREATED');
      const tracker = f.tracker();
      f.onGet(async (id) => {
        if (id === moved && f.gets(moved) === 1)
          await f.receive(moved, 'CUSTOMER.DISPUTE.UPDATED');
        if (id === extended && f.gets(extended) === 1) {
          await f.receive(extended, 'CUSTOMER.DISPUTE.UPDATED');
          f.records.set(extended, disputeRecord(extended, base + 3 * day));
        }
      });
      await tracker.tick();
      let row = await f.row(moved);
      assert.equal(f.gets(moved), 1);
      assert.equal(row.version, 2);
      assert.equal(row.claim_id, null);
      assert.equal(row.last_outcome, null);
      assert.equal(row.next_check_at.getTime(), row.last_event_at.getTime());
      assert.ok(
        row.next_check_at.getTime() < base,
        'trigger value, not scheduled',
      );
      // The update moved the deadline inside 24 hours.
      f.records.set(moved, disputeRecord(moved, base + 12 * hour));
      await tracker.tick();
      assert.equal(f.gets(moved), 2);
      assert.equal((await f.row(moved)).last_outcome, 'due_soon');
      assert.equal((await f.alerts(moved)).length, 2);
      // A read that would alert is discarded when an event extends the deadline.
      await f.receive(extended, 'CUSTOMER.DISPUTE.CREATED');
      await tracker.tick();
      assert.equal(f.gets(extended), 1);
      assert.equal((await f.alerts(extended)).length, 0);
      row = await f.row(extended);
      assert.equal(row.last_outcome, null);
      await tracker.tick();
      assert.equal(f.gets(extended), 2);
      row = await f.row(extended);
      assert.equal(row.last_outcome, 'scheduled');
      assert.equal((await f.alerts(extended)).length, 0);
      f.setClock(base + 2 * day);
      await tracker.tick();
      const alerts = await f.alerts(extended);
      assert.deepEqual(
        alerts.map((a) => a.stage),
        ['due_soon', 'due_soon'],
      );
      assert.equal(alerts[0].due_at.getTime(), base + 3 * day);
    },
  );

  await t.test(
    'an event after the row lock waits for settlement and keeps its schedule',
    async (t) => {
      const f = await fixture(t);
      const id = 'PP-D-LOCKED';
      f.records.set(id, disputeRecord(id, f.base + hour));
      await f.receive(id, 'CUSTOMER.DISPUTE.CREATED');
      const real = new DisputeDeadlineAlerts(f.pool, f.devices);
      let pending;
      const tracker = f.tracker({
        alerts: {
          record: async (result, agentId, client) => {
            pending = f.receive(id, 'CUSTOMER.DISPUTE.UPDATED');
            let waiting = 0;
            for (let i = 0; i < 200 && waiting === 0; i++) {
              waiting = (
                await f.owner.query(
                  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
                  [receiverLogin],
                )
              ).rows[0].n;
              if (!waiting) await new Promise((r) => setTimeout(r, 10));
            }
            assert.equal(waiting, 1, 'the event insert waits on the row lock');
            return real.record(result, agentId, client);
          },
        },
      });
      await tracker.tick();
      await pending;
      const row = await f.row(id);
      assert.equal(row.version, 2);
      assert.equal(row.last_outcome, 'due_soon');
      assert.equal(row.claim_id, null);
      assert.equal(row.next_check_at.getTime(), row.last_event_at.getTime());
      assert.ok(row.next_check_at.getTime() < f.base);
      assert.equal((await f.alerts(id)).length, 2);
    },
  );

  await t.test(
    'a settlement that rolls back leaves no alert, and one connection suffices',
    async (t) => {
      const f = await fixture(t);
      const id = 'PP-D-ROLLBACK',
        after = 'PP-D-AFTER',
        single = 'PP-D-SINGLE';
      f.records.set(id, disputeRecord(id, f.base + hour));
      f.records.set(after, disputeRecord(after, f.base + 2 * hour));
      await f.receive(id, 'CUSTOMER.DISPUTE.CREATED');
      await f.receive(after, 'CUSTOMER.DISPUTE.CREATED');
      const real = new DisputeDeadlineAlerts(f.pool, f.devices);
      let inserted = 0;
      const failing = f.tracker({
        alerts: {
          record: async (result, agentId, client) => {
            const count = await real.record(result, agentId, client);
            if (result.review.resolvedCtx.dispute.dispute_id !== id)
              return count;
            inserted = count;
            throw new Error('synthetic failure after record');
          },
        },
      });
      // The throw fails that row only; the tick goes on to the next due row.
      await failing.tick();
      assert.equal(inserted, 2);
      assert.equal((await f.alerts(id)).length, 0);
      let row = await f.row(id);
      assert.equal(row.last_outcome, 'dispute_unavailable');
      assert.equal(row.failures, 1);
      assert.equal(row.failing_since.getTime(), f.base);
      assert.equal(row.next_check_at.getTime(), f.base + 60_000);
      assert.equal(row.claim_id, null);
      assert.equal((await f.row(after)).last_outcome, 'due_soon');
      assert.equal((await f.alerts(after)).length, 2);
      // A failure that repeats backs off and reaches the exhausted bound.
      f.setClock(f.base + 60_000);
      await failing.tick();
      row = await f.row(id);
      assert.equal(row.failures, 2);
      assert.equal(row.next_check_at.getTime(), f.base + 3 * 60_000);
      f.setClock(f.base + 7 * day);
      await failing.tick();
      row = await f.row(id);
      assert.equal(row.ended, 'exhausted');
      assert.equal(row.failures, 3);
      assert.equal((await f.alerts(id)).length, 0);
      assert.equal(f.gets(id), 3);
      // A pool with one connection settles a due_soon row and its alert.
      f.setClock(f.base);
      f.records.set(single, disputeRecord(single, f.base + hour));
      await f.receive(single, 'CUSTOMER.DISPUTE.CREATED');
      const one = f.open(f.appUrl, 1);
      const devices = f.authority(merchant.id, one);
      const tracker = f.tracker({ pool: one, devices });
      await tracker.tick();
      assert.equal((await f.row(single)).last_outcome, 'due_soon');
      assert.equal((await f.alerts(single)).length, 2);
    },
  );
});
