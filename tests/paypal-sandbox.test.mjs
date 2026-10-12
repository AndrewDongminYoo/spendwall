import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { checkSandboxToken } from '../scripts/check-paypal-sandbox.mjs';

const env = {
  PAYPAL_CLIENT_ID: 'test-client',
  PAYPAL_CLIENT_SECRET: 'test-secret',
};
const token = {
  access_token: 'test-token-do-not-print',
  token_type: 'Bearer',
  expires_in: 120,
};

test('exchanges credentials only at the sandbox endpoint and returns safe metadata', async () => {
  let calls = 0;
  const result = await checkSandboxToken({
    env,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://api-m.sandbox.paypal.com/v1/oauth2/token');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, 'grant_type=client_credentials');
      assert.equal(
        options.headers.Authorization,
        `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`,
      );
      assert.equal(
        options.headers['Content-Type'],
        'application/x-www-form-urlencoded',
      );
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(token);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    environment: 'sandbox',
    token_type: 'Bearer',
    expires_in: 120,
  });
});

test('missing credentials fail before any HTTP request', async () => {
  for (const credentials of [{}, { ...env, PAYPAL_CLIENT_SECRET: ' ' }]) {
    await assert.rejects(
      checkSandboxToken({
        env: credentials,
        fetchImpl: () => assert.fail('Must not contact PayPal'),
      }),
      { message: 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET locally.' },
    );
  }
});

test('rejects HTTP failures without reading or exposing the body', async () => {
  await assert.rejects(
    checkSandboxToken({
      env,
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: () => assert.fail('Must not read an error body'),
      }),
    }),
    { message: 'PayPal sandbox token request failed (HTTP 401).' },
  );
});

test('network and timeout errors cannot expose request secrets', async () => {
  for (const name of ['TypeError', 'TimeoutError']) {
    await assert.rejects(
      checkSandboxToken({
        env,
        fetchImpl: async () => {
          const error = new Error(env.PAYPAL_CLIENT_SECRET);
          error.name = name;
          throw error;
        },
      }),
      {
        message:
          'PayPal sandbox request failed or timed out; no credentials were logged.',
      },
    );
  }
});

test('rejects invalid token responses', async () => {
  for (const body of [
    null,
    {},
    { ...token, access_token: '' },
    { ...token, token_type: 'Basic' },
    { ...token, expires_in: 0 },
    { ...token, expires_in: '120' },
  ]) {
    await assert.rejects(
      checkSandboxToken({ env, fetchImpl: async () => Response.json(body) }),
      { message: 'PayPal sandbox returned an invalid token response.' },
    );
  }
  await assert.rejects(
    checkSandboxToken({ env, fetchImpl: async () => new Response('not JSON') }),
    { message: 'PayPal sandbox returned an invalid token response.' },
  );
});

test('CLI exits unsuccessfully and prints a safe credential hint when unset', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/check-paypal-sandbox.mjs'],
    {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr.trim(),
    'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET locally.',
  );
});
