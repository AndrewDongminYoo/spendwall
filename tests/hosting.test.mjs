import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';

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

test('hosted mode cannot enable model, replay or asset capabilities', async () => {
  for (const extra of [
    { classify: async () => 'unsupported' },
    { policyPreview: {} },
    { staticDirectory: '/tmp' },
    { queryMode: 'synthetic' },
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
    '/',
    '/assets/main.js',
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
