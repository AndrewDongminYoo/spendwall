import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';
import { databaseTls } from '../scripts/hosted-database.mjs';

const origin = 'https://spendwall.example.invalid';
const token = '8'.repeat(64);
const options = {
  identityKey: '7'.repeat(64),
  token,
  merchantId: 'merchantA',
  pool: {
    connect: async () => {
      throw new Error('private database detail');
    },
  },
};
function call(server, path, headers = {}, method = 'GET') {
  const address = new URL(server.listenUrl ?? server.url);
  address.hostname = '127.0.0.1';
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(path, address),
      {
        method,
        headers: { host: new URL(origin).host, ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, body, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('hosted mode authenticates the configured HTTPS origin without trusting forwarded headers', async (t) => {
  const server = await startDashboardServer({
    ...options,
    hosted: { publicOrigin: origin },
  });
  t.after(() => server.close());
  assert.equal((await call(server, '/stats')).status, 401);
  for (const headers of [
    {
      host: 'attacker.invalid',
      'x-forwarded-host': new URL(origin).host,
      'x-forwarded-proto': 'https',
    },
    { origin: 'https://attacker.invalid' },
    { origin: 'null' },
    { host: '127.0.0.1' },
  ])
    assert.equal((await call(server, '/stats', headers)).status, 403);
  const authorized = await call(server, '/stats', {
    authorization: `Bearer ${token}`,
    origin,
  });
  assert.equal(authorized.status, 503);
  assert.doesNotMatch(authorized.body, /private database/);
  assert.equal(server.url, origin);
});

test('hosted mode cannot enable model, replay or reconciliation capabilities', async () => {
  for (const extra of [
    { classify: async () => 'unsupported' },
    { policyPreview: {} },
    { queryMode: 'synthetic' },
    { reconciliation: { adapterRef: 'a'.repeat(64) } },
  ]) {
    let server;
    try {
      await assert.rejects(async () => {
        server = await startDashboardServer({
          ...options,
          hosted: { publicOrigin: origin },
          ...extra,
        });
      }, /Invalid hosted dashboard configuration/);
    } finally {
      await server?.close();
    }
  }
});

test('hosted mode rejects noncanonical and non-HTTPS public origins before listening', async () => {
  for (const publicOrigin of [
    '',
    'http://demo.example',
    'https://demo.example/',
    'https://user:password@demo.example',
    'https://demo.example/path',
    'https://demo.example?x=1',
    'https://demo.example#fragment',
  ]) {
    let server;
    try {
      await assert.rejects(async () => {
        server = await startDashboardServer({
          ...options,
          hosted: { publicOrigin },
        });
      }, /Invalid hosted dashboard configuration/);
    } finally {
      await server?.close();
    }
  }
});

test('hosted mode has no policy, query, payment or approval routes even with valid credentials', async (t) => {
  const server = await startDashboardServer({
    ...options,
    hosted: { publicOrigin: origin },
  });
  t.after(() => server.close());
  for (const path of [
    '/policy',
    '/policy/propose',
    '/policy/dry-run',
    '/policy/export',
    '/query',
    '/mcp',
    '/devices/register',
    '/approvals/example/decision',
  ]) {
    for (const method of ['GET', 'POST']) {
      const result = await call(
        server,
        path,
        {
          authorization: `Bearer ${token}`,
          'x-spendwall-policy-token': 'b'.repeat(64),
        },
        method,
      );
      assert.equal(result.status, 404, `${method} ${path}`);
    }
  }
});

test('hosted mode serves only the built dashboard files beside its read routes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'spendwall-hosted-ui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<div id="root"></div>');
  await writeFile(join(directory, 'assets', 'index-abc.js'), 'export {};');
  await writeFile(join(directory, 'secret.json'), '{}');
  const server = await startDashboardServer({
    ...options,
    hosted: { publicOrigin: origin },
    staticDirectory: directory,
  });
  t.after(() => server.close());
  const page = await call(server, '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  const script = await call(server, '/assets/index-abc.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript');
  for (const path of [
    '/secret.json',
    '/index.html',
    '/assets/missing.js',
    '/assets/../secret.json',
    '/assets/%2e%2e/secret.json',
    '/policy',
    '/query',
  ])
    assert.equal((await call(server, path)).status, 404, path);
  assert.equal((await call(server, '/', {}, 'POST')).status, 405);
});

test('hosted health fails closed without exposing database errors', async (t) => {
  const server = await startDashboardServer({
    ...options,
    hosted: { publicOrigin: origin },
  });
  t.after(() => server.close());
  const result = await call(server, '/healthz');
  assert.equal(result.status, 503);
  assert.deepEqual(JSON.parse(result.body), { ready: false });
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal((await call(server, '/healthz', {}, 'POST')).status, 405);
});

test('hosted health probes leave capacity for authenticated reads and release their slot', async () => {
  const entered = Promise.withResolvers();
  const held = Promise.withResolvers();
  const secondEntered = Promise.withResolvers();
  let calls = 0;
  let releases = 0;
  const client = {
    query: async (sql) => ({
      rows: sql.includes(' AS restricted')
        ? [{ restricted: true }]
        : sql.includes(' AS mismatch')
          ? [{ mismatch: false }]
          : sql.includes('clock_timestamp')
            ? [{ now: 1700000000000 }]
            : [],
    }),
    release: () => releases++,
  };
  const server = await startDashboardServer({
    ...options,
    hosted: { publicOrigin: origin },
    pool: {
      connect: async () => {
        calls++;
        if (calls === 1) {
          entered.resolve();
          await held.promise;
        } else secondEntered.resolve();
        return client;
      },
    },
  });
  const health = call(server, '/healthz');
  let duplicate;
  try {
    await entered.promise;
    duplicate = call(server, '/healthz');
    const rejected = await Promise.race([
      duplicate,
      secondEntered.promise.then(() => ({ status: 'second DB probe entered' })),
    ]);
    assert.equal(rejected.status, 503);
    assert.deepEqual(JSON.parse(rejected.body), { ready: false });
    assert.equal(calls, 1);
    assert.equal(
      (await call(server, '/audit', { authorization: `Bearer ${token}` }))
        .status,
      200,
    );
    held.reject(new Error('controlled connection failure'));
    assert.equal((await health).status, 503);
    assert.equal((await call(server, '/healthz')).status, 200);
    assert.equal((await call(server, '/healthz')).status, 200);
    assert.equal(releases, 3);
  } finally {
    held.resolve();
    await Promise.allSettled([health, duplicate]);
    await server.close();
  }
});

test('hosted database TLS relaxes verification only for private single-label hosts', () => {
  assert.deepEqual(databaseTls(undefined, 'db.example.com'), {
    rejectUnauthorized: true,
  });
  assert.deepEqual(databaseTls('require', 'dpg-abc123-a'), {
    rejectUnauthorized: false,
  });
  assert.equal(databaseTls('disable', '127.0.0.1'), false);
  for (const [mode, host] of [
    ['require', 'dpg-abc123-a.singapore-postgres.render.com'],
    ['require', 'localhost'],
    ['require', '10.0.0.5'],
    ['disable', 'dpg-abc123-a'],
    ['verify-ca', 'dpg-abc123-a'],
  ])
    assert.throws(() => databaseTls(mode, host), /Invalid database TLS/);
});
