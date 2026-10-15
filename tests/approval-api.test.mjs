import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FcmSender } from '../apps/firewall/src/approver/fcm.ts';
import { startApproverServer } from '../apps/firewall/src/approver/server.ts';
import { request } from 'node:http';

const id = '00000000-0000-4000-8000-000000000001';
test('oversized fixed and chunked JSON receives 413 without accessing storage', async () => {
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
  try {
    for (const chunked of [false, true]) {
      const body = JSON.stringify({ padding: 'x'.repeat(100000) });
      const response = await new Promise((resolve, reject) => {
        const req = request(
          app.url + '/devices/register',
          {
            method: 'POST',
            headers: {
              authorization: 'Bearer synthetic',
              'content-type': 'application/json',
              ...(chunked ? {} : { 'content-length': Buffer.byteLength(body) }),
            },
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (part) => (text += part));
            res.on('end', () =>
              resolve({
                code: res.statusCode,
                cache: res.headers['cache-control'],
                body: JSON.parse(text),
              }),
            );
          },
        );
        req.on('error', reject);
        req.write(body.slice(0, 20000));
        req.end(body.slice(20000));
      });
      assert.equal(response.code, 413);
      assert.equal(response.cache, 'no-store');
      assert.deepEqual(response.body, { error: 'Request is too large.' });
    }
    assert.equal(connections, 0);
  } finally {
    await app.close();
  }
});
test('FCM uses the HTTP v1 target and a data-only approval UUID', async () => {
  const seen = [];
  const sender = new FcmSender({
    projectId: 'synthetic-project',
    getAccessToken: async () => 'synthetic-google-token',
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return Response.json({ name: 'projects/synthetic-project/messages/one' });
    },
  });
  await sender.send('synthetic-device-token', id);
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].url,
    'https://fcm.googleapis.com/v1/projects/synthetic-project/messages:send',
  );
  assert.equal(
    seen[0].options.headers.authorization,
    'Bearer synthetic-google-token',
  );
  assert.equal(seen[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(seen[0].options.body), {
    message: { token: 'synthetic-device-token', data: { approval_id: id } },
  });
});

test('missing or slow Google authorization cannot send a notification', async () => {
  for (const getAccessToken of [
    async () => null,
    () => new Promise(() => {}),
  ]) {
    let sends = 0;
    const sender = new FcmSender({
      projectId: 'synthetic-project',
      getAccessToken,
      timeoutMs: 20,
      fetchImpl: async () => {
        sends++;
        return Response.json({});
      },
    });
    await assert.rejects(
      sender.send('synthetic-device-token', id),
      /Notification unavailable/,
    );
    assert.equal(sends, 0);
  }
});

test('FCM provider errors and redirects use a constant safe failure', async () => {
  for (const response of [
    Response.json(
      { error: { message: 'synthetic-private-provider-detail' } },
      { status: 429 },
    ),
    new Response(null, {
      status: 302,
      headers: { location: 'https://other.invalid' },
    }),
    Response.json({ name: 'projects/other-project/messages/wrong' }),
  ]) {
    const sender = new FcmSender({
      projectId: 'synthetic-project',
      getAccessToken: async () => 'synthetic-token',
      fetchImpl: async () => response,
    });
    await assert.rejects(sender.send('synthetic-device-token', id), {
      message: 'Notification unavailable.',
    });
  }
});
