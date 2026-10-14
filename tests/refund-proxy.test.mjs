import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const seen = { calls: [], refunds: 0, posts: [], http: 0, sse: 0, tokens: 0 };
  const upstream = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/oauth2/token') {
      seen.tokens++;
      res.end(
        JSON.stringify({
          access_token: config.rotatingTokens
            ? `private-paypal-token-${seen.tokens}`
            : 'private-paypal-token',
          token_type: 'Bearer',
          expires_in: 120,
        }),
      );
      return;
    }
    assert.equal(
      req.headers.authorization,
      config.rotatingTokens
        ? `Bearer private-paypal-token-${seen.tokens}`
        : 'Bearer private-paypal-token',
    );
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
      assert.equal(req.headers['paypal-request-id'], executionId);
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.posts.push({
        body,
        id: req.headers['paypal-request-id'],
        authorization: req.headers.authorization,
      });
      if (config.refund401 && seen.refunds === 1) {
        res.statusCode = 401;
        res.end('Authorization: private-paypal-token fake-secret');
        return;
      }
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
        return config.leak === true
          ? { content: [{ type: 'text', text: 'private-paypal-token' }] }
          : config.leak;
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
    ...(config.agentKeys ? { agentKeys: config.agentKeys } : {}),
    ...(config.approvalLookup ? { approvalLookup: config.approvalLookup } : {}),
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
  async function connect(proxy, clientKey = key) {
    const client = new Client({ name: 'proxy-test', version: '1' });
    downstreams.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(proxy.url), {
        requestInit: { headers: { Authorization: `Bearer ${clientKey}` } },
      }),
    );
    return client;
  }
  return {
    seen,
    options,
    config,
    resources,
    connect,
    async start(clientKey = key) {
      const proxy = await startProxy(options);
      assert.ok(proxy?.url, 'Expected a running localhost MCP proxy');
      resources.push(proxy);
      const client = await connect(proxy, clientKey);
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

const keyB = 'synthetic-agent-B-key-that-is-long-enough';
const keyHash = (value) => createHash('sha256').update(value).digest('hex');
function agents() {
  const rows = new Map([
    [
      keyHash(key),
      {
        keyHash: keyHash(key),
        agentId: 'agent-A',
        allowedTools: ['get_order'],
        enabled: true,
        revoked: false,
      },
    ],
    [
      keyHash(keyB),
      {
        keyHash: keyHash(keyB),
        agentId: 'agent-B',
        allowedTools: ['get_refund'],
        enabled: true,
        revoked: false,
      },
    ],
  ]);
  return {
    rows,
    async findByHash(hash) {
      return rows.get(hash) ?? null;
    },
    async insertKey() {
      throw new Error('fixture issuance disabled');
    },
  };
}

test('agent A and B see only their own tools and forged direct calls never dispatch', async (t) => {
  const store = agents();
  const f = await fixture(t, { agentKeys: store });
  const { proxy, client } = await f.start();
  const b = await f.connect(proxy, keyB);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ['get_order'],
  );
  assert.deepEqual(
    (await b.listTools()).tools.map((tool) => tool.name),
    ['get_refund'],
  );
  const errors = [];
  for (const name of ['get_refund', 'create_refund', 'unknown_tool']) {
    errors.push(
      await client.callTool({
        name,
        arguments: { capture_id: captureId },
        _meta: {
          'spendwall/agent-id': 'agent-B',
          'spendwall/execution-id': executionId,
        },
      }),
    );
  }
  assert.ok(errors.every((error) => error.isError));
  assert.deepEqual(errors[0], errors[1]);
  assert.deepEqual(errors[0], errors[2]);
  assert.equal(f.seen.calls.length, 0);
  assert.equal(f.seen.refunds, 0);
  assert.equal(
    (
      await client.callTool({
        name: 'get_order',
        arguments: { id: orderIdForTest },
      })
    ).isError,
    undefined,
  );
  assert.equal(f.seen.calls.length, 1);
});
const orderIdForTest = 'ORDER123456789012';

test('allowlist and revocation changes affect the next request; shared local key is no fallback', async (t) => {
  const store = agents();
  const f = await fixture(t, { agentKeys: store });
  const { proxy, client } = await f.start();
  store.rows.get(keyHash(key)).allowedTools = [];
  assert.deepEqual((await client.listTools()).tools, []);
  assert.equal(
    (
      await client.callTool({
        name: 'get_order',
        arguments: { id: orderIdForTest },
      })
    ).isError,
    true,
  );
  store.rows.get(keyHash(key)).revoked = true;
  await assert.rejects(client.listTools(), /Agent authentication required/);
  const revoked = await fetch(proxy.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: '{}',
  });
  assert.equal(revoked.status, 401);
  store.rows.delete(keyHash(key));
  await assert.rejects(f.connect(proxy), /Agent authentication required/);
  assert.equal(f.seen.calls.length, 0);
});

test('approval is a separately allowed local tool bound to the authenticated agent', async (t) => {
  const store = agents();
  store.rows.get(keyHash(key)).allowedTools.push('check_approval');
  const requests = [];
  const approvalId = 'e3857242-30c3-4772-8b4c-218df041e6cd';
  let result = {
    agentId: 'agent-A',
    approvalId,
    status: 'pending',
    private: 'never expose this',
  };
  const f = await fixture(t, {
    agentKeys: store,
    approvalLookup: async (request) => {
      requests.push(request);
      return result;
    },
  });
  const { proxy, client } = await f.start();
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ['get_order', 'check_approval'],
  );
  const call = () =>
    client.callTool({
      name: 'check_approval',
      arguments: { approval_id: approvalId },
    });
  const first = await call();
  assert.equal(first.isError, undefined);
  assert.deepEqual(first.structuredContent, {
    approval_id: approvalId,
    status: 'pending',
  });
  assert.doesNotMatch(JSON.stringify(first), /private|never expose/);
  assert.deepEqual(requests, [{ agentId: 'agent-A', approvalId }]);
  for (const invalid of [
    null,
    { ...result, agentId: 'agent-B' },
    { ...result, approvalId: 'different' },
    { ...result, status: 'unknown' },
    { ...result, status: ['approved'] },
  ]) {
    result = invalid;
    assert.equal((await call()).isError, true);
  }
  const b = await f.connect(proxy, keyB);
  assert.equal(
    (
      await b.callTool({
        name: 'check_approval',
        arguments: { approval_id: approvalId },
      })
    ).isError,
    true,
  );
  const before = requests.length;
  assert.equal(
    (
      await client.callTool({
        name: 'check_approval',
        arguments: { approval_id: 'bad' },
      })
    ).isError,
    true,
  );
  assert.equal(requests.length, before);
  assert.equal(f.seen.calls.length, 0);
});

test('approval without an injected store fails closed and is never sent upstream', async (t) => {
  const store = agents();
  store.rows.get(keyHash(key)).allowedTools = ['check_approval'];
  const f = await fixture(t, { agentKeys: store });
  const { client } = await f.start();
  assert.equal(
    (
      await client.callTool({
        name: 'check_approval',
        arguments: { approval_id: executionId },
      })
    ).isError,
    true,
  );
  assert.equal(f.seen.calls.length, 0);
});

test('nested or textual Authorization headers and tokens never reach downstream or logs', async (t) => {
  for (const leak of [
    {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ Authorization: 'synthetic-other-token' }),
        },
      ],
    },
    { content: [{ type: 'text', text: 'Bearer\ttab-token' }] },
    {
      content: [
        {
          type: 'text',
          text: 'Authorization: Basic ZmFrZS1jbGllbnQ6ZmFrZS1zZWNyZXQ=',
        },
      ],
    },
    {
      content: [{ type: 'text', text: 'ordinary text' }],
      structuredContent: {
        nested: { AUTHORIZATION: 'Bearer header-only-secret' },
      },
    },
    { content: [{ type: 'text', text: 'private-paypal-token' }] },
  ])
    await t.test('sensitive response', async (t) => {
      const f = await fixture(t, { leak });
      const { client } = await f.start();
      const output = [];
      const writes = [process.stdout.write, process.stderr.write];
      process.stdout.write = process.stderr.write = function (
        chunk,
        encoding,
        callback,
      ) {
        output.push(String(chunk));
        if (typeof encoding === 'function') encoding();
        else if (typeof callback === 'function') callback();
        return true;
      };
      let result;
      try {
        result = await client.callTool({
          name: 'get_order',
          arguments: { id: orderIdForTest },
        });
      } finally {
        [process.stdout.write, process.stderr.write] = writes;
      }
      assert.equal(result.isError, true);
      assert.doesNotMatch(
        JSON.stringify(result) + output.join(''),
        /private-paypal-token|header-only-secret|synthetic-other-token|tab-token|fake-secret|Authorization|ZmFrZS1jbGllbnQ6ZmFrZS1zZWNyZXQ=/i,
      );
    });
});

test('authenticated agent refunds retain the original request ID and bytes across one 401 refresh', async (t) => {
  const store = agents();
  store.rows.get(keyHash(key)).allowedTools = ['create_refund'];
  const f = await fixture(t, {
    agentKeys: store,
    rotatingTokens: true,
    refund401: true,
  });
  const { client } = await f.start();
  const result = await client.callTool({
    name: 'create_refund',
    arguments: { capture_id: captureId },
    _meta: { 'spendwall/execution-id': executionId },
  });
  assert.equal(result.isError, undefined);
  assert.equal(f.seen.posts.length, 2);
  assert.deepEqual(
    f.seen.posts.map((post) => post.id),
    [executionId, executionId],
  );
  assert.equal(f.seen.posts[0].body, f.seen.posts[1].body);
  assert.deepEqual(
    f.seen.posts.map((post) => post.authorization),
    ['Bearer private-paypal-token-1', 'Bearer private-paypal-token-2'],
  );
  assert.equal(f.seen.tokens, 2);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-paypal-token|Authorization/,
  );
});

test('approval lookup accessors and inherited identity fields deny without reading getters', async (t) => {
  const store = agents();
  store.rows.get(keyHash(key)).allowedTools = ['check_approval'];
  let reads = 0;
  let result = {
    agentId: 'agent-A',
    approvalId: executionId,
    get status() {
      reads++;
      return reads < 3
        ? 'approved'
        : 'Authorization: Bearer synthetic-leaked-token';
    },
  };
  const f = await fixture(t, {
    agentKeys: store,
    approvalLookup: async () => result,
  });
  const { client } = await f.start();
  const call = () =>
    client.callTool({
      name: 'check_approval',
      arguments: { approval_id: executionId },
    });
  const first = await call();
  assert.equal(first.isError, true);
  assert.equal(reads, 0);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-leaked-token/);
  result = Object.assign(
    Object.create({ agentId: 'agent-A', approvalId: executionId }),
    { status: 'approved' },
  );
  assert.equal((await call()).isError, true);
});
