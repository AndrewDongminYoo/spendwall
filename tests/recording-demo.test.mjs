import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { withDemoDatabase } from '../apps/agent-demo/src/database.ts';
import {
  createRecordingDemo,
  sandboxResultLine,
} from '../apps/agent-demo/src/recording.ts';
import { recordedPayments } from '../apps/agent-demo/src/payments.ts';
import { readRefund } from '../apps/firewall/src/context/refund.ts';

const preload = new URL('./helpers/recording-preload.mjs', import.meta.url)
  .pathname;

// These credentials authorize only this disposable synthetic fixture. They
// never appear in a runnable device configuration or a real credential store.
const enrollment = Buffer.alloc(32, 91).toString('base64url');
const agentId = 'demo-support';

async function fixture(url, t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'spendwall-recording-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policyFile = join(directory, 'policy.yaml');
  const ticketFile = join(directory, 'ticket.json');
  await writeFile(
    policyFile,
    await readFile(new URL('../apps/agent-demo/policy.yaml', import.meta.url)),
  );
  await writeFile(
    ticketFile,
    await readFile(
      new URL('../apps/agent-demo/tickets/approval.json', import.meta.url),
    ),
  );
  const notifications = [];
  const demo = await createRecordingDemo(url, {
    identityKey: randomBytes(32).toString('hex'),
    signingKey: randomBytes(32).toString('hex'),
    devices: () => [
      {
        deviceId: 'synthetic-recording-device',
        agentId,
        enrollmentHash: createHash('sha256').update(enrollment).digest('hex'),
      },
    ],
    notifier: {
      async send(token, id) {
        notifications.push({ token, id });
      },
    },
    pollIntervalMs: 0,
    policyFile,
    ticketFile,
    ...options,
  });
  t.after(() => demo.close());
  async function http(path, method = 'GET', body, token) {
    const response = await fetch(demo.url + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  async function register() {
    const response = await http(
      '/devices/register',
      'POST',
      {
        device_id: 'synthetic-recording-device',
        fcm_token: 'synthetic-recording-fcm-address',
      },
      enrollment,
    );
    assert.equal(response.status, 201);
    assert.equal(response.body.expires_in, 900);
    return response.body.access_token;
  }
  return { demo, register, http, notifications, policyFile, ticketFile };
}

test('recording composition uses policy, trusted context and the loopback approval API', async (t) => {
  await withDemoDatabase(async (url) => {
    await t.test(
      'registration precedes policy request; pending holds zero writes; concurrent and repeated approval executes once',
      async (t) => {
        const f = await fixture(url, t);
        assert.equal(new URL(f.demo.url).hostname, '127.0.0.1');
        assert.equal(await f.demo.ready(), false);
        await assert.rejects(f.demo.request(), /registered approver/i);
        assert.equal(f.demo.payments.length, 0);
        const token = await f.register();
        assert.equal(await f.demo.ready(), true);
        const pending = await f.demo.request();
        assert.equal(pending.status, 'pending_approval');
        assert.equal((await f.demo.request()).approval_id, pending.approval_id);
        await f.demo.drainNotifications();
        assert.deepEqual(f.notifications, [
          { token: 'synthetic-recording-fcm-address', id: pending.approval_id },
        ]);
        const path = `/approvals/${pending.approval_id}`;
        const listed = await f.http(
          '/approvals?status=pending',
          'GET',
          undefined,
          token,
        );
        assert.equal(listed.body.items.length, 1);
        const detail = (await f.http(path, 'GET', undefined, token)).body;
        assert.deepEqual(detail.matched_rules, ['rules.v1:1']);
        assert.equal(detail.context.amount.value, '60.00');
        assert.equal(detail.context.customer.id, 'demo-customer');
        assert.equal(detail.context.merchant.id, 'demo-merchant');
        assert.equal(f.demo.payments.length, 0);
        assert.equal(
          (
            await f.http(
              path + '/decision',
              'POST',
              { decision: 'approve', args_hash: '0'.repeat(64) },
              token,
            )
          ).status,
          409,
        );
        assert.equal(f.demo.payments.length, 0);
        const decision = { decision: 'approve', args_hash: detail.args_hash };
        const replies = await Promise.all(
          Array.from({ length: 3 }, () =>
            f.http(path + '/decision', 'POST', decision, token),
          ),
        );
        assert.ok(
          replies.some((reply) => reply.body.execution_state === 'succeeded'),
        );
        const repeat = await f.http(
          path + '/decision',
          'POST',
          decision,
          token,
        );
        assert.equal(repeat.status, 200);
        assert.equal(repeat.body.execution_state, 'succeeded');
        assert.equal(repeat.body.result.status, 'COMPLETED');
        assert.equal(f.demo.payments.length, 1);
        assert.equal(f.demo.payments[0].executionId, repeat.body.execution_id);
        assert.equal(
          (await f.demo.status(pending.approval_id)).execution_state,
          'succeeded',
        );
        const result = await fetch(f.demo.url + '/approvals?status=pending', {
          headers: { origin: 'https://outside.invalid' },
        });
        assert.equal(result.status, 403);
        // Node fetch replaces Host. Use raw HTTP to test the exact server boundary.
        const hostStatus = await new Promise((resolve, reject) => {
          const request = httpRequest(
            f.demo.url + '/approvals?status=pending',
            { headers: { host: 'localhost:' + new URL(f.demo.url).port } },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          );
          request.on('error', reject);
          request.end();
        });
        assert.equal(hostStatus, 403);
        assert.equal(
          (await f.http('/approvals', 'POST', {}, token)).status,
          405,
        );
        await f.demo.close();
        await f.demo.close();
      },
    );
    await t.test(
      'a briefly held approval lock delays a decision; a longer holder is busy',
      async (t) => {
        const f = await fixture(url, t);
        const token = await f.register();
        const pending = await f.demo.request();
        const path = `/approvals/${pending.approval_id}`;
        const detail = (await f.http(path, 'GET', undefined, token)).body;
        // Stands in for the recording CLI's status poll, which takes the same
        // per-approval advisory lock for a moment (issue 91). Advisory locks are
        // per database, so join the demo's own database, not the owner's.
        const admin = new pg.Client({ connectionString: url });
        await admin.connect();
        const { rows } = await admin.query(
          "SELECT datname FROM pg_database WHERE datname LIKE 'demo\\_%' ORDER BY oid DESC LIMIT 1",
        );
        await admin.end();
        const target = new URL(url);
        target.pathname = `/${rows[0].datname}`;
        const reader = new pg.Client({ connectionString: target.toString() });
        await reader.connect();
        t.after(() => reader.end());
        assert.equal(
          (
            await reader.query(
              'SELECT 1 FROM approvals.requests WHERE approval_id=$1',
              [pending.approval_id],
            )
          ).rowCount,
          1,
        );
        await reader.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
          `spendwall/approval/v1/${pending.approval_id}`,
        ]);
        const decide = () =>
          f.http(
            path + '/decision',
            'POST',
            { decision: 'approve', args_hash: detail.args_hash },
            token,
          );
        // A holder that outlasts the retry window still reports busy.
        const busy = await decide();
        assert.equal(busy.status, 409);
        assert.deepEqual(busy.body, { error: 'Approval changed or busy.' });
        assert.equal(f.demo.payments.length, 0);
        // Release mid-window, as a status read would.
        const reply = decide();
        await delay(250);
        await reader.query(
          'SELECT pg_advisory_unlock(hashtextextended($1,0))',
          [`spendwall/approval/v1/${pending.approval_id}`],
        );
        const result = await reply;
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.execution_state, 'succeeded');
        assert.equal(f.demo.payments.length, 1);
      },
    );
    await t.test(
      'a racing approval and denial settle on one decision',
      async (t) => {
        const f = await fixture(url, t);
        const token = await f.register();
        const pending = await f.demo.request();
        const path = `/approvals/${pending.approval_id}`;
        const detail = (await f.http(path, 'GET', undefined, token)).body;
        const [approve, deny] = await Promise.all(
          ['approve', 'deny'].map((decision) =>
            f.http(
              path + '/decision',
              'POST',
              { decision, args_hash: detail.args_hash },
              token,
            ),
          ),
        );
        const message = JSON.stringify({ approve, deny });
        const final = (await f.http(path, 'GET', undefined, token)).body;
        if (final.status === 'approved') {
          assert.equal(approve.status, 200, message);
          assert.equal(approve.body.execution_state, 'succeeded', message);
          assert.equal(deny.status, 409, message);
          assert.equal(f.demo.payments.length, 1);
        } else {
          assert.equal(final.status, 'denied', message);
          assert.equal(deny.status, 200, message);
          assert.equal(approve.status, 409, message);
          assert.equal(f.demo.payments.length, 0);
        }
      },
    );
    for (const scenario of ['deny', 'changed customer', 'changed policy']) {
      await t.test(
        `${scenario} never executes a synthetic refund`,
        async (t) => {
          const f = await fixture(url, t);
          const token = await f.register();
          const pending = await f.demo.request();
          const path = `/approvals/${pending.approval_id}`;
          const detail = (await f.http(path, 'GET', undefined, token)).body;
          if (scenario === 'changed customer') {
            const ticket = JSON.parse(await readFile(f.ticketFile, 'utf8'));
            ticket.customerId = 'different-synthetic-customer';
            await writeFile(f.ticketFile, JSON.stringify(ticket));
          }
          if (scenario === 'changed policy')
            await writeFile(
              f.policyFile,
              (await readFile(f.policyFile, 'utf8')).replace(
                'amount.usd > 20',
                'amount.usd > 30',
              ),
            );
          const reply = await f.http(
            path + '/decision',
            'POST',
            {
              decision: scenario === 'deny' ? 'deny' : 'approve',
              args_hash: detail.args_hash,
            },
            token,
          );
          // An unresolved customer fails refresh as unavailable; a changed valid
          // policy conflicts with the stored approval binding.
          assert.equal(
            reply.status,
            scenario === 'deny'
              ? 200
              : scenario === 'changed customer'
                ? 503
                : 409,
          );
          assert.equal(f.demo.payments.length, 0);
        },
      );
    }
    await t.test(
      'a policy denial is not converted to a pending approval',
      async (t) => {
        const f = await fixture(url, t);
        await f.register();
        await writeFile(
          f.policyFile,
          (await readFile(f.policyFile, 'utf8')).replace(
            'then: require_approval',
            'then: deny',
          ),
        );
        const result = await f.demo.request();
        assert.equal(result.decision, 'deny');
        await f.demo.drainNotifications();
        assert.equal(f.notifications.length, 0);
        assert.equal(f.demo.payments.length, 0);
      },
    );
    await t.test(
      'untrusted customer cannot create an approval despite the large amount',
      async (t) => {
        const f = await fixture(url, t);
        await f.register();
        const ticket = JSON.parse(await readFile(f.ticketFile, 'utf8'));
        ticket.customerId = 'unrelated-synthetic-customer';
        await writeFile(f.ticketFile, JSON.stringify(ticket));
        await assert.rejects(f.demo.request(), /context unavailable/i);
        assert.equal(f.demo.payments.length, 0);
        assert.equal(f.notifications.length, 0);
      },
    );
  });
});

// The synthetic fixture stands in for the PayPal sandbox. Its token, capture,
// order and refund responses satisfy the real resolver and executor checks.
const sandboxEnv = {
  PAYPAL_CLIENT_ID: 'sandbox-test-client-id',
  PAYPAL_CLIENT_SECRET: 'sandbox-test-client-secret',
};
// `unauthorizedRefunds` refund POSTs are recorded and answered with 401
// without reaching the fixture, like an expired sandbox token.
// `omitEmptyRefunds` removes an empty `payments.refunds` key from order
// responses, which PayPal's Orders v2 schema permits.
function sandboxProvider({
  unauthorizedRefunds = 0,
  omitEmptyRefunds = false,
} = {}) {
  const payment = recordedPayments();
  const calls = [];
  const isRefundPost = (call) =>
    call.method === 'POST' && call.url.endsWith('/refund');
  return {
    payment,
    calls,
    fetchImpl: async (input, init) => {
      const target = new URL(String(input));
      const call = {
        method: init?.method ?? 'GET',
        url: target.origin + target.pathname,
        headers: new Headers(init?.headers),
      };
      calls.push(call);
      if (isRefundPost(call) && unauthorizedRefunds > 0) {
        unauthorizedRefunds--;
        return new Response(null, { status: 401 });
      }
      const response = await payment.fetchImpl(input, init);
      if (
        !omitEmptyRefunds ||
        call.method !== 'GET' ||
        !target.pathname.startsWith('/v2/checkout/orders/') ||
        !response.ok
      )
        return response;
      const order = await response.json();
      const payments = order.purchase_units[0].payments;
      if (payments.refunds.length === 0) delete payments.refunds;
      return new Response(JSON.stringify(order), {
        status: response.status,
        headers: response.headers,
      });
    },
    refundPosts: () => calls.filter(isRefundPost),
    tokenPosts: () =>
      calls.filter(
        (call) => call.method === 'POST' && call.url.endsWith('/oauth2/token'),
      ),
  };
}
async function sandboxFixture(
  url,
  t,
  captureId = 'DEMO_CAPTURE_00002',
  providerOptions,
) {
  const provider = sandboxProvider(providerOptions);
  let time;
  const f = await fixture(url, t, {
    // No ticket file in sandbox mode: a ticket read would fail the run.
    ticketFile: join(tmpdir(), 'spendwall-no-such-ticket.json'),
    clock: () => time,
    paypal: {
      sandbox: {
        captureId,
        payerId: 'demo-customer',
        merchantId: 'demo-merchant',
        merchantEmail: 'merchant@example.test',
      },
      fetchImpl: provider.fetchImpl,
      env: sandboxEnv,
    },
  });
  return { ...f, provider, setTime: (value) => (time = value) };
}

test('sandbox recording composition submits one sandbox refund only after approval', async (t) => {
  await withDemoDatabase(async (url) => {
    await t.test(
      'concurrent and repeated approval submit one refund under the stored execution ID',
      async (t) => {
        const f = await sandboxFixture(url, t);
        const token = await f.register();
        const pending = await f.demo.request();
        assert.equal(pending.status, 'pending_approval');
        assert.equal(f.demo.payments, undefined);
        assert.equal(f.demo.executions(), 0);
        assert.equal(f.provider.refundPosts().length, 0);
        // The token request carries exactly the injected sandbox credentials.
        const tokenCall = f.provider.calls.find((call) =>
          call.url.endsWith('/v1/oauth2/token'),
        );
        assert.equal(
          Buffer.from(
            tokenCall.headers.get('authorization').replace(/^Basic /, ''),
            'base64',
          ).toString(),
          `${sandboxEnv.PAYPAL_CLIENT_ID}:${sandboxEnv.PAYPAL_CLIENT_SECRET}`,
        );
        const path = `/approvals/${pending.approval_id}`;
        const detail = (await f.http(path, 'GET', undefined, token)).body;
        assert.equal(detail.context.amount.value, '60.00');
        assert.equal(detail.context.customer.id, 'demo-customer');
        assert.equal(detail.context.merchant.id, 'demo-merchant');
        const decision = { decision: 'approve', args_hash: detail.args_hash };
        await Promise.all(
          Array.from({ length: 3 }, () =>
            f.http(path + '/decision', 'POST', decision, token),
          ),
        );
        const repeat = await f.http(
          path + '/decision',
          'POST',
          decision,
          token,
        );
        assert.equal(repeat.status, 200);
        assert.equal(repeat.body.execution_state, 'succeeded');
        assert.equal(repeat.body.result.status, 'COMPLETED');
        const posts = f.provider.refundPosts();
        assert.equal(posts.length, 1);
        assert.equal(
          posts[0].url,
          'https://api-m.sandbox.paypal.com/v2/payments/captures/DEMO_CAPTURE_00002/refund',
        );
        assert.equal(
          posts[0].headers.get('paypal-request-id'),
          repeat.body.execution_id,
        );
        assert.equal(f.demo.executions(), 1);
        const status = await f.demo.status(pending.approval_id);
        const line = sandboxResultLine(status, f.demo.executions());
        assert.equal(
          line,
          `SANDBOX REFUND RESULT: approval=approved; execution=succeeded; refund=${status.result.id} COMPLETED; sandbox refund submissions=1`,
        );
        for (const secret of [
          'demo-customer',
          sandboxEnv.PAYPAL_CLIENT_ID,
          sandboxEnv.PAYPAL_CLIENT_SECRET,
          'synthetic-demo-token',
        ])
          assert.equal(line.includes(secret), false);
      },
    );
    await t.test(
      'a 401 on the refund POST is retried once under the same execution ID and counts as one submission',
      async (t) => {
        const f = await sandboxFixture(url, t, undefined, {
          unauthorizedRefunds: 1,
        });
        const token = await f.register();
        const pending = await f.demo.request();
        const tokensBefore = f.provider.tokenPosts().length;
        const path = `/approvals/${pending.approval_id}`;
        const detail = (await f.http(path, 'GET', undefined, token)).body;
        const reply = await f.http(
          path + '/decision',
          'POST',
          { decision: 'approve', args_hash: detail.args_hash },
          token,
        );
        assert.equal(reply.status, 200);
        assert.equal(reply.body.execution_state, 'succeeded');
        assert.equal(reply.body.result.status, 'COMPLETED');
        const posts = f.provider.refundPosts();
        assert.equal(posts.length, 2);
        for (const post of posts)
          assert.equal(
            post.headers.get('paypal-request-id'),
            reply.body.execution_id,
          );
        // The 401 invalidated the token, so the retry fetched a new one.
        assert.equal(f.provider.tokenPosts().length, tokensBefore + 1);
        assert.equal(f.demo.executions(), 1);
      },
    );
    await t.test(
      'an order response without a refunds key still reaches approval and one refund',
      async (t) => {
        const f = await sandboxFixture(url, t, undefined, {
          omitEmptyRefunds: true,
        });
        const token = await f.register();
        const pending = await f.demo.request();
        assert.equal(pending.status, 'pending_approval');
        const path = `/approvals/${pending.approval_id}`;
        const detail = (await f.http(path, 'GET', undefined, token)).body;
        assert.equal(detail.context.amount.value, '60.00');
        const reply = await f.http(
          path + '/decision',
          'POST',
          { decision: 'approve', args_hash: detail.args_hash },
          token,
        );
        assert.equal(reply.status, 200);
        assert.equal(reply.body.execution_state, 'succeeded');
        assert.equal(reply.body.result.status, 'COMPLETED');
        const posts = f.provider.refundPosts();
        assert.equal(posts.length, 1);
        assert.equal(
          posts[0].headers.get('paypal-request-id'),
          reply.body.execution_id,
        );
        assert.equal(f.demo.executions(), 1);
      },
    );
    for (const scenario of ['deny', 'expiry']) {
      await t.test(`${scenario} submits no sandbox refund`, async (t) => {
        const f = await sandboxFixture(url, t);
        const token = await f.register();
        const pending = await f.demo.request();
        const path = `/approvals/${pending.approval_id}`;
        const detail = (await f.http(path, 'GET', undefined, token)).body;
        if (scenario === 'expiry') f.setTime(Date.parse(detail.expires_at));
        const reply = await f.http(
          path + '/decision',
          'POST',
          {
            decision: scenario === 'deny' ? 'deny' : 'approve',
            args_hash: detail.args_hash,
          },
          token,
        );
        assert.equal(reply.status, scenario === 'deny' ? 200 : 409);
        const status = await f.demo.status(pending.approval_id);
        assert.equal(status.status, scenario === 'deny' ? 'denied' : 'expired');
        assert.equal(status.execution_id, null);
        assert.equal(f.provider.refundPosts().length, 0);
        assert.equal(f.demo.executions(), 0);
        assert.equal(
          sandboxResultLine(status, 0),
          `SANDBOX REFUND RESULT: approval=${status.status}; execution=none; refund=none; sandbox refund submissions=0`,
        );
      });
    }
    await t.test(
      'a capture fully refunded before approval is refused at refresh without a refund',
      async (t) => {
        const f = await sandboxFixture(url, t);
        const token = await f.register();
        const pending = await f.demo.request();
        const path = `/approvals/${pending.approval_id}`;
        const detail = (await f.http(path, 'GET', undefined, token)).body;
        // Refund the capture outside the composition, under another request ID.
        const outside = await f.provider.payment.fetchImpl(
          'https://api-m.sandbox.paypal.com/v2/payments/captures/DEMO_CAPTURE_00002/refund',
          {
            method: 'POST',
            headers: { 'PayPal-Request-Id': randomBytes(16).toString('hex') },
            body: JSON.stringify({
              amount: { value: '60.00', currency_code: 'USD' },
            }),
          },
        );
        assert.equal((await outside.json()).status, 'COMPLETED');
        // The provider state is consistent: fully refunded, nothing remaining.
        const facts = await readRefund(
          async (resource) =>
            (
              await f.provider.payment.fetchImpl(
                'https://api-m.sandbox.paypal.com' + resource,
              )
            ).json(),
          'DEMO_CAPTURE_00002',
          'demo-merchant',
        );
        assert.equal(facts.status, 'REFUNDED');
        assert.equal(facts.remaining.minor, 0n);
        const reply = await f.http(
          path + '/decision',
          'POST',
          { decision: 'approve', args_hash: detail.args_hash },
          token,
        );
        assert.equal(reply.status, 503);
        const status = await f.demo.status(pending.approval_id);
        assert.equal(status.status, 'pending');
        assert.equal(status.execution_state, null);
        assert.equal(f.provider.refundPosts().length, 0);
        assert.equal(f.demo.executions(), 0);
      },
    );
    await t.test(
      'a capture at or below USD 20 is allowed by policy and creates no approval or refund',
      async (t) => {
        const f = await sandboxFixture(url, t, 'DEMO_CAPTURE_00001');
        await f.register();
        const result = await f.demo.request();
        assert.equal(result.decision, 'allow');
        assert.equal('approval_id' in result, false);
        await f.demo.drainNotifications();
        assert.equal(f.notifications.length, 0);
        assert.equal(f.provider.refundPosts().length, 0);
      },
    );
    await t.test(
      'a payer other than the order payer cannot create an approval',
      async (t) => {
        const provider = sandboxProvider();
        const f = await fixture(url, t, {
          paypal: {
            sandbox: {
              captureId: 'DEMO_CAPTURE_00002',
              payerId: 'unrelated-sandbox-payer',
              merchantId: 'demo-merchant',
              merchantEmail: 'merchant@example.test',
            },
            fetchImpl: provider.fetchImpl,
            env: sandboxEnv,
          },
        });
        await f.register();
        await assert.rejects(f.demo.request(), /context unavailable/i);
        assert.equal(provider.refundPosts().length, 0);
      },
    );
  });
});

for (const mode of ['synthetic', 'sandbox'])
  test(
    mode === 'synthetic'
      ? 'recording CLI waits for HTTP approval and prints only synthetic results; it reads no PayPal env and makes no fetch'
      : 'sandbox recording CLI waits for HTTP approval and prints only the sandbox refund result',
    async (t) => {
      const sandbox = mode === 'sandbox';
      const directory = await mkdtemp(
        join(tmpdir(), 'spendwall-recording-cli-'),
      );
      t.after(() => rm(directory, { recursive: true, force: true }));
      const configFile = join(directory, 'config.json');
      const trapLog = join(directory, 'trap.log');
      const config = {
        ...(sandbox
          ? {
              sandbox: {
                captureId: 'DEMO_CAPTURE_00002',
                payerId: 'demo-customer',
                merchantId: 'demo-merchant',
                merchantEmail: 'merchant@example.test',
              },
            }
          : {}),
        identityKey: randomBytes(32).toString('hex'),
        signingKey: randomBytes(32).toString('hex'),
        devices: [
          {
            deviceId: 'synthetic-cli-device',
            agentId,
            enrollmentHash: createHash('sha256')
              .update(enrollment)
              .digest('hex'),
          },
        ],
      };
      await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
      const child = spawn(
        process.execPath,
        [
          '--import',
          preload,
          'apps/agent-demo/src/recording-index.ts',
          configFile,
          ...(sandbox ? ['--paypal-sandbox'] : []),
        ],
        {
          cwd: new URL('../', import.meta.url),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            NO_COLOR: '1',
            SPENDWALL_TRAP_LOG: trapLog,
            // Present in both modes: the default mode must ignore ambient keys.
            ...sandboxEnv,
            ...(sandbox ? { SPENDWALL_FAKE_SANDBOX: '1' } : {}),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const exited = new Promise((resolve, reject) => {
        child.on('exit', resolve);
        child.on('error', reject);
      });
      t.after(async () => {
        if (child.exitCode === null) child.kill('SIGTERM');
        await exited;
      });
      let output = '',
        errors = '';
      child.stdout.on('data', (part) => (output += part));
      child.stderr.on('data', (part) => (errors += part));
      async function until(pattern) {
        const deadline = Date.now() + 20_000;
        while (!pattern.test(output)) {
          assert.equal(child.exitCode, null, errors);
          assert.ok(
            Date.now() < deadline,
            'Timed out waiting for recording CLI: ' + output + errors,
          );
          await delay(20);
        }
        return pattern.exec(output);
      }
      const [, origin] = await until(
        /Approval API: (http:\/\/127\.0\.0\.1:\d+)/,
      );
      const registered = await fetch(origin + '/devices/register', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${enrollment}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          device_id: 'synthetic-cli-device',
          fcm_token: 'synthetic-cli-fcm-address',
        }),
      });
      assert.equal(registered.status, 201);
      const token = (await registered.json()).access_token;
      const [, id] = await until(
        sandbox
          ? /pending_approval: ([a-f0-9-]+); sandbox refund submissions=0/
          : /pending_approval: ([a-f0-9-]+); synthetic executions=0/,
      );
      assert.equal(child.exitCode, null);
      const detail = await (
        await fetch(origin + '/approvals/' + id, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json();
      const approved = await fetch(origin + '/approvals/' + id + '/decision', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          decision: 'approve',
          args_hash: detail.args_hash,
        }),
      });
      assert.equal(
        approved.status,
        200,
        `${await approved.clone().text()}\n${output}${errors}`,
      );
      await until(/Result remains available until Ctrl\+C/);
      const final = await (
        await fetch(origin + '/approvals/' + id, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json();
      assert.equal(final.execution_state, 'succeeded');
      const repeated = await fetch(origin + '/approvals/' + id + '/decision', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          decision: 'approve',
          args_hash: detail.args_hash,
        }),
      });
      assert.equal((await repeated.json()).execution_id, final.execution_id);
      child.kill('SIGINT');
      assert.equal(await exited, 130, errors);
      assert.match(output, /NOTIFICATIONS DISABLED/);
      const trapped = await readFile(trapLog, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      if (sandbox) {
        assert.match(
          output,
          /^HUMAN APPROVAL RECORDING \/ PAYPAL SANDBOX REFUND \/ NO LIVE PAYPAL OR AI\n/,
        );
        assert.doesNotMatch(output, /SYNTHETIC/);
        assert.match(
          output,
          new RegExp(
            `SANDBOX REFUND RESULT: approval=approved; execution=succeeded; refund=${final.result.id} COMPLETED; sandbox refund submissions=1`,
          ),
        );
        // Exactly one refund submission reached the (fake) sandbox network.
        assert.equal(
          trapped
            .split('\n')
            .filter(
              (line) =>
                line.startsWith('fetch POST') && line.endsWith('/refund'),
            ).length,
          1,
        );
        assert.match(
          trapped,
          /^fetch POST https:\/\/api-m\.sandbox\.paypal\.com\/v1\/oauth2\/token$/m,
        );
        assert.doesNotMatch(
          trapped,
          /^fetch \S+ (?!https:\/\/api-m\.sandbox\.paypal\.com\/)/m,
        );
      } else {
        assert.match(output, /SYNTHETIC PAYMENTS/);
        assert.match(output, /synthetic executions=1/);
        assert.match(output, /"execution_state":"succeeded"/);
        // Default mode: no PAYPAL_* lookup and no global fetch in the CLI process.
        assert.equal(trapped, '');
      }
      for (const secret of [
        enrollment,
        config.identityKey,
        config.signingKey,
        token,
        sandboxEnv.PAYPAL_CLIENT_ID,
        sandboxEnv.PAYPAL_CLIENT_SECRET,
        ...(sandbox ? [config.sandbox.payerId, 'synthetic-demo-token'] : []),
      ]) {
        assert.equal((output + errors).includes(secret), false);
      }
    },
  );

test('the recording preload trap records PayPal env lookups and global fetch', async (t) => {
  // Negative control for the default-mode assertion above: the trap must see
  // both kinds of access when they happen.
  const directory = await mkdtemp(join(tmpdir(), 'spendwall-trap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trapLog = join(directory, 'trap.log');
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      preload,
      '--input-type=module',
      '-e',
      "void process.env.PAYPAL_CLIENT_ID; 'PAYPAL_CLIENT_SECRET' in process.env; await fetch('data:,x');",
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SPENDWALL_TRAP_LOG: trapLog },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readFile(trapLog, 'utf8')).trim().split('\n'), [
    'env PAYPAL_CLIENT_ID',
    'env PAYPAL_CLIENT_SECRET',
    'fetch GET null,x',
  ]);
});

test('the recording preload trap records first-party reads and listing of present PayPal keys but not third-party listing or child env inheritance', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'spendwall-trap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = async (name, script) => {
    const trapLog = join(directory, `${name}.log`);
    const result = spawnSync(
      process.execPath,
      ['--import', preload, '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          SPENDWALL_TRAP_LOG: trapLog,
          PAYPAL_CLIENT_ID: sandboxEnv.PAYPAL_CLIENT_ID,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return readFile(trapLog, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
  };
  // Enumeration reads the present key, so each one is recorded.
  assert.match(
    await run('spread', 'void { ...process.env };'),
    /^env PAYPAL_CLIENT_ID$/m,
  );
  assert.match(
    await run('entries', 'void Object.entries(process.env);'),
    /^env PAYPAL_CLIENT_ID$/m,
  );
  assert.match(
    await run(
      'values',
      'for (const key of Object.keys(process.env)) void process.env[key];',
    ),
    /^env PAYPAL_CLIENT_ID$/m,
  );
  assert.match(
    await run('own', "void Object.hasOwn(process.env, 'PAYPAL_CLIENT_ID');"),
    /^env PAYPAL_CLIENT_ID$/m,
  );
  // Object.keys from first-party code is recorded; only a node_modules caller
  // (the `debug` package at load) is exempt.
  assert.match(
    await run('keys', 'void Object.keys(process.env);'),
    /^env PAYPAL_CLIENT_ID$/m,
  );
  // A child that inherits the environment (the recording's Docker CLI calls)
  // is exempt.
  assert.equal(
    await run(
      'spawn',
      "import { spawnSync } from 'node:child_process'; spawnSync(process.execPath, ['-e', '']);",
    ),
    '',
  );
});

test('recording CLI rejects unsupported options before creating resources', () => {
  const result = spawnSync(
    process.execPath,
    ['apps/agent-demo/src/recording-index.ts', '--live'],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

for (const extra of [
  ['--paypal-sandbox', '--paypal-sandbox'],
  ['--fcm'],
  ['--fcm', '--paypal-sandbox'],
  ['--fcm', 'project-a', '--fcm', 'project-b'],
  ['--paypal-sandbox', '--live'],
  ['--sandbox'],
  ['project-a'],
]) {
  test(`recording CLI rejects arguments ${extra.join(' ')} with usage`, () => {
    const result = spawnSync(
      process.execPath,
      [
        'apps/agent-demo/src/recording-index.ts',
        '/private/config.json',
        ...extra,
      ],
      // Missing Docker is deliberate: usage errors precede any resource.
      { cwd: new URL('../', import.meta.url), encoding: 'utf8', env: {} },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /^Usage: pnpm demo:recording \/absolute\/private\/config\.json \[--fcm project-id\] \[--paypal-sandbox\]\n$/,
    );
  });
}

const sandboxTarget = {
  captureId: 'DEMO_CAPTURE_00002',
  payerId: 'demo-customer',
  merchantId: 'demo-merchant',
  merchantEmail: 'merchant@example.test',
};
for (const [name, withSandbox, extra, env, starts] of [
  [
    'the flag without a sandbox object',
    false,
    ['--paypal-sandbox'],
    sandboxEnv,
    false,
  ],
  ['a sandbox object without the flag', true, [], sandboxEnv, false],
  [
    'the flag without sandbox credentials',
    true,
    ['--paypal-sandbox'],
    {},
    false,
  ],
  [
    'the flag with only a blank secret',
    true,
    ['--paypal-sandbox'],
    { PAYPAL_CLIENT_ID: 'sandbox-test-client-id', PAYPAL_CLIENT_SECRET: ' ' },
    false,
  ],
  // Positive control: the same checks pass, so the run reaches Docker (absent
  // here) after printing the sandbox banner. Both option orders parse.
  [
    'a paired flag and credentials',
    true,
    ['--paypal-sandbox', '--fcm', 'project-a'],
    sandboxEnv,
    true,
  ],
  [
    'a paired flag after --fcm',
    true,
    ['--fcm', 'project-a', '--paypal-sandbox'],
    sandboxEnv,
    true,
  ],
]) {
  test(`recording CLI with ${name} ${starts ? 'passes the sandbox checks' : 'fails before Docker'}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'spendwall-sandbox-pair-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const configFile = join(directory, 'config.json');
    const config = {
      identityKey: '1'.repeat(64),
      signingKey: '2'.repeat(64),
      devices: [],
      ...(withSandbox ? { sandbox: sandboxTarget } : {}),
    };
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      ['apps/agent-demo/src/recording-index.ts', configFile, ...extra],
      {
        cwd: new URL('../', import.meta.url),
        encoding: 'utf8',
        timeout: 10_000,
        // Missing Docker is deliberate: only the positive control gets far
        // enough to print the banner and then fail to provision a database.
        env: { PATH: directory, ...env },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Recording unavailable\./);
    if (starts)
      assert.match(
        result.stdout,
        /^HUMAN APPROVAL RECORDING \/ PAYPAL SANDBOX REFUND \/ NO LIVE PAYPAL OR AI\nFCM EXPLICITLY ENABLED/,
      );
    else assert.equal(result.stdout, '');
    for (const secret of [
      ...Object.values(sandboxTarget),
      ...Object.values(sandboxEnv),
      directory,
    ])
      assert.equal((result.stdout + result.stderr).includes(secret), false);
  });
}

test('sandbox recording CLI reports a capture that needs no approval and creates no refund', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'spendwall-sandbox-allow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = join(directory, 'config.json');
  const trapLog = join(directory, 'trap.log');
  const config = {
    identityKey: randomBytes(32).toString('hex'),
    signingKey: randomBytes(32).toString('hex'),
    devices: [
      {
        deviceId: 'synthetic-cli-device',
        agentId,
        enrollmentHash: createHash('sha256').update(enrollment).digest('hex'),
      },
    ],
    // USD 10.00 in the fixture: the policy allows it without approval.
    sandbox: { ...sandboxTarget, captureId: 'DEMO_CAPTURE_00001' },
  };
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      '--import',
      preload,
      'apps/agent-demo/src/recording-index.ts',
      configFile,
      '--paypal-sandbox',
    ],
    {
      cwd: new URL('../', import.meta.url),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SPENDWALL_TRAP_LOG: trapLog,
        SPENDWALL_FAKE_SANDBOX: '1',
        ...sandboxEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise((resolve, reject) => {
    child.on('exit', resolve);
    child.on('error', reject);
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  });
  let output = '',
    errors = '';
  child.stdout.on('data', (part) => (output += part));
  child.stderr.on('data', (part) => (errors += part));
  const deadline = Date.now() + 20_000;
  let origin;
  while (!(origin = /Approval API: (http:\/\/127\.0\.0\.1:\d+)/.exec(output))) {
    assert.equal(child.exitCode, null, errors);
    assert.ok(Date.now() < deadline, 'Recording server did not start.');
    await delay(20);
  }
  const registered = await fetch(origin[1] + '/devices/register', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${enrollment}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      device_id: 'synthetic-cli-device',
      fcm_token: 'synthetic-cli-fcm-address',
    }),
  });
  assert.equal(registered.status, 201);
  assert.equal(await exited, 1, errors);
  assert.equal(
    errors,
    'Recording policy did not require approval; no sandbox refund was created.\n',
  );
  assert.doesNotMatch(output, /pending_approval|SANDBOX REFUND RESULT/);
  const trapped = await readFile(trapLog, 'utf8');
  assert.match(trapped, /\/v2\/payments\/captures\/DEMO_CAPTURE_00001$/m);
  assert.doesNotMatch(trapped, /\/refund$/m);
  const containers = execFileSync(
    'docker',
    ['ps', '-aq', '--filter', `label=spendwall.demo.pid=${child.pid}`],
    { encoding: 'utf8' },
  );
  assert.equal(containers.trim(), '');
});

for (const mode of [0o644, 0o640, 0o604, 0o620, 0o601]) {
  test(`recording CLI refuses unsafe config mode ${mode.toString(8)} before creating resources`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'spendwall-config-mode-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const configFile = join(directory, 'config.json');
    const config = {
      identityKey: '1'.repeat(64),
      signingKey: '2'.repeat(64),
      devices: [],
    };
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    await chmod(configFile, mode);
    const result = spawnSync(
      process.execPath,
      ['apps/agent-demo/src/recording-index.ts', configFile],
      {
        cwd: new URL('../', import.meta.url),
        encoding: 'utf8',
        timeout: 10_000,
        // Missing Docker is deliberate: rejection must occur before the banner
        // or any attempt to provision a database.
        env: { PATH: directory },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Recording unavailable\./);
    for (const secret of [config.identityKey, config.signingKey])
      assert.equal((result.stdout + result.stderr).includes(secret), false);
    assert.equal((await stat(configFile)).mode & 0o777, mode);
  });
}

for (const change of ['permissions', 'symlink', 'directory']) {
  test(
    `devices reload refuses changed config ${change} and cleans its container`,
    { timeout: 25_000 },
    async (t) => {
      const directory = await mkdtemp(
        join(tmpdir(), 'spendwall-config-reload-'),
      );
      t.after(() => rm(directory, { recursive: true, force: true }));
      const configFile = join(directory, 'config.json');
      const config = {
        identityKey: '1'.repeat(64),
        signingKey: '2'.repeat(64),
        devices: [],
      };
      await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
      const child = spawn(
        process.execPath,
        ['apps/agent-demo/src/recording-index.ts', configFile],
        {
          cwd: new URL('../', import.meta.url),
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const exited = new Promise((resolve, reject) => {
        child.on('exit', resolve);
        child.on('error', reject);
      });
      t.after(async () => {
        if (child.exitCode === null) child.kill('SIGTERM');
        await exited;
      });
      let output = '',
        errors = '';
      child.stdout.on('data', (part) => (output += part));
      child.stderr.on('data', (part) => (errors += part));
      const deadline = Date.now() + 15_000;
      while (!/Approval API: http:\/\/127\.0\.0\.1:\d+/.test(output)) {
        assert.equal(child.exitCode, null, errors);
        assert.ok(Date.now() < deadline, 'Recording server did not start.');
        await delay(20);
      }
      if (change === 'permissions') await chmod(configFile, 0o644);
      else {
        const original = join(directory, 'original.json');
        await rename(configFile, original);
        if (change === 'symlink') await symlink(original, configFile);
        else await mkdir(configFile, { mode: 0o700 });
      }
      assert.equal(await exited, 1, errors);
      assert.doesNotMatch(output, /pending_approval|SYNTHETIC REFUND RESULT/);
      assert.match(errors, /^Recording unavailable\./);
      for (const secret of [config.identityKey, config.signingKey])
        assert.equal((output + errors).includes(secret), false);
      const containers = execFileSync(
        'docker',
        ['ps', '-aq', '--filter', `label=spendwall.demo.pid=${child.pid}`],
        { encoding: 'utf8' },
      );
      assert.equal(containers.trim(), '');
      if (change === 'permissions')
        assert.equal((await stat(configFile)).mode & 0o777, 0o644);
    },
  );
}
