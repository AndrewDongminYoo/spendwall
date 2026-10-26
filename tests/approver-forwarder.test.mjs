// cspell:words keyout pkeyopt paramgen prime256v1 addext nodes
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, request as plainRequest } from 'node:http';
import { request } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import {
  isTailnetAddress,
  startApproverForwarder,
  startApproverForwarderForTest,
} from '../apps/firewall/src/approver/forwarder.ts';
import { startApproverServer } from '../apps/firewall/src/approver/server.ts';

const host = 'synthetic.ts.net';

// A throwaway self-signed certificate; the key never leaves the temp dir.
function certificate(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'spendwall-forwarder-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'key.pem'),
    certFile = join(directory, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${host}`,
      '-addext',
      `subjectAltName=DNS:${host}`,
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { stdio: 'ignore' },
  );
  return {
    cert: fs.readFileSync(certFile, 'utf8'),
    key: fs.readFileSync(keyFile, 'utf8'),
  };
}

async function upstream(t, handler) {
  const seen = { connections: 0, requests: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res);
    });
  });
  server.on('connection', () => seen.connections++);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

async function forwarder(t, tls, apiUrl) {
  const started = await startApproverForwarderForTest({
    bind: '127.0.0.1',
    port: 0,
    host,
    ...tls,
    apiUrl,
  });
  t.after(() => started.close());
  return { ...started, port: Number(new URL(started.origin).port) };
}

function call(port, tls, { method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        servername: host,
        ca: tls.cert,
        method,
        path,
        headers: { host: `${host}:${port}`, ...headers },
        agent: false,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (part) => (text += part));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: text }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('method, path, query, body and end-to-end headers are forwarded; hop-by-hop headers are not', async (t) => {
  const tls = certificate(t);
  const api = await upstream(t, (_req, res) => {
    res.writeHead(207, {
      'content-type': 'application/json',
      'x-end-response': 'kept',
      connection: 'x-hop-response',
      'x-hop-response': 'dropped',
      'proxy-authenticate': 'Basic',
    });
    res.end('{"forwarded":true}');
  });
  const { origin, port } = await forwarder(t, tls, api.url);
  assert.equal(origin, `https://${host}:${port}`);
  const body = JSON.stringify({ decision: 'approve' });
  const response = await call(port, tls, {
    method: 'POST',
    path: '/approvals/x/decision?probe=1',
    headers: {
      authorization: 'Bearer synthetic',
      'content-type': 'application/json',
      'x-end-request': 'kept',
      connection: 'x-hop-request',
      'x-hop-request': 'dropped',
      'proxy-authorization': 'Basic synthetic',
      'keep-alive': 'timeout=5',
      te: 'trailers',
    },
    body,
  });
  assert.equal(response.status, 207);
  assert.equal(response.body, '{"forwarded":true}');
  assert.equal(response.headers['x-end-response'], 'kept');
  assert.equal(response.headers['x-hop-response'], undefined);
  assert.equal(response.headers['proxy-authenticate'], undefined);
  assert.equal(api.seen.requests.length, 1);
  const [seen] = api.seen.requests;
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/approvals/x/decision?probe=1');
  assert.equal(seen.body, body);
  assert.equal(seen.headers.host, new URL(api.url).host);
  assert.equal(seen.headers.authorization, 'Bearer synthetic');
  assert.equal(seen.headers['x-end-request'], 'kept');
  for (const name of [
    'x-hop-request',
    'proxy-authorization',
    'keep-alive',
    'te',
  ])
    assert.equal(seen.headers[name], undefined, name);
});

test('a wrong or missing-port Host is refused without contacting the API', async (t) => {
  const tls = certificate(t);
  const api = await upstream(t, (_req, res) => res.end());
  const { port } = await forwarder(t, tls, api.url);
  for (const value of [`other.ts.net:${port}`, host, `127.0.0.1:${port}`]) {
    const response = await call(port, tls, { headers: { host: value } });
    assert.equal(response.status, 421, value);
  }
  assert.equal(api.seen.connections, 0);
});

test('an absolute-form request target is refused without contacting the API', async (t) => {
  const tls = certificate(t);
  const api = await upstream(t, (_req, res) => res.end());
  const { port } = await forwarder(t, tls, api.url);
  const response = await call(port, tls, {
    path: `https://${host}:${port}/approvals?status=pending`,
  });
  assert.equal(response.status, 400);
  assert.equal(api.seen.connections, 0);
});

// Resolves with how the forwarder ended a request it must not serve.
function refusedSocket(port, tls, { method = 'GET', path = '/', headers }) {
  return new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port,
      servername: host,
      ca: tls.cert,
      method,
      path,
      headers: { host: `${host}:${port}`, ...headers },
      agent: false,
    });
    req.on('response', (res) => {
      res.resume();
      resolve(`response ${res.statusCode}`);
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve('upgraded');
    });
    req.on('connect', (_res, socket) => {
      socket.destroy();
      resolve('tunnelled');
    });
    req.on('error', () => resolve('closed'));
    req.end();
  });
}

test('protocol upgrades and CONNECT tunnels are closed without contacting the API', async (t) => {
  const tls = certificate(t);
  const api = await upstream(t, (_req, res) => res.end());
  const { port } = await forwarder(t, tls, api.url);
  assert.equal(
    await refusedSocket(port, tls, {
      headers: { connection: 'upgrade', upgrade: 'websocket' },
    }),
    'closed',
  );
  assert.equal(
    await refusedSocket(port, tls, {
      method: 'CONNECT',
      path: `${host}:${port}`,
    }),
    'closed',
  );
  assert.equal(api.seen.connections, 0);
});

test('close() does not wait for a client that never finishes the TLS handshake', async (t) => {
  const tls = certificate(t);
  const api = await upstream(t, (_req, res) => res.end());
  const started = await forwarder(t, tls, api.url);
  const raw = connect(started.port, '127.0.0.1');
  t.after(() => raw.destroy());
  raw.on('error', () => {});
  await new Promise((resolve) => raw.once('connect', resolve));
  // Let the server accept the socket before shutting down.
  await delay(100);
  let timer;
  const outcome = await Promise.race([
    started.close().then(() => 'closed'),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('pending'), 2000);
    }),
  ]);
  clearTimeout(timer);
  // Release a still-pending close() so a failure does not wait for teardown.
  raw.destroy();
  assert.equal(outcome, 'closed');
});

test('a request carrying Origin is refused without contacting the API', async (t) => {
  const tls = certificate(t);
  const api = await upstream(t, (_req, res) => res.end());
  const { port } = await forwarder(t, tls, api.url);
  for (const origin of [`https://${host}:${port}`, 'null']) {
    const response = await call(port, tls, { headers: { origin } });
    assert.equal(response.status, 403);
  }
  assert.equal(api.seen.connections, 0);
});

test('an unreachable API gives 502', async (t) => {
  const tls = certificate(t);
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((resolve) => closed.close(resolve));
  const { port } = await forwarder(t, tls, apiUrl);
  const response = await call(port, tls, { path: '/approvals' });
  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(response.body), { error: 'Forwarding refused.' });
});

test('bind addresses outside 100.64.0.0/10 are refused at startup', async (t) => {
  const tls = certificate(t);
  const options = { port: 0, host, ...tls, apiUrl: 'http://127.0.0.1:1' };
  for (const bind of [
    '0.0.0.0',
    '127.0.0.1',
    '192.168.1.10',
    '10.0.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '100.064.0.1',
    '::',
    '::1',
    'localhost',
  ])
    await assert.rejects(startApproverForwarder({ ...options, bind }), {
      message: 'Forwarder configuration unavailable.',
    });
  for (const bind of ['100.64.0.0', '100.100.100.100', '100.127.255.255'])
    assert.equal(isTailnetAddress(bind), true, bind);
  // The test seam binds nothing but loopback 127.0.0.1.
  for (const bind of ['0.0.0.0', '192.168.1.10'])
    await assert.rejects(startApproverForwarderForTest({ ...options, bind }), {
      message: 'Forwarder configuration unavailable.',
    });
  // Port 443 would drop out of Host, so the exact Host match refuses it.
  await assert.rejects(
    startApproverForwarderForTest({ ...options, bind: '127.0.0.1', port: 443 }),
    { message: 'Forwarder configuration unavailable.' },
  );
  for (const apiUrl of ['http://localhost:1', 'https://127.0.0.1:1'])
    await assert.rejects(
      startApproverForwarderForTest({ ...options, bind: '127.0.0.1', apiUrl }),
      { message: 'Forwarder configuration unavailable.' },
    );
});

test('the real approval API accepts the rewritten Host and keeps its own Host check', async (t) => {
  const tls = certificate(t);
  let connections = 0;
  const app = await startApproverServer({
    pool: {
      connect: async () => {
        connections++;
        throw Error('Unexpected storage access');
      },
    },
    merchantId: 'synthetic',
    identityKey: '7'.repeat(64),
    signingKey: '8'.repeat(64),
    devices: () => [],
    executor: { identity: '9'.repeat(64) },
    refresh: async () => {
      throw Error('Unexpected refresh');
    },
    pollIntervalMs: 0,
  });
  t.after(() => app.close());
  const { port } = await forwarder(t, tls, app.url);
  // Passing the server's Host/Origin check reaches bearer authentication.
  const forwarded = await call(port, tls, {
    path: '/approvals?status=pending',
  });
  assert.equal(forwarded.status, 401);
  assert.deepEqual(JSON.parse(forwarded.body), {
    error: 'Approver authentication required.',
  });
  // The same tailnet Host sent directly is still refused by the API itself.
  const direct = await new Promise((resolve, reject) => {
    const req = plainRequest(
      `${app.url}/approvals?status=pending`,
      { headers: { host: `${host}:${port}` }, agent: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(direct, 403);
  const withOrigin = await call(port, tls, {
    path: '/approvals?status=pending',
    headers: { origin: app.url },
  });
  assert.equal(withOrigin.status, 403);
  assert.equal(connections, 0);
});
