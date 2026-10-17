// `rivate` is the token fragment that survives any escape of its first character.
// cspell:ignore rivate
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { startProxy } from '../apps/firewall/src/server.ts';

const snapshot = JSON.parse(
  await readFile(new URL('../docs/paypal-mcp-tools.json', import.meta.url)),
);
const catalog = snapshot.tools.filter((tool) =>
  ['get_order', 'create_refund', 'get_refund'].includes(tool.name),
);
const key = 'local-proxy-test-key-that-is-over-32-characters';
const captureId = 'CAPTURE12345678901';
const refundId = 'REFUND123456789012';
const executionId = 'e3857242-30c3-4772-8b4c-218df041e6cd';
const refund = {
  id: refundId,
  status: 'COMPLETED',
  amount: { value: '5.00', currency_code: 'USD' },
  links: [
    {
      rel: 'up',
      href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}`,
    },
  ],
};

async function fixture(t, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'spendwall-proxy-'));
  const servedCatalog = config.catalog ?? catalog;
  const resources = [];
  const downstreams = [];
  const sessions = new Map();
  const seen = {
    calls: [],
    refunds: 0,
    refundIds: [],
    http: 0,
    sse: 0,
    tokens: 0,
  };
  const upstream = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/oauth2/token') {
      seen.tokens++;
      res.end(
        JSON.stringify({
          access_token: 'private-paypal-token',
          token_type: 'Bearer',
          expires_in: 120,
        }),
      );
      return;
    }
    assert.equal(req.headers.authorization, 'Bearer private-paypal-token');
    if (req.url === `/v2/payments/captures/${captureId}`) {
      res.end(
        JSON.stringify({
          id: captureId,
          status: 'COMPLETED',
          amount: { value: '5.00', currency_code: 'USD' },
        }),
      );
      return;
    }
    if (req.url === `/v2/payments/captures/${captureId}/refund`) {
      seen.refunds++;
      if (!config.scopedIds)
        assert.equal(req.headers['paypal-request-id'], executionId);
      seen.refundIds.push(req.headers['paypal-request-id']);
      res.end(
        JSON.stringify({
          ...refund,
          status: config.refundStatus ?? refund.status,
        }),
      );
      return;
    }
    if (req.url?.startsWith('/messages')) {
      await sessions
        .get(new URL(req.url, 'http://local').searchParams.get('sessionId'))
        .handlePostMessage(req, res);
      return;
    }
    if (req.url !== '/http' && req.url !== '/sse') {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    if (config.httpFailure) {
      res.statusCode = config.httpFailure;
      res.end('private-paypal-token fake-secret');
      return;
    }
    if (config.disconnect) {
      req.socket.destroy();
      return;
    }
    const server = new Server(
      { name: 'fixture-paypal', version: '1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      if (config.drift)
        return {
          tools: [
            {
              ...servedCatalog[0],
              inputSchema: { type: 'object', properties: {} },
            },
            ...servedCatalog.slice(1),
          ],
        };
      return request.params?.cursor === 'page-2'
        ? { tools: servedCatalog.slice(1) }
        : { tools: servedCatalog.slice(0, 1), nextCursor: 'page-2' };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      seen.calls.push(request.params);
      if (config.stall)
        await new Promise((resolve) =>
          resources.push({ close: async () => resolve() }),
        );
      if (config.leak)
        return {
          content: [
            {
              type: 'text',
              text: config.leak === true ? 'private-paypal-token' : config.leak,
            },
          ],
        };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              id: request.params.arguments.id,
              status: 'COMPLETED',
            }),
          },
        ],
      };
    });
    const transport =
      req.url === '/sse'
        ? new SSEServerTransport('/messages', res)
        : new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
    resources.push(server);
    if (req.url === '/sse') {
      seen.sse++;
      sessions.set(transport.sessionId, transport);
      await server.connect(transport);
    } else {
      seen.http++;
      await server.connect(transport);
      res.on('close', () => {
        void server.close();
      });
      await transport.handleRequest(req, res);
    }
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  t.after(async () => {
    for (const client of downstreams) await client.close();
    for (const resource of resources.reverse()) await resource.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const options = {
    env: {
      PAYPAL_CLIENT_ID: 'fake-client',
      PAYPAL_CLIENT_SECRET: 'fake-secret',
    },
    proxyKey: key,
    ...(config.agentAuth ? { agentAuth: config.agentAuth } : {}),
    ledgerPath: join(dir, 'refunds.json'),
    expectedTools: config.expectedTools ?? catalog,
    port: 0,
    timeoutMs: config.timeoutMs ?? 1_000,
    transport: config.transport ?? 'http',
    fetchImpl(input, init) {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.ok(
        [
          'https://mcp.sandbox.paypal.com',
          'https://api-m.sandbox.paypal.com',
        ].includes(url.origin),
      );
      return fetch(origin + url.pathname + url.search, init);
    },
  };
  return {
    seen,
    options,
    config,
    resources,
    async start() {
      const proxy = await startProxy(options);
      assert.ok(proxy?.url, 'Expected a running localhost MCP proxy');
      resources.push(proxy);
      const client = new Client({ name: 'proxy-test', version: '1' });
      downstreams.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(proxy.url), {
          requestInit: { headers: { Authorization: `Bearer ${key}` } },
        }),
      );
      return { proxy, client };
    },
  };
}

test('real SDK lists paginated tools and calls a read tool through NestJS using HTTP', async (t) => {
  const f = await fixture(t);
  const { client } = await f.start();
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    catalog.map((tool) => tool.name),
  );
  const result = await client.callTool({
    name: 'get_order',
    arguments: { id: 'ORDER123456789012' },
  });
  assert.equal(JSON.parse(result.content[0].text).id, 'ORDER123456789012');
  assert.equal(f.seen.calls.length, 1);
  assert.ok(f.seen.http > 0);
  assert.equal(f.seen.sse, 0);
});

test('refund dispatch uses REST and stable metadata while the MCP schema stays unchanged', async (t) => {
  const f = await fixture(t);
  const { client } = await f.start();
  const request = {
    name: 'create_refund',
    arguments: { capture_id: captureId },
    _meta: { 'spendwall/execution-id': executionId },
  };
  const first = await client.callTool(request);
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.id, refundId);
  const second = await client.callTool(request);
  assert.deepEqual(second.structuredContent, first.structuredContent);
  assert.equal(f.seen.refunds, 1);
  assert.equal(f.seen.calls.length, 0);
  const noId = await client.callTool({
    name: 'create_refund',
    arguments: { capture_id: captureId },
  });
  assert.equal(noId.isError, true);
  assert.equal(f.seen.refunds, 1);
});

test('authentication, origin, host and input validation fail before upstream calls', async (t) => {
  const f = await fixture(t);
  const { proxy, client } = await f.start();
  for (const headers of [
    {},
    { Authorization: 'Bearer wrong' },
    { Authorization: `Bearer ${key}`, Origin: 'https://untrusted.example' },
  ]) {
    const response = await fetch(proxy.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    });
    assert.ok(
      [401, 403].includes(response.status),
      `Expected rejection for ${JSON.stringify(headers)}, got ${response.status}: ${await response.text()}`,
    );
  }
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(
      proxy.url,
      {
        method: 'POST',
        headers: {
          Host: 'untrusted.example',
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(badHostStatus, 403);
  const result = await client.callTool({
    name: 'get_order',
    arguments: { bad_id: 'wrong' },
  });
  assert.equal(result.isError, true);
  assert.equal(f.seen.calls.length, 0);
});

test('catalog drift refuses startup and leaves no owned lock behind', async (t) => {
  const f = await fixture(t, { drift: true });
  await assert.rejects(startProxy(f.options), /schema|catalog/i);
  await assert.rejects(readFile(f.options.ledgerPath + '.lock'), {
    code: 'ENOENT',
  });
});

test('explicit SSE compatibility mode authenticates both stream and message requests', async (t) => {
  const f = await fixture(t, { transport: 'sse' });
  const { client } = await f.start();
  assert.equal((await client.listTools()).tools.length, 3);
  assert.equal(f.seen.http, 0);
  assert.ok(f.seen.sse > 0);
});

test('a stalled upstream call returns a safe error without SSE fallback or repeat', async (t) => {
  const f = await fixture(t, { timeoutMs: 150 });
  const { client } = await f.start();
  f.config.stall = true;
  const began = Date.now();
  const result = await client.callTool({
    name: 'get_order',
    arguments: { id: 'ORDER123456789012' },
  });
  assert.equal(result.isError, true);
  assert.ok(Date.now() - began < 2_000);
  assert.equal(f.seen.calls.length, 1);
  assert.equal(f.seen.sse, 0);
  assert.doesNotMatch(
    JSON.stringify(result),
    /fake-secret|private-paypal-token/,
  );
});

test('upstream results that echo a credential are not exposed downstream', async (t) => {
  const f = await fixture(t, { leak: true });
  const { client } = await f.start();
  const result = await client.callTool({
    name: 'get_order',
    arguments: { id: 'ORDER123456789012' },
  });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /private-paypal-token/);
});

test('upstream results that echo an escaped credential are withheld from client and logs', async (t) => {
  const f = await fixture(t, {
    leak: 'Result: "\\u0070rivate-paypal-token',
  });
  const { client } = await f.start();
  const logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'])
    t.mock.method(console, method, (...items) => {
      logs.push(items.map(String).join(' '));
    });
  t.mock.method(process.stderr, 'write', (chunk) => {
    logs.push(String(chunk));
    return true;
  });
  console.error('capture-probe');
  const result = await client.callTool({
    name: 'get_order',
    arguments: { id: 'ORDER123456789012' },
  });
  t.mock.restoreAll();
  assert.equal(logs[0], 'capture-probe');
  assert.equal(f.seen.calls.length, 1);
  assert.equal(result.isError, true);
  // The fragment survives any escape of the token's first character.
  assert.doesNotMatch(JSON.stringify(result), /rivate-paypal-token/);
  assert.doesNotMatch(logs.join('\n'), /rivate-paypal-token/);
});

test('smoke CLI rejects ambiguous refunds and missing credentials without leaking them', () => {
  const childEnv = { ...process.env };
  delete childEnv.PAYPAL_CLIENT_ID;
  delete childEnv.PAYPAL_CLIENT_SECRET;
  for (const argv of [
    [],
    ['--refund'],
    ['--refund', '--capture', captureId],
    ['--unknown'],
  ]) {
    const child = spawnSync(
      process.execPath,
      ['scripts/proxy-smoke.mjs', ...argv],
      { encoding: 'utf8', env: childEnv, timeout: 5_000 },
    );
    assert.equal(
      child.status,
      1,
      `Expected CLI failure for ${JSON.stringify(argv)}: ${child.stdout}${child.stderr}`,
    );
    assert.match(child.stderr, /credentials|usage|capture|execution/i);
    assert.doesNotMatch(
      child.stdout + child.stderr,
      /private-paypal-token|fake-secret/,
    );
  }
});

test('startup errors expose the failed MCP stage and HTTP status without secrets', async (t) => {
  const f = await fixture(t, { httpFailure: 404 });
  await assert.rejects(startProxy(f.options), (error) => {
    assert.match(error.message, /http.*initialization.*HTTP 404/i);
    assert.doesNotMatch(error.message, /private-paypal-token|fake-secret/);
    return true;
  });
});

test('rolling transaction date defaults do not change the reviewed input contract', async (t) => {
  const updated = structuredClone(snapshot.tools);
  const transaction = updated.find((tool) => tool.name === 'list_transactions');
  transaction.inputSchema.properties.start_date.default =
    '2026-09-12T13:55:07.550Z';
  transaction.inputSchema.properties.end_date.default =
    '2026-10-13T13:55:07.550Z';
  const f = await fixture(t, {
    catalog: updated,
    expectedTools: snapshot.tools,
  });
  const { client } = await f.start();
  const listed = (await client.listTools()).tools;
  assert.equal(listed.length, snapshot.tools.length);
  assert.deepEqual(
    listed.find((tool) => tool.name === 'list_transactions').inputSchema,
    transaction.inputSchema,
  );
  assert.equal(
    snapshot.tools.find((tool) => tool.name === 'list_transactions').inputSchema
      .properties.end_date.default,
    '2026-10-13T00:13:32.669Z',
  );
});

test('transaction constraints and other defaults still fail catalog review', async (t) => {
  for (const change of ['type', 'missing', 'invalid', 'otherDefault']) {
    await t.test(change, async (t) => {
      const updated = structuredClone(snapshot.tools);
      const properties = updated.find(
        (tool) => tool.name === 'list_transactions',
      ).inputSchema.properties;
      if (change === 'type') properties.start_date.type = 'number';
      if (change === 'missing') delete properties.start_date.default;
      if (change === 'invalid') properties.start_date.default = 'not-a-date';
      if (change === 'otherDefault') properties.page_size.default = 500;
      const f = await fixture(t, {
        catalog: updated,
        expectedTools: snapshot.tools,
      });
      await assert.rejects(startProxy(f.options), /catalog\/schema drift/);
      assert.equal(f.seen.calls.length, 0);
      assert.equal(f.seen.refunds, 0);
    });
  }
});

test('terminal refund statuses are MCP errors on the first call and retry', async (t) => {
  for (const status of ['FAILED', 'CANCELLED']) {
    await t.test(status, async (t) => {
      const f = await fixture(t, { refundStatus: status });
      const { client } = await f.start();
      const request = {
        name: 'create_refund',
        arguments: { capture_id: captureId },
        _meta: { 'spendwall/execution-id': executionId },
      };
      const first = await client.callTool(request);
      assert.equal(first.isError, true);
      assert.equal(first.structuredContent.status, status);
      assert.equal((await client.callTool(request)).isError, true);
      assert.equal(f.seen.refunds, 1);
      const ledger = JSON.parse(await readFile(f.options.ledgerPath));
      assert.equal(ledger.executions[executionId].status, 'failed');
    });
  }
});

test('agent grants hide tools and reject direct calls before upstream work', async (t) => {
  let grants = ['get_order'];
  const f = await fixture(t, {
    agentAuth: {
      authenticate: async (token) =>
        token === key
          ? { merchantId: 'merchantA', agentId: 'support', tools: [...grants] }
          : null,
    },
  });
  const { client } = await f.start();
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ['get_order'],
  );
  assert.equal(
    (await client.callTool({ name: 'get_refund', arguments: { id: refundId } }))
      .isError,
    true,
  );
  assert.equal(
    (
      await client.callTool({
        name: 'create_refund',
        arguments: { capture_id: captureId },
        _meta: { 'spendwall/execution-id': executionId },
      })
    ).isError,
    true,
  );
  assert.equal(f.seen.calls.length, 0);
  assert.equal(f.seen.refunds, 0);
  await client.callTool({
    name: 'get_order',
    arguments: { id: 'ORDER1234567890123' },
  });
  assert.equal(f.seen.calls.length, 1);
  grants = [];
  assert.deepEqual((await client.listTools()).tools, []);
  assert.equal(
    (
      await client.callTool({
        name: 'get_order',
        arguments: { id: 'ORDER1234567890123' },
      })
    ).isError,
    true,
  );
  assert.equal(f.seen.calls.length, 1);
});

test('agent mode never falls back to shared key when credentials fail or database fails', async (t) => {
  let failure = false,
    revoked = false;
  const f = await fixture(t, {
    agentAuth: {
      authenticate: async () => {
        if (failure) throw new Error('private-database-connection');
        return revoked
          ? null
          : {
              merchantId: 'merchantA',
              agentId: 'support',
              tools: ['get_order'],
            };
      },
    },
  });
  const { client, proxy } = await f.start();
  revoked = true;
  await assert.rejects(client.listTools());
  failure = true;
  const response = await fetch(proxy.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('private-database'));
  assert.equal(f.seen.calls.length, 0);
});

test('refund UUIDs are isolated by authenticated identity while same-agent retries stay stable', async (t) => {
  let agentId = 'support';
  const f = await fixture(t, {
    scopedIds: true,
    agentAuth: {
      authenticate: async () => ({
        merchantId: 'merchantA',
        agentId,
        tools: ['create_refund'],
      }),
    },
  });
  const { client } = await f.start();
  const call = (callerId = executionId) =>
    client.callTool({
      name: 'create_refund',
      arguments: { capture_id: captureId },
      _meta: {
        'spendwall/execution-id': callerId,
        agentId: 'attacker-controlled',
      },
    });
  const first = await call();
  assert.notEqual(first.isError, true);
  assert.equal(
    first.structuredContent.executionId,
    executionId,
    'Return the caller ID so retrying the receipt cannot create a second operation',
  );
  assert.equal(JSON.parse(first.content[0].text).executionId, executionId);
  assert.notEqual(
    (await call(first.structuredContent.executionId)).isError,
    true,
  );
  assert.equal(f.seen.refunds, 1);
  agentId = 'returns';
  assert.notEqual((await call()).isError, true);
  assert.equal(f.seen.refunds, 2);
  assert.notEqual(f.seen.refundIds[0], f.seen.refundIds[1]);
  assert.ok(f.seen.refundIds.every((id) => id !== executionId));
});

test('two API keys identify distinct grants and body-time revocation denies dispatch', async (t) => {
  const secondKey = 'second-agent-test-key-over-32-characters';
  let revoked = false,
    observed;
  const f = await fixture(t, {
    agentAuth: {
      authenticate: async (token) => {
        observed?.();
        if (revoked) return null;
        if (token === key)
          return {
            merchantId: 'merchantA',
            agentId: 'support',
            tools: ['get_order'],
          };
        if (token === secondKey)
          return {
            merchantId: 'merchantA',
            agentId: 'returns',
            tools: ['get_refund'],
          };
        return null;
      },
    },
  });
  const { proxy, client } = await f.start();
  const second = new Client({ name: 'second-agent', version: '1' });
  t.after(() => second.close());
  await second.connect(
    new StreamableHTTPClientTransport(new URL(proxy.url), {
      requestInit: { headers: { Authorization: `Bearer ${secondKey}` } },
    }),
  );
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ['get_order'],
  );
  assert.deepEqual(
    (await second.listTools()).tools.map((t) => t.name),
    ['get_refund'],
  );
  const authorized = new Promise((resolve) => {
    observed = resolve;
  });
  const response = new Promise((resolve, reject) => {
    const req = httpRequest(
      proxy.url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.write('{');
    void authorized.then(() => {
      revoked = true;
      req.end(
        '"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"get_order","arguments":{"id":"ORDER123456789012"}}}',
      );
    });
  });
  const result = await response;
  assert.equal(JSON.parse(result.body).result.isError, true);
  assert.equal(f.seen.calls.length, 0);
});
