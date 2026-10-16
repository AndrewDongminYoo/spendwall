import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { InvoicePolicy } from '../apps/firewall/src/invoices/index.ts';
import { loadPolicy } from '../packages/policy/src/index.ts';
import { key, trusted, draft, resolver } from './helpers/invoice-fixture.mjs';
const policy = loadPolicy(
  await readFile(
    new URL('../apps/agent-demo/invoice-policy.yaml', import.meta.url),
    'utf8',
  ),
);
test('invalid input and unavailable storage cannot authorize invoice operations', async () => {
  let connections = 0;
  const service = new InvoicePolicy(
    {
      connect: async () => {
        connections++;
        throw new Error('Offline');
      },
    },
    { identityKey: key, resolver: resolver() },
  );
  for (const input of [
    null,
    {},
    { ...draft(), requestId: 'invalid' },
    { ...draft(), tool: 'create_refund' },
    { ...draft(), amount: { usd: 0 } },
    { ...draft(), args: null },
  ]) {
    const result = await service.evaluateAndReserve(policy, input, trusted());
    assert.equal(result.decision, 'deny');
    assert.equal(result.dispatchAllowed, false);
    assert.equal(result.receipt, undefined);
  }
  assert.equal(connections, 0, 'malformed envelopes must fail before storage');
  const valid = await service.evaluateAndReserve(policy, draft(), trusted());
  assert.equal(valid.reason, 'invoice_unavailable');
  assert.equal(valid.dispatchAllowed, false);
  assert.equal(connections, 1);
  let invoked = false;
  const getter = { ...draft() };
  Object.defineProperty(getter, 'args', {
    get() {
      invoked = true;
      return {};
    },
    enumerable: true,
  });
  assert.equal(
    (await service.evaluateAndReserve(policy, getter, trusted()))
      .dispatchAllowed,
    false,
  );
  assert.equal(invoked, false);
  assert.throws(
    () => new InvoicePolicy({}, { identityKey: 'short', resolver: resolver() }),
    /configuration/,
  );
});
