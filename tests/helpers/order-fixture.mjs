import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ContextResolver } from '../../apps/firewall/src/context/index.ts';
import { OrderService } from '../../apps/firewall/src/orders/index.ts';
import { recordedOrders } from '../../apps/agent-demo/src/orders.ts';
import { loadPolicy } from '../../packages/policy/src/index.ts';

export const key = '5'.repeat(64);
export const merchant = { id: 'demo-merchant', email: 'merchant@example.test' };
export const tokens = {
  get: async () => 'synthetic-token',
  isSensitive: () => false,
};
export const policy = loadPolicy(
  await readFile(
    new URL('../../apps/agent-demo/shopping-policy.yaml', import.meta.url),
    'utf8',
  ),
);
export function trusted(agent = 'demo-shopper', customer = 'demo-buyer') {
  return {
    agent: { id: agent },
    customer: { id: customer, email: 'buyer@example.test' },
  };
}
export function orderArgs(itemCost = 19.99, overrides = {}) {
  return {
    currencyCode: 'USD',
    items: [
      {
        name: 'USB-C cable 1 m',
        quantity: 1,
        itemCost,
        itemTotal: itemCost,
      },
    ],
    ...overrides,
  };
}
export function createInput(args = orderArgs()) {
  return { requestId: randomUUID(), args };
}
export function captureInput(id) {
  return { executionId: randomUUID(), args: { id } };
}
// A provider wrapper lets tests observe or break individual synthetic requests.
export function fixture({ fetchImpl, now } = {}) {
  const provider = recordedOrders(merchant.id);
  const seen = [];
  const fetchWrapped = async (input, init) => {
    seen.push({ method: init?.method ?? 'GET', url: String(input) });
    return (fetchImpl ?? provider.fetchImpl)(input, init, provider.fetchImpl);
  };
  const resolver = new ContextResolver({
    merchant,
    tokens,
    fetchImpl: fetchWrapped,
    ...(now ? { now } : {}),
  });
  return {
    provider,
    resolver,
    seen,
    posts: () => seen.filter((entry) => entry.method === 'POST'),
    service: (pool, overrides = {}) =>
      new OrderService(pool, {
        identityKey: key,
        resolver,
        tokens,
        fetchImpl: fetchWrapped,
        ...(now ? { now } : {}),
        ...overrides,
      }),
  };
}
