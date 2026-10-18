import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { startWebhookServer } from '../apps/firewall/src/webhooks/server.ts';
import { WebhookError } from '../apps/firewall/src/webhooks/paypal.ts';

test('listener passes the unchanged UTF-8 body to verification', async (t) => {
  const raw =
    ' \r\n{ "id": "WH-raw", "escaped": "\\u0061", "number": 1e3 }\r\n';
  let received;
  const server = await startWebhookServer({
    verifier: {
      verify: async (_headers, body) => {
        received = body;
        return null;
      },
    },
    receive: async () => {},
  });
  t.after(server.close);
  const res = await fetch(`${server.url}/webhooks/paypal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
  assert.equal(res.status, 200);
  assert.equal(received, raw);
});

test('loopback webhook acknowledges only verified and durably received events', async (t) => {
  let mode = 'valid',
    received = 0,
    verified = 0;
  const server = await startWebhookServer({
    verifier: {
      verify: async () => {
        verified++;
        if (mode === 'forged') throw new WebhookError(401);
        if (mode === 'provider') throw new WebhookError(503);
        return mode === 'ignored' ? null : { eventId: 'WH-test' };
      },
    },
    receive: async () => {
      if (mode === 'storage') throw new Error('private SQL');
      if (mode === 'declined') return 'ignored';
      received++;
    },
  });
  t.after(server.close);
  const send = (options = {}) =>
    fetch(`${server.url}/webhooks/paypal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      ...options,
    });
  const first = await send();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { status: 'received' });
  assert.equal(received, 1);
  for (const [next, code] of [
    ['forged', 401],
    ['provider', 503],
    ['storage', 503],
    ['ignored', 200],
    ['declined', 200],
  ]) {
    mode = next;
    const res = await send();
    assert.equal(res.status, code);
    const text = await res.text();
    assert.equal(text.includes('private'), false);
    if (code === 200) assert.deepEqual(JSON.parse(text), { status: 'ignored' });
    assert.equal(received, 1);
  }
  const before = verified;
  assert.equal((await send({ body: '{bad' })).status, 400);
  assert.equal(
    (await send({ body: JSON.stringify({ data: 'x'.repeat(66000) }) })).status,
    413,
  );
  assert.equal(
    (await send({ headers: { 'content-type': 'text/plain' } })).status,
    415,
  );
  assert.equal(
    (
      await send({
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.invalid',
        },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${server.url}/webhooks/paypal`)).status, 405);
  assert.equal((await fetch(`${server.url}/other`)).status, 404);
  assert.equal(verified, before);
});
test('duplicate transmission headers are rejected before verification', async (t) => {
  let verified = false;
  const server = await startWebhookServer({
    verifier: {
      verify: async () => {
        verified = true;
        return null;
      },
    },
    receive: async () => {},
  });
  t.after(server.close);
  const code = await new Promise((resolve, reject) => {
    const req = http.request(
      `${server.url}/webhooks/paypal`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'paypal-transmission-id': ['first', 'second'],
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(code, 400);
  assert.equal(verified, false);
});
test('bounded in-flight verification rejects excess delivery without processing it', async (t) => {
  let verified = 0,
    release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const server = await startWebhookServer({
    verifier: {
      verify: async () => {
        verified++;
        await wait;
        return null;
      },
    },
    receive: async () => {},
  });
  t.after(server.close);
  const send = () =>
    fetch(`${server.url}/webhooks/paypal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  const pending = Array.from({ length: 4 }, send);
  try {
    for (let i = 0; i < 100 && verified < 4; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(verified, 4);
    assert.equal((await send()).status, 503);
    assert.equal(verified, 4);
  } finally {
    release();
    await Promise.all(pending);
  }
});
