import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ContextResolver } from '../apps/firewall/src/context/index.ts';
import { DisputePolicy } from '../apps/firewall/src/disputes/index.ts';
import { loadPolicy } from '../packages/policy/src/index.ts';

// Synthetic-only composition. No environment credentials or network transport.
const disputeId = 'PP-D-SYNTHETIC';
const transactionId = 'SALE12345678901234';
const merchant = { id: 'MERCHANT12345', email: 'merchant@example.invalid' };
const now = () => Date.parse('2026-10-16T12:00:00Z');
const record = {
  dispute_id: disputeId,
  status: 'WAITING_FOR_SELLER_RESPONSE',
  dispute_life_cycle_stage: 'CHARGEBACK',
  dispute_amount: { value: '25.00', currency_code: 'USD' },
  seller_response_due_date: '2026-10-17T12:00:00Z',
  disputed_transactions: [
    {
      seller_transaction_id: transactionId,
      transaction_status: 'COMPLETED',
      gross_amount: { value: '100.00', currency_code: 'USD' },
      seller: { merchant_id: merchant.id, email: merchant.email },
    },
  ],
  allowed_response_options: {
    accept_claim: { accept_claim_types: ['REFUND'] },
  },
  links: [
    {
      rel: 'accept-claim',
      method: 'POST',
      href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}/accept-claim`,
    },
  ],
};
let reads = 0;
const resolver = new ContextResolver({
  merchant,
  now,
  tokens: { get: async () => 'synthetic-token', isSensitive: () => false },
  fetchImpl: async (url, init) => {
    assert.equal(
      url,
      `https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}`,
    );
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    reads++;
    return Response.json(record);
  },
});
const service = new DisputePolicy({ resolver, now });
const policy = loadPolicy(
  await readFile(
    new URL('../apps/agent-demo/dispute-policy.yaml', import.meta.url),
    'utf8',
  ),
);
const request = {
  tool: 'accept_dispute_claim',
  args: { dispute_id: disputeId, note: 'Reviewed_claim' },
};
const trusted = {
  agent: { id: 'support' },
  customer: {
    id: 'customer-1',
    email: 'buyer@example.invalid',
    seller_transaction_id: transactionId,
  },
  agg: {},
};
async function run(name, decision, urgency) {
  resolver.invalidateDispute(disputeId);
  const result = await service.evaluate(policy, request, trusted);
  assert.equal(result.decision, decision);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.review?.deadline.status, urgency);
  assert.equal(result.approvalId, undefined);
  console.log(
    JSON.stringify({
      scenario: name,
      decision,
      deadline: urgency ?? null,
      dispatchAllowed: false,
    }),
  );
}
await run('valid_claim', 'require_approval', 'due_soon');
record.disputed_transactions[0].seller.merchant_id = 'FOREIGN';
await run('foreign_merchant', 'deny');
record.disputed_transactions[0].seller.merchant_id = merchant.id;
record.dispute_amount.value = '100.01';
await run('inconsistent_amount', 'deny');
record.dispute_amount.value = '25.00';
record.seller_response_due_date = '2026-10-16T12:00:00Z';
await run('overdue_claim', 'require_approval', 'overdue');
assert.equal(reads, 4);
console.log(
  'Synthetic GET reads: 4. Approvals created: 0. Provider writes: 0.',
);
