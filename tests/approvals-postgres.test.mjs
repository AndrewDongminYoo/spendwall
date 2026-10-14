import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  checkApproval,
  approvalLookup,
} from '../apps/firewall/src/approvals/tool.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ApprovalService } from '../apps/firewall/src/approvals/index.ts';
import { RefundExecutor } from '../apps/firewall/src/refunds.ts';
import { foldHistory } from '../apps/firewall/src/velocity/aggregate.ts';
import { verifyAudit } from '../apps/firewall/src/audit/index.ts';
import { loadPolicy } from '../packages/policy/src/index.ts';

const url = process.env.AUDIT_TEST_DATABASE_URL;
const key = '7'.repeat(64),
  capture = 'CAPTURE12345678901',
  refundId = 'REFUND123456789012';
const policy = loadPolicy(
  JSON.stringify({
    agents: { support: { tools: { allow: ['create_refund'], deny: [] } } },
    rules: [
      {
        id: 'refund approval limit',
        when: 'agg.refund_count_1h < 1',
        then: 'require_approval',
      },
    ],
    default: 'deny',
  }),
);
const request = () => ({
  requestId: randomUUID(),
  context: {
    tool: 'create_refund',
    args: { capture_id: capture },
    amount: { value: '60', currency: 'USD' },
    agent: { id: 'support' },
    customer: { id: 'customerA' },
    merchant: { id: 'merchantA' },
    agg: {},
  },
  resolvedCtx: {},
});
async function fixture(t) {
  const target = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/spendwall_audit_test');
  const owner = new pg.Pool({ connectionString: url });
  await owner.query('DROP SCHEMA IF EXISTS approvals CASCADE');
  await owner.query('DROP SCHEMA IF EXISTS audit CASCADE');
  for (const name of ['001-audit.sql', '002-velocity.sql', '003-approvals.sql'])
    await owner.query(
      await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'),
    );
  const group = (await owner.query('SELECT audit.app_role() AS name')).rows[0]
    .name;
  await owner.query(
    "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='approval_test_login') THEN CREATE ROLE approval_test_login LOGIN PASSWORD 'approval-test-only'; END IF; END $$",
  );
  await owner.query(
    `GRANT ${pg.escapeIdentifier(group)} TO approval_test_login`,
  );
  target.username = 'approval_test_login';
  target.password = 'approval-test-only';
  const app = new pg.Pool({
    connectionString: target.toString(),
    max: 8,
    connectionTimeoutMillis: 2000,
  });
  const dir = await mkdtemp(join(tmpdir(), 'spendwall-approval-'));
  const seen = { posts: [], gets: [], operations: new Set() };
  let mode = 'success',
    first = true,
    fakeTime;
  let beforePost = async () => {};
  const fetchImpl = async (input, init) => {
    const u = new URL(input);
    assert.equal(u.origin, 'https://api-m.sandbox.paypal.com');
    const json = (v) =>
      new Response(JSON.stringify(v), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (u.pathname === '/v1/oauth2/token')
      return json({
        access_token: 'synthetic-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    if (u.pathname === `/v2/payments/captures/${capture}`)
      return json({
        id: capture,
        status: 'COMPLETED',
        amount: { value: '60.00', currency_code: 'USD' },
      });
    const result = {
      id: refundId,
      status:
        mode === 'pending'
          ? 'PENDING'
          : mode === 'failed'
            ? 'FAILED'
            : mode === 'cancelled'
              ? 'CANCELLED'
              : 'COMPLETED',
      amount: { value: '60.00', currency_code: 'USD' },
      links: [
        {
          rel: 'up',
          href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${capture}`,
        },
      ],
    };
    if (init.method === 'POST') {
      const id = init.headers['PayPal-Request-Id'],
        body = JSON.parse(init.body);
      const stored = (
        await app.query(
          'SELECT execution_id,execution_state FROM approvals.requests',
        )
      ).rows[0];
      assert.equal(stored.execution_id, id);
      assert.equal(stored.execution_state, 'in_flight');
      seen.posts.push({ id, body });
      seen.operations.add(id);
      await beforePost();
      if (mode === 'lost' && first) {
        first = false;
        throw new TypeError('synthetic response loss');
      }
      return json(result);
    }
    assert.equal(u.pathname, `/v2/payments/refunds/${refundId}`);
    seen.gets.push(u.pathname);
    return json(result);
  };
  const options = {
    ledgerPath: join(dir, 'ledger.json'),
    env: {
      PAYPAL_CLIENT_ID: 'synthetic-client',
      PAYPAL_CLIENT_SECRET: 'synthetic-secret',
    },
    fetchImpl,
  };
  let executor = await RefundExecutor.open(options);
  const create = (adapter = executor) =>
    new ApprovalService(app, {
      identityKey: key,
      merchantId: 'merchantA',
      executor: adapter,
      clock: () => fakeTime,
    });
  let service = create();
  t.after(async () => {
    await executor.close();
    await app.end();
    await owner.query('DROP SCHEMA IF EXISTS approvals CASCADE');
    await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(group)}`);
    await owner.query(`DROP ROLE ${pg.escapeIdentifier(group)}`);
    await owner.end();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    owner,
    app,
    seen,
    options,
    dir,
    group,
    get service() {
      return service;
    },
    get executor() {
      return executor;
    },
    create,
    async aggregates() {
      const rows = (
        await app.query(
          'SELECT e.*,e.id::text,(extract(epoch FROM ts)*1000)::float8 AS ts_ms FROM audit.audit_events e ORDER BY e.id',
        )
      ).rows;
      const meta = rows[0].resolved_ctx.velocity;
      const now = (
        await app.query(
          'SELECT (extract(epoch FROM clock_timestamp()::timestamptz(3))*1000)::float8 AS now',
        )
      ).rows[0].now;
      return foldHistory(rows, {
        now,
        merchantRef: meta.merchant_ref,
        customerRef: meta.customer_ref,
        agentId: rows[0].agent_id,
        keyId: meta.key_id,
      }).agg;
    },
    setMode(v) {
      mode = v;
    },
    beforePost(fn) {
      beforePost = fn;
    },
    setTime(v) {
      fakeTime = v;
    },
    async restart() {
      await executor.close();
      executor = await RefundExecutor.open(options);
      service = create();
    },
  };
}
async function pending(f, input = request()) {
  const p = await f.service.request(policy, input);
  assert.equal(p?.status, 'pending_approval');
  assert.match(p.approval_id, /^[a-f0-9-]{36}$/);
  return { id: p.approval_id, input };
}

test('Postgres approval boundary', { skip: !url }, async (t) => {
  await t.test(
    'the database rejects a pending approval jumping straight to success',
    async (t) => {
      const f = await fixture(t),
        { id } = await pending(f);
      await assert.rejects(
        f.app.query(
          "UPDATE approvals.requests SET approval_state='approved',execution_state='succeeded',execution_id=$2,started_at=clock_timestamp() WHERE approval_id=$1",
          [id, randomUUID()],
        ),
        /Invalid execution transition/,
      );
    },
  );
  await t.test(
    'unknown execution requires a new claim before a terminal outcome',
    async (t) => {
      const f = await fixture(t),
        { id, input } = await pending(f);
      f.setMode('lost');
      await f.service.approve(id, policy, input);
      await assert.rejects(
        f.app.query(
          "UPDATE approvals.requests SET execution_state='succeeded' WHERE approval_id=$1",
          [id],
        ),
        /Invalid execution transition/,
      );
    },
  );

  await t.test(
    'a definite failed result retains capacity and cannot execute again',
    async (t) => {
      const f = await fixture(t),
        { id, input } = await pending(f);
      f.setMode('failed');
      const failed = await f.service.approve(id, policy, input);
      assert.equal(failed.execution_state, 'failed');
      assert.equal((await f.aggregates()).refund_count_1h, 1);
      assert.equal((await f.aggregates()).refund_usd_24h, 60);
      assert.equal(
        (await f.service.recover(id, policy, input)).execution_state,
        'failed',
      );
      assert.equal(f.seen.posts.length, 1);
      await assert.rejects(
        f.app.query(
          "UPDATE approvals.requests SET execution_state='unknown' WHERE approval_id=$1",
          [id],
        ),
        /Terminal execution/,
      );
      await assert.rejects(
        f.app.query('DELETE FROM approvals.requests WHERE approval_id=$1', [
          id,
        ]),
        (e) => e.code === '42501',
      );
      await assert.rejects(
        f.app.query(
          "UPDATE approvals.requests SET binding_ref=repeat('a',64) WHERE approval_id=$1",
          [id],
        ),
        /Immutable approval binding/,
      );
    },
  );
  await t.test(
    'creation retry repairs the original receipt without renewing its deadline',
    async (t) => {
      const f = await fixture(t),
        input = request();
      await f.owner.query(
        `REVOKE INSERT ON approvals.requests FROM ${pg.escapeIdentifier(f.group)}`,
      );
      await assert.rejects(
        f.service.request(policy, input),
        /Approval unavailable/,
      );
      const source = (
        await f.app.query(
          "SELECT approval_id,ts FROM audit.audit_events WHERE event_kind='tool_call' AND decision='require_approval'",
        )
      ).rows[0];
      assert.equal(
        (await f.app.query('SELECT count(*) FROM approvals.requests')).rows[0]
          .count,
        '0',
      );
      await f.owner.query(
        `GRANT INSERT ON approvals.requests TO ${pg.escapeIdentifier(f.group)}`,
      );
      const repaired = await f.service.request(policy, input);
      assert.equal(repaired.approval_id, source.approval_id);
      const row = (
        await f.app.query(
          'SELECT created_at,expires_at FROM approvals.requests',
        )
      ).rows[0];
      assert.equal(row.created_at.getTime(), source.ts.getTime());
      assert.equal(row.expires_at - row.created_at, 15 * 60 * 1000);
      assert.equal((await verifyAudit(f.app)).count, 2);
      assert.equal(f.seen.posts.length, 0);
    },
  );
  await t.test(
    'audit failure rolls back a decision and prevents provider execution',
    async (t) => {
      const f = await fixture(t),
        { id, input } = await pending(f);
      await f.owner.query(
        `REVOKE EXECUTE ON FUNCTION audit.append_event(jsonb) FROM ${pg.escapeIdentifier(f.group)}`,
      );
      await assert.rejects(f.service.approve(id, policy, input));
      await assert.rejects(f.service.deny(id, 'support'));
      const row = (
        await f.app.query(
          'SELECT approval_state,execution_id FROM approvals.requests',
        )
      ).rows[0];
      assert.equal(row.approval_state, 'pending');
      assert.equal(row.execution_id, null);
      assert.equal(f.seen.posts.length, 0);
      assert.equal((await verifyAudit(f.app)).count, 2);
    },
  );
  for (const mode of ['success', 'failed', 'cancelled'])
    await t.test(
      `post-send audit failure recovers committed ${mode} result after process restart`,
      async (t) => {
        const f = await fixture(t),
          { id, input } = await pending(f);
        f.setMode(mode);
        f.beforePost(async () => {
          await f.owner.query(
            `REVOKE EXECUTE ON FUNCTION audit.append_event(jsonb) FROM ${pg.escapeIdentifier(f.group)}`,
          );
        });
        await assert.rejects(f.service.approve(id, policy, input));
        const row = (
          await f.app.query(
            'SELECT execution_id,execution_state FROM approvals.requests',
          )
        ).rows[0];
        assert.equal(row.execution_state, 'in_flight');
        assert.equal(f.seen.posts.length, 1);
        await f.owner.query(
          `GRANT EXECUTE ON FUNCTION audit.append_event(jsonb) TO ${pg.escapeIdentifier(f.group)}`,
        );
        await f.restart();
        assert.equal(
          (await f.service.check({ approvalId: id, agentId: 'support' }))
            .execution_state,
          'unknown',
        );
        const done = await f.service.recover(id, policy, input);
        assert.equal(
          done.execution_state,
          mode === 'success' ? 'succeeded' : 'failed',
        );
        assert.equal(done.execution_id, row.execution_id);
        assert.equal(f.seen.posts.length, 1);
        assert.equal(f.seen.gets.length, mode === 'success' ? 0 : 1);
        assert.equal((await f.aggregates()).refund_count_1h, 1);
        assert.equal((await f.aggregates()).refund_usd_24h, 60);
        assert.equal((await verifyAudit(f.app)).ok, true);
      },
    );
  await t.test(
    'old unknown without a refund reference stays reserved without POST',
    async (t) => {
      const f = await fixture(t),
        { id, input } = await pending(f);
      f.setMode('lost');
      const lost = await f.service.approve(id, policy, input);
      const started = (
        await f.app.query('SELECT started_at FROM approvals.requests')
      ).rows[0].started_at.getTime();
      f.setTime(started + 25 * 60 * 60 * 1000);
      await f.restart();
      const done = await f.service.recover(id, policy, input);
      assert.equal(done.execution_state, 'unknown');
      assert.equal(done.execution_id, lost.execution_id);
      assert.equal(f.seen.posts.length, 1);
      assert.equal(
        (await f.service.request(policy, request())).decision,
        'deny',
      );
    },
  );
  await t.test(
    'another provider account cannot execute an existing approval',
    async (t) => {
      const f = await fixture(t),
        { id, input } = await pending(f);
      const other = await RefundExecutor.open({
        ...f.options,
        ledgerPath: join(f.dir, 'other.json'),
        env: {
          PAYPAL_CLIENT_ID: 'different-client',
          PAYPAL_CLIENT_SECRET: 'different-secret',
        },
      });
      try {
        await assert.rejects(f.create(other).approve(id, policy, input));
        assert.equal(f.seen.posts.length, 0);
      } finally {
        await other.close();
      }
    },
  );
  await t.test(
    'check_approval protocol returns owned status and never executes',
    async (t) => {
      const f = await fixture(t),
        { id, input } = await pending(f);
      const [serverTransport, clientTransport] =
        InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: 'approval-fixture', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
        checkApproval(f.service, { agentId: 'support' }, params.arguments),
      );
      const client = new Client({ name: 'synthetic-agent', version: '1.0.0' });
      t.after(async () => {
        await client.close();
        await server.close();
      });
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.callTool({
        name: 'check_approval',
        arguments: { approval_id: id },
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.status, 'pending');
      assert.equal(result.structuredContent.execution_state, null);
      assert.equal(f.seen.posts.length, 0);
      await f.service.approve(id, policy, input);
      const completed = await client.callTool({
        name: 'check_approval',
        arguments: { approval_id: id },
      });
      assert.equal(completed.structuredContent.execution_state, 'succeeded');
      assert.equal(completed.structuredContent.result.id, refundId);
      assert.equal(f.seen.posts.length, 1);
      const denied = await checkApproval(
        f.service,
        { agentId: 'other' },
        { approval_id: id },
      );
      assert.equal(denied.isError, true);
      assert.doesNotMatch(
        JSON.stringify(denied),
        /merchantA|customerA|CAPTURE123|synthetic-secret/,
      );
      assert.equal(
        (
          await approvalLookup(f.service)({
            agentId: 'support',
            approvalId: id,
          })
        ).status,
        'approved',
      );
    },
  );

  await t.test(
    'creation is durable, private, replayable and has no payment side effect',
    async (t) => {
      const f = await fixture(t),
        { id, input } = await pending(f);
      assert.equal((await f.service.request(policy, input)).approval_id, id);
      assert.equal(f.seen.posts.length, 0);
      const rows = (await f.app.query('SELECT * FROM approvals.requests')).rows;
      assert.equal(rows.length, 1);
      assert.doesNotMatch(
        JSON.stringify(rows),
        /merchantA|customerA|CAPTURE12345678901|synthetic-secret/,
      );
      const events = (
        await f.app.query(
          'SELECT event_kind FROM audit.audit_events ORDER BY id',
        )
      ).rows;
      assert.deepEqual(
        events.map((x) => x.event_kind),
        ['tool_call', 'approval_created'],
      );
      assert.equal(
        (await f.service.check({ agentId: 'support', approvalId: id })).status,
        'pending',
      );
      await assert.rejects(
        f.service.check({ agentId: 'other', approvalId: id }),
        /Approval unavailable/,
      );
    },
  );
  await t.test(
    'concurrent independent approval callers execute one persisted identity',
    async (t) => {
      const f = await fixture(t),
        { id, input } = await pending(f);
      let release, entered;
      const gate = new Promise((r) => {
          release = r;
        }),
        start = new Promise((r) => {
          entered = r;
        });
      f.beforePost(async () => {
        entered();
        await gate;
      });
      const first = f.service.approve(id, policy, input);
      await start;
      let deadline;
      try {
        const second = await f.create().approve(id, policy, input);
        assert.equal(second.execution_state, 'in_flight');
        const recovery = await Promise.race([
          f.create().recover(id, policy, input),
          new Promise((_, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  new Error('An active execution must not enter recovery'),
                ),
              1500,
            );
          }),
        ]);
        assert.equal(recovery.execution_state, 'in_flight');
      } finally {
        clearTimeout(deadline);
        release();
      }
      const done = await first;
      assert.equal(done.execution_state, 'succeeded');
      assert.equal((await f.aggregates()).refund_count_1h, 1);
      assert.equal((await f.aggregates()).refund_usd_24h, 60);
      assert.equal(f.seen.posts.length, 1);
      assert.equal(
        (await f.service.approve(id, policy, input)).execution_id,
        done.execution_id,
      );
      await f.restart();
      assert.equal(
        (await f.service.approve(id, policy, input)).execution_id,
        done.execution_id,
      );
      assert.equal(f.seen.posts.length, 1);
      assert.deepEqual(f.seen.posts[0].body, {
        amount: { value: '60.00', currency_code: 'USD' },
      });
      assert.equal((await verifyAudit(f.app)).ok, true);
    },
  );
  await t.test(
    'expiry boundary and denial release only an unclaimed reservation',
    async (t) => {
      const f = await fixture(t),
        { id, input } = await pending(f);
      const expires = Number(
        (
          await f.app.query(
            'SELECT extract(epoch FROM expires_at)*1000 AS ms FROM approvals.requests',
          )
        ).rows[0].ms,
      );
      f.setTime(expires);
      assert.equal(
        (await f.service.approve(id, policy, input)).status,
        'expired',
      );
      assert.equal(f.seen.posts.length, 0);
      f.setTime(undefined);
      const next = await pending(f);
      assert.equal((await f.service.deny(next.id, 'support')).status, 'denied');
      await assert.rejects(f.service.approve(next.id, policy, next.input));
      assert.equal(
        (await f.service.request(policy, request())).status,
        'pending_approval',
      );
      assert.equal((await verifyAudit(f.app)).ok, true);
    },
  );
  await t.test('each binding change denies without payment', async (t) => {
    const f = await fixture(t),
      { id, input } = await pending(f);
    for (const change of [
      (p) => (p.context.merchant.id = 'merchantB'),
      (p) => (p.context.customer.id = 'customerB'),
      (p) => (p.context.args.capture_id = 'DIFFERENTCAPTURE1'),
      (p) => (p.context.amount.value = '61'),
      (p) => (p.context.args.note_to_payer = 'changed'),
      (p) => (p.context.amount.currency = 'EUR'),
    ]) {
      const changed = structuredClone(input);
      change(changed);
      await assert.rejects(f.service.approve(id, policy, changed));
    }
    const changedPolicy = loadPolicy(
      JSON.stringify({
        agents: { support: { tools: { allow: ['create_refund'], deny: [] } } },
        rules: [{ id: 'different', when: 'true', then: 'require_approval' }],
        default: 'deny',
      }),
    );
    await assert.rejects(f.service.approve(id, changedPolicy, input));
    assert.equal(f.seen.posts.length, 0);
  });
  await t.test(
    'lost response retains capacity and stable execution identity after restart',
    async (t) => {
      const f = await fixture(t),
        { id, input } = await pending(f);
      f.setMode('lost');
      const lost = await f.service.approve(id, policy, input);
      assert.equal(lost.execution_state, 'unknown');
      assert.equal((await f.aggregates()).refund_count_1h, 1);
      assert.equal((await f.aggregates()).refund_usd_24h, 60);
      assert.equal(
        (await f.service.request(policy, request())).decision,
        'deny',
      );
      await assert.rejects(f.service.deny(id, 'support'));
      await f.restart();
      const done = await f.service.recover(id, policy, input);
      assert.equal(done.execution_state, 'succeeded');
      assert.equal(done.execution_id, lost.execution_id);
      assert.equal(f.seen.operations.size, 1);
      assert.equal(f.seen.posts.length, 2);
      assert.deepEqual(f.seen.posts[0], f.seen.posts[1]);
    },
  );
  await t.test(
    'known pending result uses GET and old unknown cannot issue POST',
    async (t) => {
      const f = await fixture(t),
        { id, input } = await pending(f);
      f.setMode('pending');
      const first = await f.service.approve(id, policy, input);
      assert.equal(first.execution_state, 'unknown');
      const started = Number(
        (
          await f.app.query(
            'SELECT extract(epoch FROM started_at)*1000 AS ms FROM approvals.requests',
          )
        ).rows[0].ms,
      );
      f.setTime(started + 25 * 60 * 60 * 1000);
      await f.restart();
      f.setMode('success');
      assert.equal(
        (await f.service.recover(id, policy, input)).execution_state,
        'succeeded',
      );
      assert.equal(f.seen.posts.length, 1);
      assert.equal(f.seen.gets.length, 1);
    },
  );
});
