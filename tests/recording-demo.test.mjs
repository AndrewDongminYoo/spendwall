import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { withDemoDatabase } from '../apps/agent-demo/src/database.ts';
import { createRecordingDemo } from '../apps/agent-demo/src/recording.ts';

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

test('recording CLI waits for HTTP approval and prints only synthetic results', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'spendwall-recording-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = join(directory, 'config.json');
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
  };
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    ['apps/agent-demo/src/recording-index.ts', configFile],
    {
      cwd: new URL('../', import.meta.url),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' },
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
  const [, origin] = await until(/Approval API: (http:\/\/127\.0\.0\.1:\d+)/);
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
    /pending_approval: ([a-f0-9-]+); synthetic executions=0/,
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
    body: JSON.stringify({ decision: 'approve', args_hash: detail.args_hash }),
  });
  assert.equal(approved.status, 200);
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
    body: JSON.stringify({ decision: 'approve', args_hash: detail.args_hash }),
  });
  assert.equal((await repeated.json()).execution_id, final.execution_id);
  child.kill('SIGINT');
  assert.equal(await exited, 130, errors);
  assert.match(output, /SYNTHETIC PAYMENTS/);
  assert.match(output, /NOTIFICATIONS DISABLED/);
  assert.match(output, /synthetic executions=1/);
  assert.match(output, /"execution_state":"succeeded"/);
  for (const secret of [
    enrollment,
    config.identityKey,
    config.signingKey,
    token,
  ]) {
    assert.equal((output + errors).includes(secret), false);
  }
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
