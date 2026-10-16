import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import pg from 'pg';
import {
  dashboardFixture,
  key,
  token,
  policy,
  request,
} from '../tests/helpers/dashboard-fixture.mjs';

const image = process.argv[2];
if (process.argv.length !== 3 || !image || image.startsWith('-')) {
  console.error('Usage: node scripts/hosting-smoke.mjs <local-image>');
  process.exit(2);
}
const suffix = randomUUID();
const dbName = `spendwall-hosting-db-${suffix}`;
const appName = `spendwall-hosting-app-${suffix}`;
const origin = 'https://dashboard.example.invalid';
const names = [];
let fixture, directory;
function docker(...args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (result.status !== 0)
    throw new Error(`Docker ${args[0]} failed: ${result.stderr?.trim() ?? ''}`);
  return result.stdout.trim();
}
function get(port, path, authenticated = true, host = new URL(origin).host) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `http://127.0.0.1:${port}${path}`,
      {
        headers: {
          host,
          ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        },
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
  });
}
async function waitFor(check) {
  let last;
  for (let i = 0; i < 40; i++) {
    try {
      await check();
      return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw last;
}
try {
  docker('image', 'inspect', image);
  docker(
    'run',
    '--rm',
    '--pull',
    'never',
    '--network',
    'none',
    image,
    'node',
    '--input-type=module',
    '-e',
    "await import('./apps/firewall/src/dashboard/server.ts')",
  );
  docker(
    'run',
    '--rm',
    '--pull',
    'never',
    '--network',
    'none',
    image,
    'node',
    '-e',
    "const fs=require('node:fs');const assert=require('node:assert/strict');assert.notEqual(process.getuid(),0);assert.equal(fs.existsSync('/app/.spendwall'),false);assert.equal(fs.existsSync('/app/.git'),false);assert.ok(fs.readFileSync('/app/apps/dashboard/dist/index.html','utf8').includes('/assets/'));assert.equal(fs.existsSync('/app/tests'),false)",
  );
  docker(
    'run',
    '-d',
    '--name',
    dbName,
    '-e',
    'POSTGRES_USER=audit_test_owner',
    '-e',
    'POSTGRES_PASSWORD=audit-test-only',
    '-e',
    'POSTGRES_DB=spendwall_audit_test',
    '-p',
    '127.0.0.1::5432',
    '-p',
    '127.0.0.1::10000',
    'postgres:17-alpine',
  );
  names.push(dbName);
  const dbPort = docker('port', dbName, '5432/tcp').split(':').at(-1);
  const appPort = docker('port', dbName, '10000/tcp').split(':').at(-1);
  const url = `postgresql://audit_test_owner:audit-test-only@127.0.0.1:${dbPort}/spendwall_audit_test`;
  const probe = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis: 1000,
  });
  try {
    await waitFor(() => probe.query('SELECT 1'));
  } finally {
    await probe.end();
  }
  fixture = await dashboardFixture(url);
  await fixture.owner.query(
    await readFile(new URL('./hosting-reader.sql', import.meta.url), 'utf8'),
  );
  await fixture.owner.query(
    "ALTER ROLE spendwall_dashboard_reader PASSWORD 'hosting-test-only'",
  );
  directory = await mkdtemp(join(tmpdir(), 'spendwall-hosting-'));
  const configFile = join(directory, 'dashboard.json');
  await writeFile(
    configFile,
    JSON.stringify({
      identityKey: key,
      token,
      merchantId: 'merchantA',
      databaseTls: 'disable',
    }),
    { mode: 0o644 },
  );
  const env = [
    '-e',
    'PORT=10000',
    '-e',
    `SPENDWALL_PUBLIC_ORIGIN=${origin}`,
    '-e',
    'SPENDWALL_DASHBOARD_CONFIG=/run/dashboard.json',
    '-e',
    'SPENDWALL_DASHBOARD_DATABASE_URL=postgresql://spendwall_dashboard_reader:hosting-test-only@127.0.0.1:5432/spendwall_audit_test',
  ];
  const run = () =>
    docker(
      'run',
      '-d',
      '--pull',
      'never',
      '--name',
      appName,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--network',
      `container:${dbName}`,
      '--mount',
      `type=bind,src=${configFile},dst=/run/dashboard.json,readonly`,
      ...env,
      image,
    );
  run();
  names.push(appName);
  const healthy = async () =>
    assert.deepEqual(await get(appPort, '/healthz', false), {
      status: 200,
      body: { ready: true },
    });
  await waitFor(healthy);
  assert.equal((await get(appPort, '/audit', false)).status, 401);
  assert.equal(
    (await get(appPort, '/audit', true, 'attacker.invalid')).status,
    403,
  );
  assert.deepEqual((await get(appPort, '/audit')).body.items, []);
  await fixture.velocity.evaluateAndReserve(policy('allow'), request('12.00'));
  const audit = await get(appPort, '/audit');
  assert.equal(audit.status, 200);
  assert.equal(audit.body.items.length, 1);
  assert.equal(audit.body.items[0].usd, 12);
  for (const path of [
    '/',
    '/assets/main.js',
    '/policy',
    '/query',
    '/mcp',
    '/approvals',
  ])
    assert.equal((await get(appPort, path)).status, 404);
  const before = (
    await fixture.owner.query(
      'SELECT count(*)::int AS n FROM audit.audit_events',
    )
  ).rows[0].n;
  docker('stop', '--time', '15', appName);
  assert.equal(
    docker('inspect', '--format', '{{.State.ExitCode}}', appName),
    '0',
  );
  docker('start', appName);
  await waitFor(healthy);
  assert.equal((await get(appPort, '/audit')).body.items.length, 1);
  assert.equal(
    (
      await fixture.owner.query(
        'SELECT count(*)::int AS n FROM audit.audit_events',
      )
    ).rows[0].n,
    before,
  );
  // A provider can terminate idle connections during failover or maintenance.
  await fixture.owner.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='spendwall_dashboard_reader'",
  );
  await waitFor(healthy);
  await fixture.owner.query(
    'GRANT UPDATE (approval_state) ON approvals.requests TO spendwall_dashboard_reader',
  );
  assert.deepEqual(await get(appPort, '/healthz', false), {
    status: 503,
    body: { ready: false },
  });
  docker('stop', '--time', '15', appName);
  docker('start', appName);
  assert.equal(
    docker('wait', appName),
    '1',
    'Elevated reader must fail startup',
  );
  await fixture.owner.query(
    'REVOKE UPDATE (approval_state) ON approvals.requests FROM spendwall_dashboard_reader',
  );
  docker('start', appName);
  await waitFor(healthy);
  await fixture.owner.query(
    'ALTER TABLE audit.audit_events RENAME TO unavailable_events',
  );
  try {
    assert.equal((await get(appPort, '/healthz', false)).status, 503);
    assert.equal((await get(appPort, '/stats')).status, 503);
  } finally {
    await fixture.owner.query(
      'ALTER TABLE audit.unavailable_events RENAME TO audit_events',
    );
  }
  console.log(
    'PASS: non-root image, assets withheld, empty/populated reads, auth, privilege rejection, restart and shutdown.',
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const cleanup of [
    () => names.includes(appName) && docker('rm', '-f', '-v', appName),
    () => fixture?.close(),
    () => names.includes(dbName) && docker('rm', '-f', '-v', dbName),
    () => directory && rm(directory, { recursive: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      console.error(`Cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
