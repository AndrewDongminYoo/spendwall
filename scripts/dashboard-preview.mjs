import { VelocityPolicy } from '../apps/firewall/src/velocity/index.ts';
import { PolicyReplay } from '../apps/firewall/src/policy-preview/replay.ts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { auditPrompts } from '../apps/firewall/src/dashboard/query-contract.ts';
import {
  dashboardFixture,
  policy,
  request,
  token,
} from '../tests/helpers/dashboard-fixture.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--empty')) {
  console.error('Usage: pnpm dashboard:preview [--empty]');
  process.exit(2);
}
const name = `spendwall-dashboard-preview-${randomUUID()}`;
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error('Disposable dashboard database unavailable.');
  return result.stdout.trim();
}
let started = false,
  fixture,
  closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    await fixture?.close();
  } finally {
    if (started) docker('rm', '-f', name);
  }
}
try {
  docker(
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '-e',
    'POSTGRES_USER=dashboard_test_owner',
    '-e',
    'POSTGRES_PASSWORD=dashboard-test-only',
    '-e',
    'POSTGRES_DB=spendwall_audit_test',
    '-p',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  );
  started = true;
  const port = docker('port', name, '5432/tcp').split(':').at(-1),
    url = `postgresql://dashboard_test_owner:dashboard-test-only@127.0.0.1:${port}/spendwall_audit_test`;
  const pool = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis: 1000,
  });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await pool.query('SELECT 1');
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!ready) throw new Error();
  } finally {
    await pool.end();
  }
  fixture = await dashboardFixture(
    url,
    fileURLToPath(new URL('../apps/dashboard/dist', import.meta.url)),
    {
      policyPreview: {
        replay: new PolicyReplay('9'.repeat(64)),
        loadPolicy: async () => `agents:
  support:
    tools: {allow: [create_refund], deny: []}
  returns:
    tools: {allow: [create_refund], deny: []}
rules:
  - id: refund-review
    when: "true"
    then: allow
default: deny
`,
        generate: async ({ baseYaml, instruction }) => ({
          yaml: instruction.includes('invalid')
            ? 'default: allow'
            : baseYaml.replace(
                'rules:\n',
                'rules:\n  - id: customer-review\n    when: "agg.customer_refund_count_7d >= 2"\n    then: require_approval\n',
              ),
        }),
        mode: 'synthetic',
      },
      queryMode: 'synthetic',
      classify: async (question) => ({
        intent:
          auditPrompts.find((entry) => entry.prompt === question)?.intent ??
          'unsupported',
      }),
    },
  );
  if (args[0] !== '--empty') {
    await new VelocityPolicy(fixture.app, {
      identityKey: '7'.repeat(64),
    }).evaluateAndReserve(policy('deny'), request('10.00'));
    await fixture.addPending('60.00');
    await fixture.addPending('35.00', 'returns');
    const completed = await fixture.addPending('25.00');
    await fixture.approve(completed);
    await fixture.velocity.evaluateAndReserve(
      policy('allow'),
      request('12.00'),
    );
    await fixture.velocity.evaluateAndReserve(policy('deny'), request('95.00'));
    await fixture.velocity.evaluateAndReserve(
      policy('deny'),
      request('120.00', 'returns'),
    );
  }
  console.log(
    `Synthetic local preview: ${fixture.server.url}\nDisposable test token: ${token}\nDatabase: ${name}\nNo PayPal or model requests. Stop with Ctrl+C to remove this preview database.`,
  );
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
} catch {
  console.error('Dashboard preview failed.');
  await close();
  process.exitCode = 1;
}
