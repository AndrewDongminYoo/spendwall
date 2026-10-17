// `Gllbn` is a fragment of a base64 synthetic Basic credential; `reconcil` is a
// deliberate partial-match stem in a rejection assertion.
// cspell:ignore Gllbn reconcil
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { createTokenManager } from '../apps/firewall/src/token.ts';
import { RefundExecutor } from '../apps/firewall/src/refunds.ts';

const env = {
  PAYPAL_CLIENT_ID: 'fake-client',
  PAYPAL_CLIENT_SECRET: 'fake-secret',
};
const captureId = 'CAPTURE12345678901';
const executionId = 'e3857242-30c3-4772-8b4c-218df041e6cd';
const args = { capture_id: captureId };
const refund = {
  id: 'REFUND123456789012',
  status: 'COMPLETED',
  amount: { value: '5.00', currency_code: 'USD' },
  links: [
    {
      rel: 'up',
      href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}`,
      method: 'GET',
    },
  ],
};

test('read-only reconciliation never creates a new provider execution', async (t) => {
  const f = await fixture(t);
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  await assert.rejects(executor.reconcile(executionId, args));
  assert.equal(f.seen.posts.length, 0);
  assert.equal(f.seen.captureGets, 0);
});

test('a recovery deadline reached during lookup prevents refund POST', async (t) => {
  let clock = 100_000;
  const f = await fixture(t, { now: () => clock });
  const original = f.fetchImpl;
  f.fetchImpl = async (input, init) => {
    const response = await original(input, init);
    if (new URL(input).pathname === `/v2/payments/captures/${captureId}`)
      clock = 200_000;
    return response;
  };
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  await assert.rejects(
    executor.execute(executionId, args, { notAfter: 200_000 }),
  );
  assert.equal(f.seen.posts.length, 0);
});

test('read-only reconciliation verifies a known refund through GET after the replay window', async (t) => {
  let clock = 100_000;
  const f = await fixture(t, { now: () => clock });
  let executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  const result = await executor.execute(executionId, args);
  await executor.close();
  executor = await RefundExecutor.open(f);
  clock += 25 * 60 * 60 * 1000;
  assert.deepEqual(await executor.reconcile(executionId, args), result);
  assert.deepEqual(f.seen.gets, [`/v2/payments/refunds/${refund.id}`]);
  assert.equal(f.seen.posts.length, 1);
});

for (const status of ['FAILED', 'CANCELLED']) {
  test(`read-only reconciliation recovers a durable ${status} result after restart`, async (t) => {
    const result = { ...refund, status };
    const f = await fixture(t, {
      onPost(_req, res) {
        res.end(JSON.stringify(result));
      },
      getRefund: result,
    });
    let executor = await RefundExecutor.open(f);
    f.after(() => executor.close());
    const first = await executor.execute(executionId, args);
    await executor.close();
    executor = await RefundExecutor.open(f);
    assert.deepEqual(await executor.reconcile(executionId, args), first);
    assert.deepEqual(f.seen.gets, [`/v2/payments/refunds/${refund.id}`]);
    assert.equal(f.seen.posts.length, 1);
  });
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'spendwall-refund-'));
  const ledgerPath = join(
    dir,
    options.ledgerSubdirectory ?? '',
    'refunds.json',
  );
  const seen = { tokens: 0, posts: [], gets: [], captureGets: 0 };
  const cleanups = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/oauth2/token') {
      assert.equal(
        req.headers.authorization,
        'Basic ZmFrZS1jbGllbnQ6ZmFrZS1zZWNyZXQ=',
      );
      seen.tokens++;
      res.end(
        JSON.stringify({
          access_token: `private-token-${seen.tokens}`,
          token_type: 'Bearer',
          expires_in: options.expiresIn ?? 10,
        }),
      );
    } else if (
      req.method === 'GET' &&
      req.url === `/v2/payments/captures/${captureId}`
    ) {
      seen.captureGets++;
      res.end(
        JSON.stringify(
          options.capture ?? {
            id: captureId,
            status: 'COMPLETED',
            amount: { value: '5.00', currency_code: 'USD' },
          },
        ),
      );
    } else if (
      req.method === 'POST' &&
      req.url === `/v2/payments/captures/${captureId}/refund`
    ) {
      const saved = JSON.parse(await readFile(ledgerPath, 'utf8'));
      const post = { headers: req.headers, body: JSON.parse(text), saved };
      seen.posts.push(post);
      if (options.onPost) await options.onPost(req, res, post, seen);
      else res.end(JSON.stringify(refund));
    } else if (
      req.method === 'GET' &&
      req.url === `/v2/payments/refunds/${refund.id}`
    ) {
      seen.gets.push(req.url);
      res.end(JSON.stringify(options.getRefund ?? refund));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const fetchImpl = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, 'https://api-m.sandbox.paypal.com');
    return fetch(origin + url.pathname, init);
  };
  return {
    ledgerPath,
    seen,
    fetchImpl,
    env,
    ...options,
    after: (cleanup) => cleanups.push(cleanup),
  };
}

test('short token expiry drives renewal and concurrent callers share one refresh', async (t) => {
  const f = await fixture(t);
  let clock = 100_000;
  const manager = createTokenManager({ ...f, now: () => clock });
  assert.deepEqual(
    await Promise.all([manager.get(), manager.get(), manager.get()]),
    ['private-token-1', 'private-token-1', 'private-token-1'],
  );
  clock += 8_000;
  assert.equal(await manager.get(), 'private-token-1');
  clock += 1_100;
  assert.equal(await manager.get(), 'private-token-2');
  manager.invalidate('private-token-1');
  assert.equal(await manager.get(), 'private-token-2');
  assert.equal(f.seen.tokens, 2);
});

test('refund binding is durable before POST and duplicates survive concurrency and restart', async (t) => {
  const f = await fixture(t);
  let executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  const [first, duplicate] = await Promise.all([
    executor.execute(executionId, args),
    executor.execute(executionId, args),
  ]);
  assert.equal(first?.id, refund.id);
  assert.deepEqual(duplicate, first);
  assert.equal(f.seen.posts.length, 1);
  const post = f.seen.posts[0];
  assert.equal(post.headers['paypal-request-id'], executionId);
  assert.equal(post.headers.authorization, 'Bearer private-token-1');
  assert.deepEqual(post.body, {
    amount: { value: '5.00', currency_code: 'USD' },
  });
  assert.equal(post.saved.executions[executionId].status, 'unknown');
  assert.deepEqual(post.saved.executions[executionId].body, post.body);
  await executor.close();
  executor = await RefundExecutor.open(f);
  assert.deepEqual(await executor.execute(executionId, args), first);
  assert.equal(f.seen.posts.length, 1);
  const disk = await readFile(f.ledgerPath, 'utf8');
  assert.doesNotMatch(disk, /private-token|fake-secret|Authorization/);
});

test('a changed request cannot reuse an execution ID', async (t) => {
  const f = await fixture(t);
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  await executor.execute(executionId, args);
  await assert.rejects(
    executor.execute(executionId, {
      ...args,
      amount: { value: '1.00', currency_code: 'USD' },
    }),
    /bound|different/i,
  );
  assert.equal(f.seen.posts.length, 1);
});

test('ambiguous upstream failure replays the same persisted request after restart', async (t) => {
  const f = await fixture(t, {
    onPost(_req, res, _post, seen) {
      res.statusCode = seen.posts.length === 1 ? 500 : 200;
      res.end(
        JSON.stringify(
          seen.posts.length === 1
            ? { secret: 'private-token-sensitive' }
            : refund,
        ),
      );
    },
  });
  let executor = await RefundExecutor.open(f);
  await assert.rejects(executor.execute(executionId, args), /unknown/i);
  await executor.close();
  executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  assert.equal((await executor.execute(executionId, args)).id, refund.id);
  assert.equal(f.seen.posts.length, 2);
  assert.deepEqual(
    f.seen.posts.map((p) => p.headers['paypal-request-id']),
    [executionId, executionId],
  );
  assert.deepEqual(f.seen.posts[0].body, f.seen.posts[1].body);
  assert.equal(f.seen.captureGets, 1);
});

test('401 refresh retains the exact refund ID and body and stops after one retry', async (t) => {
  const f = await fixture(t, {
    onPost(_req, res) {
      res.statusCode = 401;
      res.end('{"secret":"fake-secret"}');
    },
  });
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  await assert.rejects(
    executor.execute(executionId, args),
    (error) => /401/.test(error.message) && !/fake-secret/.test(error.message),
  );
  assert.equal(f.seen.tokens, 2);
  assert.equal(f.seen.posts.length, 2);
  assert.equal(f.seen.posts[1].headers.authorization, 'Bearer private-token-2');
  assert.equal(f.seen.posts[1].headers['paypal-request-id'], executionId);
  assert.deepEqual(f.seen.posts[0].body, f.seen.posts[1].body);
});

test('expired unknown execution refuses another POST', async (t) => {
  let clock = Date.now();
  const f = await fixture(t, {
    now: () => clock,
    onPost(_req, res) {
      res.statusCode = 500;
      res.end('{}');
    },
  });
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  await assert.rejects(executor.execute(executionId, args), /unknown/i);
  clock += 24 * 60 * 60 * 1_000;
  await assert.rejects(executor.execute(executionId, args), /reconcil/i);
  assert.equal(f.seen.posts.length, 1);
});

test('timeout preserves unknown execution and never starts automatic retries', async (t) => {
  const f = await fixture(t, { timeoutMs: 40, onPost() {} });
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  const began = Date.now();
  await assert.rejects(executor.execute(executionId, args), /unknown/i);
  assert.ok(Date.now() - began < 2_000);
  assert.equal(f.seen.posts.length, 1);
  assert.equal(
    JSON.parse(await readFile(f.ledgerPath)).executions[executionId].status,
    'unknown',
  );
});

test('a second process owner and a changed sandbox app cannot use the ledger', async (t) => {
  const f = await fixture(t);
  const executor = await RefundExecutor.open(f);
  await assert.rejects(RefundExecutor.open(f), /lock|running/i);
  await executor.execute(executionId, args);
  await executor.close();
  await assert.rejects(
    RefundExecutor.open({
      ...f,
      env: { ...env, PAYPAL_CLIENT_ID: 'other-client' },
    }),
    /app|client/i,
  );
  assert.equal(f.seen.posts.length, 1);
});

test('invalid IDs, fields, amounts and partially refunded captures never reach refund POST', async (t) => {
  const f = await fixture(t, {
    capture: {
      id: captureId,
      status: 'PARTIALLY_REFUNDED',
      amount: { value: '5.00', currency_code: 'USD' },
    },
  });
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  for (const invalid of [
    { ...args, unexpected: 'field' },
    { ...args, amount: { value: '-1.00', currency_code: 'USD' } },
    { ...args, amount: { value: '1.001', currency_code: 'USD' } },
    { ...args, amount: { value: '1.00', currency_code: 'EUR' } },
    { capture_id: '../refund' },
  ])
    await assert.rejects(executor.execute(executionId, invalid));
  await assert.rejects(executor.execute('bad', args));
  assert.equal(f.seen.captureGets, 0);
  await assert.rejects(executor.execute(executionId, args), /capture/i);
  assert.equal(f.seen.posts.length, 0);
});

test('malformed or mismatched successful refunds remain unknown', async (t) => {
  const f = await fixture(t, {
    onPost(_req, res) {
      res.end(
        JSON.stringify({
          ...refund,
          amount: { value: '9.00', currency_code: 'USD' },
        }),
      );
    },
  });
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  await assert.rejects(executor.execute(executionId, args), /unknown/i);
  assert.equal(
    JSON.parse(await readFile(f.ledgerPath)).executions[executionId].status,
    'unknown',
  );
});

test('pending refund is reconciled by GET without another POST', async (t) => {
  const f = await fixture(t, {
    onPost(_req, res) {
      res.end(JSON.stringify({ ...refund, status: 'PENDING' }));
    },
  });
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  assert.equal((await executor.execute(executionId, args)).status, 'PENDING');
  assert.equal((await executor.execute(executionId, args)).status, 'COMPLETED');
  assert.equal(f.seen.posts.length, 1);
  assert.equal(f.seen.gets.length, 1);
});

test('corrupt ledger fails closed before authentication or payment', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.ledgerPath,
    '{"schemaVersion":1,"executions":{"broken":{}}}',
  );
  await assert.rejects(RefundExecutor.open(f), /ledger/i);
  assert.equal(f.seen.tokens, 0);
  assert.equal(f.seen.posts.length, 0);
});

test('UUID case cannot create a second logical refund', async (t) => {
  const f = await fixture(t);
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  const first = await executor.execute(executionId, args);
  assert.deepEqual(
    await executor.execute(executionId.toUpperCase(), args),
    first,
  );
  assert.equal(f.seen.posts.length, 1);
});

test('a client error after a lost refund response does not establish failure', async (t) => {
  const f = await fixture(t, {
    onPost(_req, res, _post, seen) {
      res.statusCode = seen.posts.length === 1 ? 500 : 422;
      res.end('{}');
    },
  });
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  await assert.rejects(executor.execute(executionId, args), /unknown/i);
  await assert.rejects(executor.execute(executionId, args), /unknown/i);
  assert.equal(
    JSON.parse(await readFile(f.ledgerPath)).executions[executionId].status,
    'unknown',
  );
});

test('a failed durable save prevents later execution in the same process', async (t) => {
  const f = await fixture(t);
  let refundPosts = 0;
  const executor = await RefundExecutor.open({
    ...f,
    fetchImpl(input, init) {
      if (init?.method === 'POST' && String(input).endsWith('/refund')) {
        refundPosts++;
        return Promise.resolve(Response.json(refund));
      }
      return f.fetchImpl(input, init);
    },
  });
  f.after(() => executor.close());
  await mkdir(f.ledgerPath);
  await assert.rejects(executor.execute(executionId, args), /saved|reconcile/i);
  await rm(f.ledgerPath, { recursive: true });
  await assert.rejects(executor.execute(executionId, args), /saved|reconcile/i);
  assert.equal(refundPosts, 0);
});

test('documented sandbox link aliases preserve capture binding', async (t) => {
  const f = await fixture(t, {
    onPost(_req, res) {
      res.end(
        JSON.stringify({
          ...refund,
          links: [
            {
              rel: 'up',
              href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`,
            },
          ],
        }),
      );
    },
  });
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  assert.equal((await executor.execute(executionId, args)).id, refund.id);
  assert.equal(f.seen.posts.length, 1);
});

test('new ledger directories are persisted in every created ancestor before refunds', async (t) => {
  const f = await fixture(t, { ledgerSubdirectory: 'new/nested' });
  const createdParent = dirname(dirname(f.ledgerPath));
  const stableParent = dirname(createdParent);
  const handle = await open(stableParent, 'r');
  const originalSync = handle.sync;
  const prototype = Object.getPrototypeOf(handle);
  const stableInode = (await handle.stat()).ino;
  await handle.close();
  const synced = [];
  let failOnce = true;
  t.mock.method(prototype, 'sync', async function () {
    const details = await this.stat();
    if (details.isDirectory()) synced.push(details.ino);
    if (details.ino === stableInode && failOnce) {
      failOnce = false;
      throw new Error('Simulated parent sync failure');
    }
    return originalSync.call(this);
  });
  await assert.rejects(RefundExecutor.open(f), /Simulated parent sync failure/);
  assert.equal(f.seen.tokens, 0);
  synced.length = 0;
  const executor = await RefundExecutor.open(f);
  f.after(() => executor.close());
  const required = await Promise.all(
    [createdParent, stableParent].map(async (dir) => (await stat(dir)).ino),
  );
  assert.deepEqual(
    synced.slice(0, required.length),
    required,
    'Each new directory entry must be synced in its parent before any refund can execute',
  );
  await executor.execute(executionId, args);
  assert.equal(f.seen.posts.length, 1);
});
