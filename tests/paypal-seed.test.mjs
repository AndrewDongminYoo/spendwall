import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { seedSandbox } from '../scripts/seed.mjs';

const env = {
  PAYPAL_CLIENT_ID: 'seed-client',
  PAYPAL_CLIENT_SECRET: 'seed-secret',
};
const token = 'seed-token';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'spendwall-seed-'));
  const output = join(directory, 'captures.json');
  const requests = [];
  const paid = new Map();
  const control = {
    failAfter: Infinity,
    ambiguous: false,
    transform: (body) => body,
  };
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.url === '/v1/oauth2/token') {
      assert.equal(
        request.headers.authorization,
        `Basic ${Buffer.from('seed-client:seed-secret').toString('base64')}`,
      );
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          access_token: token,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      return;
    }
    assert.equal(request.url, '/v2/checkout/orders');
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers.prefer, 'return=representation');
    const body = JSON.parse(raw);
    const requestId = request.headers['paypal-request-id'];
    const state = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(
      state.pending.entries.some(
        (entry) => entry.requestId === requestId && entry.startedAt,
      ),
    );
    requests.push({ requestId, body });
    if (control.httpStatus) {
      response.writeHead(control.httpStatus).end('seed-secret seed-token');
      return;
    }
    if (control.hold) await control.hold;
    if (control.hang) return;
    if (paid.size >= control.failAfter && !paid.has(requestId)) {
      response.writeHead(503).end('seed-secret seed-token');
      return;
    }
    if (!paid.has(requestId)) {
      const index = paid.size + 1;
      paid.set(requestId, {
        id: `ORDER${index}`,
        status: 'COMPLETED',
        purchase_units: [
          {
            custom_id: body.purchase_units[0].custom_id,
            payments: {
              captures: [
                {
                  id: `CAPTURE${index}`,
                  status: 'COMPLETED',
                  amount: body.purchase_units[0].amount,
                },
              ],
            },
          },
        ],
      });
      if (control.ambiguous) {
        control.ambiguous = false;
        response.writeHead(500).end('seed-secret seed-token');
        return;
      }
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(control.transform(structuredClone(paid.get(requestId)))),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const fetchImpl = (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api-m.sandbox.paypal.com');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    return fetch(
      `http://127.0.0.1:${server.address().port}${url.pathname}`,
      init,
    );
  };
  const options = { output, env, fetchImpl, sleep: async () => {} };
  return { directory, output, options, requests, paid, control };
}

test(
  'two runs capture 20 distinct USD payments each and preserve prior fixtures',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const first = await seedSandbox(f.options);
    assert.equal(first.added, 20);
    const before = JSON.parse(await readFile(f.output, 'utf8'));
    assert.equal(before.environment, 'sandbox');
    assert.equal(before.pending, null);
    assert.equal(before.captures.length, 20);
    const amounts = before.captures.map((capture) => Number(capture.amount));
    assert.equal(
      amounts.filter((amount) => amount >= 5 && amount <= 40).length,
      5,
    );
    assert.equal(
      amounts.filter((amount) => amount >= 80 && amount <= 500).length,
      5,
    );
    const small = before.captures.filter(
      (capture) => Number(capture.amount) < 5,
    );
    assert.equal(small.length, 10);
    assert.equal(new Set(small.map((capture) => capture.customerId)).size, 1);
    assert.ok(
      before.captures.every(
        (capture) =>
          capture.currency === 'USD' && capture.orderId && capture.id,
      ),
    );
    const second = await seedSandbox(f.options);
    const after = JSON.parse(await readFile(f.output, 'utf8'));
    assert.equal(second.added, 20);
    assert.equal(second.total, 40);
    assert.deepEqual(after.captures.slice(0, 20), before.captures);
    assert.equal(new Set(after.captures.map((capture) => capture.id)).size, 40);
    assert.equal(
      new Set(f.requests.map((request) => request.requestId)).size,
      40,
    );
    assert.ok(
      f.requests.every(
        ({ body }) =>
          body.intent === 'CAPTURE' &&
          body.payment_source.card.number === '4012888888881881',
      ),
    );
    const text = await readFile(f.output, 'utf8');
    for (const secret of [
      env.PAYPAL_CLIENT_ID,
      env.PAYPAL_CLIENT_SECRET,
      token,
      '4012888888881881',
    ])
      assert.ok(!text.includes(secret));
    assert.deepEqual(await readdir(f.directory), ['captures.json']);
  },
);

test('an ambiguous create failure replays the identical request and records one capture', async (t) => {
  const f = await fixture(t);
  f.control.ambiguous = true;
  assert.equal((await seedSandbox(f.options)).total, 20);
  assert.equal(f.paid.size, 20);
  assert.equal(f.requests.length, 21);
  assert.deepEqual(f.requests[0], f.requests[1]);
});

test('an interrupted batch resumes unfinished requests without replacing completed captures', async (t) => {
  const f = await fixture(t);
  f.control.failAfter = 2;
  await assert.rejects(seedSandbox(f.options), /HTTP 503/);
  const before = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(before.captures.length, 2);
  assert.equal(f.requests.length, 5);
  const pendingRequest = f.requests.at(-1);
  f.control.failAfter = Infinity;
  const result = await seedSandbox(f.options);
  const after = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(result.added, 18);
  assert.equal(result.total, 20);
  assert.deepEqual(after.captures.slice(0, 2), before.captures);
  assert.deepEqual(f.requests[5], pendingRequest);
  assert.equal(f.paid.size, 20);
  assert.equal(after.pending, null);
});

test('expired replay and a different client are refused before network activity', async (t) => {
  const f = await fixture(t);
  const start = new Date('2026-10-13T00:00:00Z');
  f.control.failAfter = 0;
  await assert.rejects(
    seedSandbox({ ...f.options, now: () => start }),
    /HTTP 503/,
  );
  const before = await readFile(f.output, 'utf8');
  const noFetch = () => assert.fail('Unexpected network activity');
  await assert.rejects(
    seedSandbox({
      ...f.options,
      now: () => new Date('2026-10-13T06:00:00Z'),
      fetchImpl: noFetch,
    }),
    /reconciliation/i,
  );
  await assert.rejects(
    seedSandbox({
      ...f.options,
      env: { ...env, PAYPAL_CLIENT_ID: 'different-client' },
      fetchImpl: noFetch,
    }),
    /different sandbox app/i,
  );
  assert.equal(await readFile(f.output, 'utf8'), before);
});

test('a concurrent writer is refused while the first process holds the fixture lock', async (t) => {
  const f = await fixture(t);
  let release;
  f.control.hold = new Promise((resolve) => {
    release = resolve;
  });
  const first = seedSandbox(f.options);
  try {
    for (let tries = 0; f.requests.length === 0 && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.requests.length, 1);
    await assert.rejects(
      seedSandbox({
        ...f.options,
        fetchImpl: () => assert.fail('Concurrent network call'),
      }),
      /locked/i,
    );
  } finally {
    release();
    await first;
  }
});

test('pending, declined, mismatched and uncorrelated captures are never recorded', async (t) => {
  for (const transform of [
    (body) => {
      body.status = 'PAYER_ACTION_REQUIRED';
      return body;
    },
    (body) => {
      body.purchase_units[0].payments.captures[0].status = 'DECLINED';
      return body;
    },
    (body) => {
      body.purchase_units[0].payments.captures[0].amount.value = '999.00';
      return body;
    },
    (body) => {
      body.purchase_units[0].payments.captures[0].amount.currency_code = 'EUR';
      return body;
    },
    (body) => {
      body.purchase_units[0].custom_id = 'wrong-customer';
      return body;
    },
  ]) {
    const f = await fixture(t);
    f.control.transform = transform;
    await assert.rejects(
      seedSandbox(f.options),
      /capture.*valid|completed capture/i,
    );
    const state = JSON.parse(await readFile(f.output, 'utf8'));
    assert.equal(state.captures.length, 0);
    assert.ok(state.pending);
    assert.equal(f.requests.length, 1);
  }
});

test('duplicate upstream IDs stop before corrupting the saved ledger', async (t) => {
  const f = await fixture(t);
  f.control.transform = (body) => {
    body.purchase_units[0].payments.captures[0].id = 'SAMECAPTURE';
    return body;
  };
  await assert.rejects(seedSandbox(f.options), /duplicate/i);
  assert.equal(JSON.parse(await readFile(f.output, 'utf8')).captures.length, 1);
});

test('missing identifiers and malformed successful representations are rejected', async (t) => {
  for (const transform of [
    (body) => {
      delete body.id;
      return body;
    },
    (body) => {
      delete body.purchase_units[0].payments.captures[0].id;
      return body;
    },
    (body) => {
      delete body.purchase_units;
      return body;
    },
  ]) {
    const f = await fixture(t);
    f.control.transform = transform;
    await assert.rejects(seedSandbox(f.options), /valid completed capture/);
    assert.equal(
      JSON.parse(await readFile(f.output, 'utf8')).captures.length,
      0,
    );
  }
});

test('missing credentials and malformed fixtures cause no network requests', async (t) => {
  const f = await fixture(t);
  const fetchImpl = () => assert.fail('Unexpected network activity');
  await assert.rejects(
    seedSandbox({ ...f.options, env: {}, fetchImpl }),
    /PAYPAL_CLIENT_ID/,
  );
  await writeFile(f.output, '{invalid');
  await assert.rejects(seedSandbox({ ...f.options, fetchImpl }), /fixture/i);
  assert.equal(await readFile(f.output, 'utf8'), '{invalid');
});

test(
  'bounded timeouts retain the pending request and redact upstream content',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    f.control.hang = true;
    const started = Date.now();
    await assert.rejects(
      seedSandbox({ ...f.options, timeoutMs: 40 }),
      (error) => {
        assert.match(error.message, /timed out|request failed/i);
        assert.ok(!error.message.includes(token));
        assert.ok(!error.message.includes(env.PAYPAL_CLIENT_SECRET));
        return true;
      },
    );
    assert.ok(Date.now() - started < 2000);
    const state = JSON.parse(await readFile(f.output, 'utf8'));
    assert.equal(state.captures.length, 0);
    assert.equal(
      new Set(f.requests.map((request) => request.requestId)).size,
      1,
    );
    assert.deepEqual(await readdir(f.directory), ['captures.json']);
  },
);

test('the CLI rejects invalid arguments and missing credentials without writing captures', async (t) => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL('../scripts/seed.mjs', import.meta.url));
  const childEnv = {
    ...process.env,
    PAYPAL_CLIENT_ID: '',
    PAYPAL_CLIENT_SECRET: '',
  };
  for (const [args, message] of [
    [['--unknown'], /Usage: pnpm seed/],
    [
      ['--output', f.output],
      /Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET locally/,
    ],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      env: childEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(f.requests.length, 0);
});

test('an order authentication failure names credentials and retains safe diagnostics', async (t) => {
  const f = await fixture(t);
  f.control.httpStatus = 401;
  await assert.rejects(seedSandbox(f.options), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.match(error.message, /credentials/);
    assert.ok(!error.message.includes(env.PAYPAL_CLIENT_SECRET));
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.equal(f.requests.length, 1);
});
