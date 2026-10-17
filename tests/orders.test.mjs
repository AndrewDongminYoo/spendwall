import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextResolver } from '../apps/firewall/src/context/index.ts';
import { OrderService } from '../apps/firewall/src/orders/index.ts';
import { evaluatePolicy } from '../packages/policy/src/index.ts';
import {
  captureInput,
  createInput,
  fixture,
  key,
  orderArgs,
  policy,
  tokens,
  trusted,
} from './helpers/order-fixture.mjs';

const serverContext = () => ({ ...trusted(), agg: {} });
const resolve = (f, args) =>
  f.resolver.resolve({ tool: 'create_order', args }, serverContext());

test('create_order totals are recomputed from catalog lines and never trusted', async () => {
  const f = fixture({
    fetchImpl: async () => {
      throw new Error('Draft resolution must not contact the provider.');
    },
  });
  const valid = await resolve(f, {
    currencyCode: 'USD',
    items: [
      { name: 'Cable', quantity: 2, itemCost: 19.99, itemTotal: 39.98 },
      {
        name: 'Charger',
        description: 'Dual port',
        itemCost: 50,
        taxPercent: 8.5,
        itemTotal: 50,
      },
    ],
    discount: 10,
    shippingCost: 4.5,
  });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  // 39.98 + 50.00 + 4.25 tax + 4.50 shipping - 10.00 discount
  assert.deepEqual(valid.context.amount, { value: '88.73', currency: 'USD' });
  assert.equal(valid.amount.usd, 88.73);
  assert.deepEqual(valid.resolvedCtx, {
    order: {
      amount: { value: '88.73', currency: 'USD' },
      amount_minor: 8873,
      quantity: 2,
    },
  });
  assert.equal(evaluatePolicy(policy, valid.context).decision, 'deny');
  assert.equal(
    evaluatePolicy(policy, (await resolve(f, orderArgs())).context).decision,
    'allow',
  );
  for (const [label, args] of [
    [
      'forged line total',
      orderArgs(19.99, {
        items: [{ name: 'Cable', itemCost: 19.99, itemTotal: 1 }],
      }),
    ],
    [
      'forged quantity',
      orderArgs(19.99, {
        items: [
          { name: 'Cable', quantity: 3, itemCost: 19.99, itemTotal: 19.99 },
        ],
      }),
    ],
    ['binary float noise', orderArgs(0.1 + 0.2)],
    ['three decimals', orderArgs(19.999)],
    ['zero cost', orderArgs(0)],
    ['negative cost', orderArgs(-5)],
    [
      'fractional quantity',
      orderArgs(19.99, {
        items: [
          { name: 'Cable', quantity: 1.5, itemCost: 19.99, itemTotal: 29.985 },
        ],
      }),
    ],
    [
      'zero quantity',
      orderArgs(19.99, {
        items: [{ name: 'Cable', quantity: 0, itemCost: 19.99, itemTotal: 0 }],
      }),
    ],
    [
      'inexact tax',
      orderArgs(19.99, {
        items: [
          { name: 'Cable', itemCost: 19.99, taxPercent: 7, itemTotal: 19.99 },
        ],
      }),
    ],
    ['discount above items', orderArgs(19.99, { discount: 20 })],
    ['negative shipping', orderArgs(19.99, { shippingCost: -1 })],
    [
      'blank name',
      orderArgs(19.99, {
        items: [{ name: ' ', itemCost: 19.99, itemTotal: 19.99 }],
      }),
    ],
    [
      'caller return URL',
      orderArgs(19.99, { returnUrl: 'https://attacker.invalid/return' }),
    ],
    ['caller notes', orderArgs(19.99, { notes: 'ship now' })],
    ['no items', orderArgs(19.99, { items: [] })],
    ['unsupported currency', orderArgs(19.99, { currencyCode: 'EUR' })],
    [
      'string cost',
      orderArgs(19.99, {
        items: [{ name: 'Cable', itemCost: '19.99', itemTotal: '19.99' }],
      }),
    ],
  ]) {
    const result = await resolve(f, args);
    assert.equal(result.ok, false, label);
    assert.equal(result.decision, 'deny', label);
  }
  assert.equal(f.seen.length, 0);
});

test('pay_order facts come from the provider order and unknown tools deny', async () => {
  const f = fixture();
  const created = await f.provider.fetchImpl(
    'https://api-m.sandbox.paypal.com/v2/checkout/orders',
    {
      method: 'POST',
      headers: { 'PayPal-Request-Id': 'fixture-request' },
      body: JSON.stringify({
        purchase_units: [
          {
            custom_id: 'fixture-request',
            amount: { value: '19.99', currency_code: 'USD' },
          },
        ],
      }),
    },
  );
  const { id } = await created.json();
  const pay = (args) =>
    f.resolver.resolve({ tool: 'pay_order', args }, serverContext());
  const pending = await pay({ id });
  assert.equal(pending.ok, true);
  assert.deepEqual(pending.context.amount, { value: '19.99', currency: 'USD' });
  assert.equal(pending.resolvedCtx.order.status, 'CREATED');
  assert.equal(pending.resolvedCtx.order.custom_id, 'fixture-request');
  f.provider.approve(id);
  f.resolver.invalidateOrder(id);
  assert.equal((await pay({ id })).resolvedCtx.order.status, 'APPROVED');
  for (const args of [
    { id: 'MISSING0000000000' },
    { id: 'lowercase000000000' },
    {},
  ]) {
    assert.equal((await pay(args)).decision, 'deny');
  }
  const foreign = await new ContextResolver({
    merchant: { id: 'other-merchant', email: 'other@example.test' },
    tokens,
    fetchImpl: f.provider.fetchImpl,
  }).resolve({ tool: 'pay_order', args: { id } }, serverContext());
  assert.equal(
    foreign.decision,
    'deny',
    'another merchant cannot read the order',
  );
  assert.equal(
    (
      await f.resolver.resolve(
        { tool: 'buy_now', args: { id } },
        serverContext(),
      )
    ).reason,
    'unsupported_tool',
  );
  assert.equal(
    (
      await f.resolver.resolve(
        { tool: 'get_order', args: { id } },
        serverContext(),
      )
    ).reason,
    'unsupported_tool',
  );
});

test('malformed envelopes and unavailable storage deny before any provider write', async () => {
  let connections = 0;
  const f = fixture();
  const service = f.service({
    connect: async () => {
      connections++;
      throw new Error('Offline');
    },
  });
  for (const input of [
    null,
    {},
    { ...createInput(), requestId: 'invalid' },
    { ...createInput(), extra: true },
    { requestId: createInput().requestId, args: null },
  ]) {
    const result = await service.create(policy, input, trusted());
    assert.equal(result.decision, 'deny');
    assert.equal(result.reason, 'invalid_arguments');
    assert.equal(result.result, undefined);
    assert.equal(
      (await service.capture(policy, input, trusted())).reason,
      'invalid_arguments',
    );
  }
  assert.equal(connections, 0, 'malformed envelopes must fail before storage');
  for (const context of [null, {}, { ...trusted(), agg: {} }]) {
    assert.equal(
      (await service.create(policy, createInput(), context)).reason,
      'invalid_arguments',
    );
  }
  assert.equal(connections, 0);
  const offline = await service.create(policy, createInput(), trusted());
  assert.equal(offline.decision, 'deny');
  assert.equal(offline.reason, 'orders_unavailable');
  assert.equal(connections, 1);
  const capture = await service.capture(
    policy,
    captureInput('DEMOORDER000000001'),
    trusted(),
  );
  assert.equal(capture.reason, 'orders_unavailable');
  assert.equal(f.posts().length, 0, 'no provider write without storage');
  let invoked = false;
  const getter = { ...createInput() };
  Object.defineProperty(getter, 'args', {
    get() {
      invoked = true;
      return {};
    },
    enumerable: true,
  });
  assert.equal(
    (await service.create(policy, getter, trusted())).decision,
    'deny',
  );
  assert.equal(invoked, false);
  for (const options of [
    { identityKey: 'short', resolver: f.resolver, tokens },
    {
      identityKey: key,
      resolver: f.resolver,
      tokens,
      returnUrl: 'http://example.com/return',
    },
    {
      identityKey: key,
      resolver: f.resolver,
      tokens,
      cancelUrl: 'javascript:alert(1)',
    },
  ])
    assert.throws(() => new OrderService({}, options), /configuration/);
});
