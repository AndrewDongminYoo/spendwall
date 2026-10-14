import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ContextResolver } from '../apps/firewall/src/context/index.ts';
import { evaluatePolicy, loadPolicy } from '../packages/policy/src/index.ts';

const api = 'https://api-m.sandbox.paypal.com';
const captureId = 'CAPTURE12345678901';
const orderId = 'ORDER1234567890123';
const merchant = { id: 'MERCHANT12345', email: 'merchant@example.invalid' };
const trusted = {
  agent: { id: 'support-agent' },
  customer: {
    id: 'PAYER123456789',
    email: 'customer@example.invalid',
    vip: false,
  },
  agg: { daily_spend_usd: 0 },
};
const money = (value, currency = 'USD') => ({ value, currency_code: currency });

function records({
  original = '100.00',
  refunded = '20.00',
  currency = 'USD',
} = {}) {
  const status =
    refunded === '0.00' || refunded === '0'
      ? 'COMPLETED'
      : 'PARTIALLY_REFUNDED';
  const capture = {
    id: captureId,
    status,
    amount: money(original, currency),
    payee: { merchant_id: merchant.id },
    supplementary_data: { related_ids: { order_id: orderId } },
  };
  const refunds =
    status === 'COMPLETED'
      ? []
      : [
          {
            id: 'REFUND123456789012',
            status: 'COMPLETED',
            amount: money(refunded, currency),
            links: [
              { rel: 'up', href: `${api}/v2/payments/captures/${captureId}` },
            ],
          },
        ];
  const order = {
    id: orderId,
    status: 'COMPLETED',
    payer: { payer_id: trusted.customer.id },
    purchase_units: [
      {
        payee: { merchant_id: merchant.id },
        payments: {
          captures: [
            { id: captureId, status, amount: money(original, currency) },
          ],
          refunds,
        },
      },
    ],
  };
  return { capture, order };
}

function invoiceArgs() {
  return {
    currency_code: 'USD',
    primary_recipients: [
      { billing_info: { email_address: trusted.customer.email } },
    ],
    items: [
      { name: 'Synthetic item', quantity: '2', unit_amount: money('12.50') },
    ],
    shipping_cost: '5.00',
  };
}

function invoiceRecord() {
  const args = invoiceArgs();
  return {
    id: 'INV2-TEST-ONLY',
    status: 'DRAFT',
    detail: { currency_code: args.currency_code },
    invoicer: { email_address: merchant.email },
    primary_recipients: args.primary_recipients,
    items: args.items,
    amount: {
      ...money('30.00'),
      breakdown: {
        item_total: money('25.00'),
        shipping: { amount: money('5.00') },
      },
    },
  };
}

async function fixture(t, options = {}) {
  const data = records(options);
  const invoice = invoiceRecord();
  const seen = [];
  let handler;
  const server = createServer(async (req, res) => {
    seen.push(req.url);
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'Bearer synthetic-resolver-token');
    res.setHeader('content-type', 'application/json');
    if (handler && (await handler(req, res))) return;
    const value =
      req.url === `/v2/payments/captures/${captureId}`
        ? data.capture
        : req.url === `/v2/checkout/orders/${orderId}`
          ? data.order
          : req.url === '/v2/invoicing/invoices/INV2-TEST-ONLY'
            ? invoice
            : undefined;
    if (value === undefined) {
      res.statusCode = 404;
      res.end('{"private":"unknown-capture"}');
    } else res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  let clock = 10_000;
  const resolver = new ContextResolver({
    merchant,
    tokens: {
      async get() {
        return 'synthetic-resolver-token';
      },
      isSensitive(value) {
        return JSON.stringify(value).includes('synthetic-resolver-token');
      },
    },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, api);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.body, undefined);
      const response = await fetch(origin + url.pathname, init);
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
    now: () => clock,
    ttlMs: options.ttlMs ?? 2000,
    timeoutMs: options.timeoutMs ?? 1000,
  });
  return {
    ...data,
    invoice,
    seen,
    resolver,
    setClock(value) {
      clock = value;
    },
    setHandler(value) {
      handler = value;
    },
    resolve(args = { capture_id: captureId }, identity = trusted) {
      return resolver.resolve({ tool: 'create_refund', args }, identity);
    },
  };
}

test('partial/full refunds derive requested USD exposure and reconcile original, prior and remaining funds', async (t) => {
  const f = await fixture(t);
  const partial = await f.resolve({
    capture_id: captureId,
    amount: money('25.00'),
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.amount.usd, 25);
  assert.deepEqual(partial.context.amount, { value: '25.00', currency: 'USD' });
  const full = await f.resolve();
  assert.equal(full.ok, true);
  assert.equal(full.amount.usd, 80);
  assert.equal(full.resolvedCtx.capture.amount_minor, 10000);
  assert.equal(full.resolvedCtx.capture.refunded_minor, 2000);
  assert.equal(full.resolvedCtx.capture.remaining_minor, 8000);
  assert.equal(f.seen.length, 2);
});

for (const [currency, original, refunded, request, fullUsd, partialUsd] of [
  ['EUR', '100.00', '9.09', '25.01', 100.01, 27.52],
  ['KRW', '280001', '140000', '1400', 100.01, 1],
  ['USD', '100.00', '0.00', '1.01', 100, 1.01],
])
  test(`${currency} partial/full amounts reuse the policy's fictional upward-rounded FX`, async (t) => {
    const f = await fixture(t, { currency, original, refunded });
    assert.equal((await f.resolve()).amount.usd, fullUsd);
    assert.equal(
      (
        await f.resolve({
          capture_id: captureId,
          amount: money(request, currency),
        })
      ).amount.usd,
      partialUsd,
    );
  });

test('nonexistent capture and unknown tools deny without returning raw error details', async (t) => {
  const f = await fixture(t);
  const missing = await f.resolve({ capture_id: 'MISSING12345678901' });
  assert.equal(missing.ok, false);
  assert.equal(missing.decision, 'deny');
  assert.doesNotMatch(
    JSON.stringify(missing),
    /private|unknown-capture|Bearer|https:/,
  );
  const calls = f.seen.length;
  assert.equal(
    (await f.resolver.resolve({ tool: 'create_order', args: {} }, trusted))
      .decision,
    'deny',
  );
  assert.equal(f.seen.length, calls);
});

test('the resolver emits a policy-compatible envelope and does not authorize or accept caller USD', async (t) => {
  const f = await fixture(t);
  const result = await f.resolve();
  const policy = loadPolicy(
    'agents:\n  support-agent:\n    tools:\n      allow: [create_refund]\n      deny: []\nrules:\n  - id: small\n    when: amount.usd <= 80\n    then: allow\ndefault: deny\n',
  );
  assert.equal(evaluatePolicy(policy, result.context).decision, 'allow');
  assert.equal(
    evaluatePolicy(policy, {
      ...result.context,
      amount: { ...result.context.amount, usd: 0 },
    }).decision,
    'deny',
  );
  assert.equal(result.decision, undefined);
  assert.equal(
    (
      await f.resolve({
        capture_id: captureId,
        amount: { ...money('10.00'), usd: 0 },
      })
    ).decision,
    'deny',
  );
});

test('capture/order identity, ownership, amounts and incomplete history fail closed', async (t) => {
  for (const mutate of [
    (f) => {
      f.capture.id = 'WRONG1234567890123';
    },
    (f) => {
      f.capture.payee.merchant_id = 'OTHER-MERCHANT';
    },
    (f) => {
      delete f.capture.supplementary_data;
    },
    (f) => {
      f.order.id = 'WRONG1234567890123';
    },
    (f) => {
      f.order.payer.payer_id = 'OTHER-PAYER';
    },
    (f) => {
      f.order.purchase_units[0].payee.merchant_id = 'OTHER-MERCHANT';
    },
    (f) => {
      f.order.purchase_units[0].payments.captures[0].amount.value = '200.00';
    },
    (f) => {
      delete f.order.purchase_units[0].payments.refunds;
    },
    (f) => {
      f.order.purchase_units.push(structuredClone(f.order.purchase_units[0]));
    },
    (f) => {
      f.capture.status = 'PENDING';
    },
    (f) => {
      f.capture.amount.value = '-1.00';
    },
    (f) => {
      f.capture.amount.currency_code = 'JPY';
    },
  ])
    await t.test('invalid trusted response', async (t) => {
      const f = await fixture(t);
      mutate(f);
      assert.equal((await f.resolve()).decision, 'deny');
    });
});

test('refund history rejects duplicate/unbound/pending/currency-mismatched and inconsistent totals', async (t) => {
  for (const mutate of [
    (f) => {
      f.order.purchase_units[0].payments.refunds.push(
        structuredClone(f.order.purchase_units[0].payments.refunds[0]),
      );
    },
    (f) => {
      f.order.purchase_units[0].payments.refunds[0].links[0].href =
        'https://private.invalid/refund';
    },
    (f) => {
      f.order.purchase_units[0].payments.refunds[0].status = 'PENDING';
    },
    (f) => {
      f.order.purchase_units[0].payments.refunds[0].amount.currency_code =
        'EUR';
    },
    (f) => {
      f.order.purchase_units[0].payments.refunds[0].amount.value = '101.00';
    },
    (f) => {
      f.order.purchase_units[0].payments.refunds = [];
    },
  ])
    await t.test('invalid refund reconciliation', async (t) => {
      const f = await fixture(t);
      mutate(f);
      assert.equal((await f.resolve()).decision, 'deny');
    });
  const f = await fixture(t);
  for (const amount of [
    money('0.00'),
    money('80.01'),
    money('1.00', 'EUR'),
    money('1e2'),
    money('01.00'),
  ])
    assert.equal(
      (await f.resolve({ capture_id: captureId, amount })).decision,
      'deny',
    );
});

test('invoice creation recomputes totals and binds its single recipient and merchant', async (t) => {
  const f = await fixture(t);
  const args = invoiceArgs();
  const original = structuredClone(args);
  const result = await f.resolver.resolve(
    { tool: 'create_invoice', args },
    trusted,
  );
  assert.equal(result.ok, true);
  assert.equal(result.amount.usd, 30);
  assert.equal(result.context.customer.id, trusted.customer.id);
  assert.deepEqual(args, original);
  assert.equal(f.seen.length, 0);
  for (const mutate of [
    (a) => {
      a.primary_recipients[0].billing_info.email_address =
        'other@example.invalid';
    },
    (a) => {
      a.primary_recipients.push(structuredClone(a.primary_recipients[0]));
    },
    (a) => {
      a.items[0].quantity = '1.5';
    },
    (a) => {
      a.items[0].unit_amount.currency_code = 'EUR';
    },
    (a) => {
      a.items[0].tax = { name: 'Tax', percent: '10' };
    },
    (a) => {
      a.items[0].discount = { percent: '10' };
    },
    (a) => {
      a.allow_partial_payment = true;
    },
    (a) => {
      a.shipping_cost = '-1.00';
    },
    (a) => {
      a.invoicer_email_address = 'other@example.invalid';
    },
  ]) {
    const changed = invoiceArgs();
    mutate(changed);
    assert.equal(
      (
        await f.resolver.resolve(
          { tool: 'create_invoice', args: changed },
          trusted,
        )
      ).decision,
      'deny',
    );
  }
});

test('invoice REST total/recipient/merchant/status are checked before sending', async (t) => {
  const f = await fixture(t);
  const request = { tool: 'send_invoice', args: { invoice_id: f.invoice.id } };
  assert.equal((await f.resolver.resolve(request, trusted)).amount.usd, 30);
  for (const mutate of [
    (i) => {
      i.amount.value = '1.00';
    },
    (i) => {
      i.primary_recipients[0].billing_info.email_address =
        'other@example.invalid';
    },
    (i) => {
      i.invoicer.email_address = 'other@example.invalid';
    },
    (i) => {
      i.status = 'PAID';
    },
    (i) => {
      delete i.amount;
    },
    (i) => {
      i.amount.breakdown.discount = { invoice_discount: money('1.00') };
    },
  ]) {
    Object.assign(f.invoice, invoiceRecord());
    mutate(f.invoice);
    f.resolver.invalidateInvoice(f.invoice.id);
    assert.equal((await f.resolver.resolve(request, trusted)).decision, 'deny');
  }
});

test('TTL expiry and clock reversal force fresh reads; failures never reuse stale or negative cache', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.resolve()).amount.usd, 80);
  f.setClock(11_999);
  assert.equal((await f.resolve()).amount.usd, 80);
  assert.equal(f.seen.length, 2);
  f.setClock(12_000);
  f.setHandler((req, res) => {
    if (req.url.includes('/captures/')) {
      res.statusCode = 500;
      res.end('private-failure');
      return true;
    }
  });
  assert.equal((await f.resolve()).decision, 'deny');
  f.setHandler(undefined);
  assert.equal((await f.resolve()).amount.usd, 80);
  assert.equal(f.seen.length, 5);
  f.setClock(9000);
  assert.equal((await f.resolve()).amount.usd, 80);
  assert.equal(f.seen.length, 7);
});

test('same-key concurrent callers share remote facts but retain separate amounts and identities', async (t) => {
  const f = await fixture(t);
  const [full, partial, wrongCustomer] = await Promise.all([
    f.resolve(),
    f.resolve({ capture_id: captureId, amount: money('10.00') }),
    f.resolve(undefined, {
      ...trusted,
      customer: { ...trusted.customer, id: 'OTHER-PAYER' },
    }),
  ]);
  assert.equal(full.amount.usd, 80);
  assert.equal(partial.amount.usd, 10);
  assert.equal(wrongCustomer.decision, 'deny');
  assert.equal(f.seen.length, 2);
  assert.throws(() => {
    full.resolvedCtx.capture.remaining_minor = 1;
  }, TypeError);
  assert.equal((await f.resolve()).amount.usd, 80);
});

test('invalidation during an in-flight lookup denies its old result and permits a new lookup', async (t) => {
  const f = await fixture(t);
  let release;
  let entered;
  const gate = new Promise((resolve) => (release = resolve));
  const started = new Promise((resolve) => (entered = resolve));
  let first = true;
  f.setHandler(async (req) => {
    if (req.url.includes('/captures/') && first) {
      first = false;
      entered();
      await gate;
    }
    return false;
  });
  const old = f.resolve();
  await started;
  f.resolver.invalidateCapture(captureId);
  const current = await f.resolve();
  release();
  assert.equal((await old).decision, 'deny');
  assert.equal(current.amount.usd, 80);
  assert.equal((await f.resolve()).amount.usd, 80);
});

test('timeouts, malformed bodies, redirects and response bounds deny without echoing payloads', async (t) => {
  for (const handler of [
    (_req, res) => {
      res.end('not-json-private');
      return true;
    },
    (_req, res) => {
      res.writeHead(302, { location: 'https://private.invalid' });
      res.end();
      return true;
    },
    (_req, res) => {
      res.end('x'.repeat(140_000));
      return true;
    },
    async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      res.end('{}');
      return true;
    },
  ])
    await t.test('safe transport denial', async (t) => {
      const f = await fixture(t, { timeoutMs: 40 });
      f.setHandler(handler);
      const result = await f.resolve();
      assert.equal(result.decision, 'deny');
      assert.doesNotMatch(JSON.stringify(result), /private|Bearer|https:/);
    });
});

test('slow lookups expire from start time; invalid completion clocks also deny', async (t) => {
  for (const completedAt of [12_000, 9999, NaN])
    await t.test(`completion clock ${completedAt}`, async (t) => {
      const f = await fixture(t);
      f.setHandler((req) => {
        if (req.url.includes('/orders/')) f.setClock(completedAt);
        return false;
      });
      const result = await f.resolve();
      assert.equal(result.decision, 'deny');
      f.setClock(20_000);
      f.setHandler(undefined);
      assert.equal((await f.resolve()).amount.usd, 80);
      assert.equal(f.seen.length, 4);
    });
});

test('get_invoice exposes exact totals under the shared currency contract and blocks added recipients', async (t) => {
  const f = await fixture(t);
  const read = await f.resolver.resolve(
    { tool: 'get_invoice', args: { invoice_id: f.invoice.id } },
    trusted,
  );
  assert.equal(read.ok, true);
  assert.equal(read.amount.usd, 30);
  assert.equal(
    (
      await f.resolver.resolve(
        {
          tool: 'send_invoice',
          args: {
            invoice_id: f.invoice.id,
            additional_recipients: ['other@example.invalid'],
          },
        },
        trusted,
      )
    ).decision,
    'deny',
  );
  assert.equal(
    (
      await f.resolver.resolve(
        { tool: 'send_invoice', args: { invoice_id: 'MISSING-INVOICE' } },
        trusted,
      )
    ).decision,
    'deny',
  );
});

test('invalid tool/trusted JSON is rejected without invoking accessors or starting REST calls', async (t) => {
  const f = await fixture(t);
  let read = false;
  const args = {
    get capture_id() {
      read = true;
      return captureId;
    },
  };
  assert.equal((await f.resolve(args)).decision, 'deny');
  assert.equal(read, false);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const args of [
    cyclic,
    {
      capture_id: captureId,
      amount: { value: '1.00', currency_code: 'USD', usd: 0 },
    },
    JSON.parse('{"capture_id":"CAPTURE12345678901","__proto__":{"vip":true}}'),
  ])
    assert.equal((await f.resolve(args)).decision, 'deny');
  for (const context of [
    {},
    { ...trusted, merchant },
    { ...trusted, customer: { id: 'payer' } },
  ])
    assert.equal((await f.resolve(undefined, context)).decision, 'deny');
  assert.equal(f.seen.length, 0);
});

test('invoice creation and REST lookup share exact EUR/KRW normalization', async (t) => {
  for (const [currency, unit, shipping, total, usd] of [
    ['EUR', '12.50', '5.00', '30.00', 33],
    ['KRW', '1400', '100', '2900', 2.08],
  ])
    await t.test(currency, async (t) => {
      const f = await fixture(t);
      const args = invoiceArgs();
      args.currency_code = currency;
      args.items[0].unit_amount = money(unit, currency);
      args.shipping_cost = shipping;
      assert.equal(
        (await f.resolver.resolve({ tool: 'create_invoice', args }, trusted))
          .amount.usd,
        usd,
      );
      f.invoice.detail.currency_code = currency;
      f.invoice.items = args.items;
      f.invoice.amount = {
        ...money(total, currency),
        breakdown: {
          item_total: money(
            String(
              (BigInt(unit.replace('.', '')) * 2n) /
                (currency === 'KRW' ? 1n : 100n),
            ) + (currency === 'KRW' ? '' : '.00'),
            currency,
          ),
          shipping: { amount: money(shipping, currency) },
        },
      };
      assert.equal(
        (
          await f.resolver.resolve(
            { tool: 'get_invoice', args: { invoice_id: f.invoice.id } },
            trusted,
          )
        ).amount.usd,
        usd,
      );
    });
});

test('caller mutations after a lookup starts cannot alter the pending policy amount or identity', async (t) => {
  const f = await fixture(t);
  let entered;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const started = new Promise((resolve) => (entered = resolve));
  f.setHandler(async (req) => {
    if (req.url.includes('/captures/')) {
      entered();
      await gate;
    }
    return false;
  });
  const args = { capture_id: captureId, amount: money('10.00') };
  const identity = structuredClone(trusted);
  const pending = f.resolve(args, identity);
  await started;
  args.amount.value = '0.01';
  identity.customer.vip = true;
  release();
  const result = await pending;
  assert.equal(result.amount.usd, 10);
  assert.equal(result.context.customer.vip, false);
});
