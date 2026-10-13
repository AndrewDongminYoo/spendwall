import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  discoverPayPalTools,
  writeSnapshot,
} from '../scripts/dump-paypal-mcp-tools.mjs';

const env = {
  PAYPAL_CLIENT_ID: 'test-client',
  PAYPAL_CLIENT_SECRET: 'test-secret',
};
const accessToken = 'test-access-token';
const failure =
  'PayPal MCP discovery failed; check sandbox credentials and connectivity.';
const tool = (name) => ({
  name,
  inputSchema: { type: 'object', properties: {} },
});

async function fixture(t, { pages, hang = false, endpoint = '/messages' }) {
  let stream;
  let closed;
  const streamClosed = new Promise((resolve) => {
    closed = resolve;
  });
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      stream = response;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`event: endpoint\ndata: ${endpoint}\n\n`);
      response.on('close', closed);
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    requests.push(message);
    response.writeHead(202).end();
    if (message.id === undefined || hang) return;
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : pages[message.params?.cursor ?? 'first'];
    stream.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    assert.equal(init.redirect, 'error');
    if (url.origin === 'https://api-m.sandbox.paypal.com') {
      assert.equal(url.pathname, '/v1/oauth2/token');
      assert.equal(
        headers.get('authorization'),
        `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`,
      );
      return Response.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 120,
      });
    }
    assert.equal(url.origin, 'https://mcp.sandbox.paypal.com');
    assert.equal(headers.get('authorization'), `Bearer ${accessToken}`);
    return fetch(
      `http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`,
      init,
    );
  };
  return { fetchImpl, requests, streamClosed };
}

test(
  'real SDK authenticates SSE and POST, follows every tools/list page, and closes',
  { timeout: 5000 },
  async (t) => {
    const server = await fixture(t, {
      pages: {
        first: { tools: [tool('refund_capture')], nextCursor: 'second' },
        second: { tools: [tool('get_order')] },
      },
    });
    const snapshot = await discoverPayPalTools({
      env,
      fetchImpl: server.fetchImpl,
    });
    assert.deepEqual(snapshot.tools, [
      tool('get_order'),
      tool('refund_capture'),
    ]);
    assert.equal(
      snapshot.source.endpoint,
      'https://mcp.sandbox.paypal.com/sse',
    );
    assert.equal(snapshot.source.transport, 'sse');
    assert.equal(snapshot.source.pages, 2);
    assert.ok(Number.isFinite(Date.parse(snapshot.source.fetchedAt)));
    assert.deepEqual(
      server.requests.map((r) => r.method),
      ['initialize', 'notifications/initialized', 'tools/list', 'tools/list'],
    );
    assert.equal(server.requests.at(-1).params.cursor, 'second');
    assert.ok(!JSON.stringify(snapshot).includes(accessToken));
    await server.streamClosed;
  },
);

test(
  'empty catalogs, duplicate tools, and repeated cursors fail instead of producing partial dumps',
  { timeout: 5000 },
  async (t) => {
    for (const pages of [
      { first: { tools: [] } },
      { first: { tools: [tool('same'), tool('same')] } },
      {
        first: { tools: [tool('one')], nextCursor: 'loop' },
        loop: { tools: [tool('two')], nextCursor: 'loop' },
      },
    ]) {
      const server = await fixture(t, { pages });
      await assert.rejects(
        discoverPayPalTools({ env, fetchImpl: server.fetchImpl }),
        { message: failure },
      );
      await server.streamClosed;
    }
  },
);

test(
  'a stalled initialization reaches the overall deadline and closes the stream',
  { timeout: 5000 },
  async (t) => {
    const server = await fixture(t, { pages: {}, hang: true });
    const started = Date.now();
    await assert.rejects(
      discoverPayPalTools({ env, fetchImpl: server.fetchImpl, timeoutMs: 150 }),
      { message: failure },
    );
    assert.ok(Date.now() - started < 2000);
    assert.equal(server.requests[0].method, 'initialize');
    await server.streamClosed;
  },
);

test(
  'a server cannot direct authenticated messages to a different origin',
  { timeout: 5000 },
  async (t) => {
    const server = await fixture(t, {
      pages: {},
      endpoint: 'https://example.com/messages',
    });
    await assert.rejects(
      discoverPayPalTools({ env, fetchImpl: server.fetchImpl }),
      { message: failure },
    );
    assert.deepEqual(server.requests, []);
    await server.streamClosed;
  },
);

test('raw upstream errors cannot expose credentials', async () => {
  await assert.rejects(
    discoverPayPalTools({
      env,
      fetchImpl: async () => {
        throw new Error(env.PAYPAL_CLIENT_SECRET);
      },
    }),
    { message: failure },
  );
});

test('missing credentials fail before a request', async () => {
  await assert.rejects(
    discoverPayPalTools({
      env: {},
      fetchImpl: () => assert.fail('Unexpected request'),
    }),
    { message: failure },
  );
});

test('snapshot replacement is complete and a failed serialization preserves the prior file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'spendwall-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'tools.json');
  await writeFile(target, 'previous snapshot');
  const circular = {};
  circular.self = circular;
  await assert.rejects(writeSnapshot(circular, target));
  assert.equal(await readFile(target, 'utf8'), 'previous snapshot');
  const snapshot = { tools: [tool('example')] };
  await writeSnapshot(snapshot, target);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), snapshot);
  assert.deepEqual(await readdir(directory), ['tools.json']);
});
