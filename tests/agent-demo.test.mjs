import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { withDemoDatabase } from '../apps/agent-demo/src/database.ts';
import { createDemo, readTicket } from '../apps/agent-demo/src/firewall.ts';
import { connectRecorded } from '../apps/agent-demo/src/runner.ts';
import { agentOptions, runLive } from '../apps/agent-demo/src/agent.ts';

const root = new URL('../', import.meta.url);
test('recorded demo executes four scenarios and reports firewall outcomes', () => {
  const result = spawnSync(
    process.execPath,
    ['apps/agent-demo/src/index.ts', 'all'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /small: PASS.*payments=1/);
  assert.match(result.stdout, /approval: PASS.*payments=1/);
  assert.match(result.stdout, /injection: PASS.*payments=0/);
  assert.match(result.stdout, /velocity: PASS.*payments=2/);
  assert.match(result.stdout, /pending_approval/);
  assert.match(result.stdout, /ticket_scope/);
  assert.match(result.stdout, /velocity_limit/);
  assert.doesNotMatch(result.stdout, /\u001b\[/);
});

test('unknown scenarios fail before provisioning resources', () => {
  const result = spawnSync(
    process.execPath,
    ['apps/agent-demo/src/index.ts', 'missing'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test('live mode requires an explicit API key before provisioning resources', () => {
  const result = spawnSync(
    process.execPath,
    ['apps/agent-demo/src/index.ts', 'small', '--live'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ANTHROPIC_API_KEY/);
});

test('firewall keeps approval authority and ticket identity outside MCP', async () => {
  await withDemoDatabase(async (url) => {
    const demo = await createDemo(url, await readTicket('approval'));
    const client = await connectRecorded(demo);
    try {
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
        ['check_approval', 'create_refund'],
      );
      const request = await client.callTool({
        name: 'create_refund',
        arguments: { capture_id: 'DEMO_CAPTURE_00002' },
      });
      const id = request.structuredContent.approval_id;
      assert.equal(request.structuredContent.status, 'pending_approval');
      assert.equal(demo.payments.length, 0);
      const selfApprove = await client.callTool({
        name: 'approve',
        arguments: { approval_id: id },
      });
      assert.equal(selfApprove.isError, true);
      for (let i = 0; i < 2; i++) {
        const check = await client.callTool({
          name: 'check_approval',
          arguments: { approval_id: id },
        });
        assert.equal(check.structuredContent.status, 'pending');
      }
      assert.equal(
        demo.payments.length,
        0,
        'Polling must not execute a payment',
      );
      const approved = await demo.humanDecision(id, 'approve');
      assert.equal(approved.execution_state, 'succeeded');
      assert.equal(demo.payments.length, 1);
      await assert.rejects(demo.humanDecision(id, 'approve'));
      assert.equal(demo.payments.length, 1);
    } finally {
      await client.close();
      await demo.close();
    }

    const ticket = await readTicket('small');
    ticket.customerId = 'unrelated-customer';
    const other = await createDemo(url, ticket);
    const otherClient = await connectRecorded(other);
    try {
      const result = await otherClient.callTool({
        name: 'create_refund',
        arguments: { capture_id: 'DEMO_CAPTURE_00001' },
      });
      assert.equal(result.structuredContent.decision, 'deny');
      assert.equal(
        other.payments.length,
        0,
        'Authoritative payer mismatch must prevent execution',
      );
    } finally {
      await otherClient.close();
      await other.close();
    }
  });
});

test('persisted velocity rejects one of three simultaneous valid refunds', async () => {
  await withDemoDatabase(async (url) => {
    const demo = await createDemo(url, await readTicket('velocity'));
    const client = await connectRecorded(demo);
    try {
      const results = await Promise.all(
        demo.ticket.recordedCalls.map((args) =>
          client.callTool({ name: 'create_refund', arguments: args }),
        ),
      );
      assert.deepEqual(
        results.map((v) => v.structuredContent.decision).sort(),
        ['allow', 'allow', 'deny'],
      );
      assert.equal(demo.payments.length, 2);
      assert.ok(
        demo.events.some(
          (event) =>
            event.decision === 'deny' &&
            event.reason.includes('velocity_limit'),
        ),
      );
    } finally {
      await client.close();
      await demo.close();
    }
  });
});

test('SDK runner isolates ambient settings and rejects incomplete model streams', async () => {
  const ticket = await readTicket('small');
  const demo = {
    ticket,
    server: { type: 'sdk', name: 'firewall', instance: {} },
  };
  const options = agentOptions(
    demo,
    '/tmp/synthetic-agent-home',
    'synthetic-api-key',
  );
  assert.deepEqual(options.tools, []);
  assert.deepEqual(Object.keys(options.mcpServers), ['firewall']);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.plugins, []);
  assert.equal(options.permissionMode, 'dontAsk');
  assert.equal(options.env.HOME, '/tmp/synthetic-agent-home');
  assert.equal(options.env.PAYPAL_CLIENT_SECRET, undefined);
  const hook = options.hooks.PreToolUse[0].hooks[0];
  for (const tool of [
    'Bash',
    'Read',
    'Agent',
    'mcp__paypal__create_refund',
    'mcp__firewall__approve',
  ]) {
    assert.equal(
      (await hook({ hook_event_name: 'PreToolUse', tool_name: tool }))
        .hookSpecificOutput.permissionDecision,
      'deny',
    );
  }
  assert.deepEqual(
    await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__firewall__create_refund',
    }),
    {},
  );
  let directory,
    closed = false;
  const incomplete = ({ options }) => {
    directory = options.cwd;
    const stream = (async function* () {})();
    stream.close = () => {
      closed = true;
    };
    return stream;
  };
  await assert.rejects(
    runLive(demo, 'synthetic-api-key', () => {}, incomplete),
    /without a result/,
  );
  assert.equal(closed, true);
  await assert.rejects(access(directory));
});

test('an interrupted database run cannot report successful completion', async () => {
  const controller = new AbortController();
  await assert.rejects(
    withDemoDatabase(async () => {
      controller.abort();
      return 'incorrect success';
    }, controller.signal),
    { name: 'AbortError' },
  );
});

for (const [signal, expectedCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(
    `CLI ${signal} cleans its container before exit`,
    { timeout: 20_000 },
    async (t) => {
      const child = spawn(
        process.execPath,
        ['apps/agent-demo/src/index.ts', 'all'],
        {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const ownedContainers = () => {
        const result = spawnSync(
          'docker',
          [
            'ps',
            '-a',
            '--filter',
            `label=spendwall.demo.pid=${child.pid}`,
            '--format',
            '{{.ID}}',
          ],
          { encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim().split('\n').filter(Boolean);
      };
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGTERM');
        for (const id of ownedContainers())
          spawnSync('docker', ['rm', '-f', id]);
      });
      let output = '',
        errors = '',
        interrupted = false;
      child.stdout.on('data', (data) => {
        output += data;
        // This marker is printed only after the database and ledger are open.
        if (!interrupted && output.includes('Ticket: small')) {
          interrupted = true;
          child.kill(signal);
        }
      });
      child.stderr.on('data', (data) => {
        errors += data;
      });
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (value) => resolve(value));
      });
      assert.equal(interrupted, true, errors);
      assert.equal(code, expectedCode, errors);
      assert.deepEqual(ownedContainers(), []);
    },
  );
}
