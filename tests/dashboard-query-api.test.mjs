import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';
import { claudeQuery } from '../apps/firewall/src/dashboard/claude-query.ts';

const token = '8'.repeat(64);
test('query authentication and body validation precede provider and database work', async (t) => {
  let calls = 0,
    connections = 0;
  const server = await startDashboardServer({
    identityKey: '7'.repeat(64),
    merchantId: 'merchantA',
    token,
    classify: async () => {
      calls++;
      return { intent: 'weekly_refunds' };
    },
    pool: {
      connect: async () => {
        connections++;
        return {
          query: async (sql) => ({
            rows: sql.includes('SELECT EXISTS')
              ? [{ mismatch: false }]
              : sql.includes('clock_timestamp')
                ? [{ now: Date.parse('2026-10-16T12:00:00Z') }]
                : [],
          }),
          release() {},
        };
      },
    },
  });
  t.after(() => server.close());
  const send = (body, headers = {}) =>
    fetch(server.url + '/query', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await send({ question: 'hello' }, { authorization: '' })).status,
    401,
  );
  assert.equal(
    (await send({ question: 'hello' }, { origin: 'https://foreign.invalid' }))
      .status,
    403,
  );
  for (const body of [
    { question: '' },
    { question: 'x'.repeat(2001) },
    { question: 'hello', sql: 'DROP TABLE audit' },
    [],
  ])
    assert.equal((await send(body)).status, 400);
  assert.equal(calls, 0);
  assert.equal(connections, 0);
  const response = await send({
    question: '이번 주 $100 넘는 환불 시도 보여줘',
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).rows, []);
  assert.equal(calls, 1);
  assert.equal(connections, 1);
});
test('Claude adapter uses fixed structured output and rejects tool calls or extra fields', async () => {
  let sent;
  let answer = { intent: 'weekly_refunds' };
  const classify = claudeQuery({
    apiKey: 'test-only',
    model: 'configured-model',
    fetchImpl: async (url, init) => {
      sent = { url, init };
      return Response.json({
        type: 'message',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(answer) }],
      });
    },
  });
  assert.deepEqual(
    await classify('refunds over $100 this week', AbortSignal.timeout(1000)),
    { intent: 'weekly_refunds' },
  );
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.tools, undefined);
  assert.equal(body.messages.length, 1);
  assert.equal(body.output_config.format.type, 'json_schema');
  for (const invalid of [
    { intent: 'sql' },
    { intent: 'weekly_refunds', sql: 'SELECT *' },
    null,
  ]) {
    answer = invalid;
    await assert.rejects(() => classify('hello', AbortSignal.timeout(1000)));
  }
});

test('unconfigured, unsupported and invalid provider results do not read the database', async (t) => {
  for (const classify of [
    undefined,
    async () => ({ intent: 'unsupported' }),
    async () => ({ intent: 'weekly_refunds', sql: 'SELECT *' }),
    async () => {
      throw new Error('private-provider-error');
    },
  ]) {
    let reads = 0;
    const server = await startDashboardServer({
      identityKey: '7'.repeat(64),
      merchantId: 'merchantA',
      token,
      classify,
      pool: {
        connect: async () => {
          reads++;
          throw new Error();
        },
      },
    });
    try {
      const response = await fetch(server.url + '/query', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ question: 'hello' }),
      });
      assert.ok([422, 503].includes(response.status));
      assert.ok(!(await response.text()).includes('private-provider-error'));
      assert.equal(reads, 0);
    } finally {
      await server.close();
    }
  }
});
test('one active query is bounded and provider timeout aborts without holding a database client', async (t) => {
  let signal,
    reads = 0;
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const server = await startDashboardServer({
    identityKey: '7'.repeat(64),
    merchantId: 'merchantA',
    token,
    classify: async (_q, s) => {
      signal = s;
      started();
      return new Promise(() => {});
    },
    pool: {
      connect: async () => {
        reads++;
        throw new Error();
      },
    },
  });
  t.after(() => server.close());
  const send = () =>
    fetch(server.url + '/query', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ question: 'hello' }),
    });
  const pending = send();
  await entered;
  assert.equal((await send()).status, 503);
  assert.equal((await pending).status, 503);
  assert.equal(signal.aborted, true);
  assert.equal(reads, 0);
});
test('Claude rejects truncated, oversized, non-text and failed responses without retries', async () => {
  for (const response of [
    new Response('no', { status: 429 }),
    new Response('x'.repeat(17000)),
    Response.json({ type: 'message', stop_reason: 'max_tokens', content: [] }),
    Response.json({
      type: 'message',
      stop_reason: 'end_turn',
      content: [{ type: 'tool_use', name: 'write' }],
    }),
  ]) {
    let calls = 0;
    const classify = claudeQuery({
      apiKey: 'test-only',
      model: 'configured-model',
      fetchImpl: async () => {
        calls++;
        return response;
      },
    });
    await assert.rejects(() => classify('hello', AbortSignal.timeout(1000)));
    assert.equal(calls, 1);
  }
});
