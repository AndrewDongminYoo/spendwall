import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const args = process.argv.slice(2);
if (
  args.length > 1 ||
  (args.length === 1 &&
    ![
      '--approval-api',
      '--reconciliation',
      '--invoice-policy',
      '--orders',
      '--dispute-alerts',
    ].includes(args[0]))
) {
  console.error(
    'Usage: node scripts/test-audit-postgres.mjs [--approval-api|--reconciliation|--invoice-policy|--orders|--dispute-alerts]',
  );
  process.exit(2);
}
const testFiles =
  args[0] === '--dispute-alerts'
    ? ['tests/dispute-alerts-postgres.test.mjs']
    : args[0] === '--orders'
      ? ['tests/orders-postgres.test.mjs']
      : args[0] === '--invoice-policy'
        ? ['tests/invoice-policy-postgres.test.mjs']
        : args[0] === '--approval-api'
          ? ['tests/approval-api-postgres.test.mjs']
          : args[0] === '--reconciliation'
            ? ['tests/reconciliation-postgres.test.mjs']
            : [
                'tests/audit-postgres.test.mjs',
                'tests/velocity-postgres.test.mjs',
                'tests/approvals-postgres.test.mjs',
                'tests/approval-api-postgres.test.mjs',
                'tests/dashboard-postgres.test.mjs',
                'tests/agent-auth-postgres.test.mjs',
                'tests/policy-preview-postgres.test.mjs',
                'tests/hosting-postgres.test.mjs',
                'tests/reconciliation-postgres.test.mjs',
                'tests/invoice-policy-postgres.test.mjs',
                'tests/orders-postgres.test.mjs',
                'tests/dispute-alerts-postgres.test.mjs',
              ];
const name = `spendwall-audit-test-${randomUUID()}`;
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(
      `Docker ${args[0]} failed; a local Docker daemon and postgres:17-alpine are required.`,
    );
  return result.stdout.trim();
}
let started = false;
try {
  docker(
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '-e',
    'POSTGRES_USER=audit_test_owner',
    '-e',
    'POSTGRES_PASSWORD=audit-test-only',
    '-e',
    'POSTGRES_DB=spendwall_audit_test',
    '-p',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  );
  started = true;
  const port = docker('port', name, '5432/tcp').split(':').at(-1);
  const url = `postgresql://audit_test_owner:audit-test-only@127.0.0.1:${port}/spendwall_audit_test`;
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
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!ready)
      throw new Error('Disposable audit Postgres did not become ready.');
  } finally {
    await pool.end();
  }
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', ...testFiles],
      {
        stdio: 'inherit',
        env: { ...process.env, AUDIT_TEST_DATABASE_URL: url },
      },
    );
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (started) docker('rm', '-f', name);
}
