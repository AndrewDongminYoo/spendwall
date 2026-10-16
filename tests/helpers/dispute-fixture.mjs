import assert from 'node:assert/strict';
import { ContextResolver } from '../../apps/firewall/src/context/index.ts';

export const disputeId = 'PP-D-SYNTHETIC';
export const sellerTransactionId = 'SALE12345678901234';
export const merchant = {
  id: 'MERCHANT12345',
  email: 'merchant@example.invalid',
};
export const trusted = {
  agent: { id: 'support', region: 'local' },
  customer: {
    id: 'customer-1',
    email: 'buyer@example.invalid',
    seller_transaction_id: sellerTransactionId,
  },
  agg: {},
};
export const accept = () => ({
  tool: 'accept_dispute_claim',
  args: { dispute_id: disputeId, note: 'Accept_reviewed_claim' },
});
export function disputeRecord() {
  return {
    dispute_id: disputeId,
    status: 'WAITING_FOR_SELLER_RESPONSE',
    dispute_life_cycle_stage: 'CHARGEBACK',
    dispute_amount: { value: '25.00', currency_code: 'USD' },
    seller_response_due_date: '2026-10-17T12:00:00Z',
    disputed_transactions: [
      {
        seller_transaction_id: sellerTransactionId,
        transaction_status: 'COMPLETED',
        gross_amount: { value: '100.00', currency_code: 'USD' },
        seller: { merchant_id: merchant.id, email: merchant.email },
        buyer: { name: 'Untrusted_name' },
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
}
export function fixture(options = {}) {
  const record = disputeRecord();
  const seen = [];
  let clock = Date.parse('2026-10-16T12:00:00Z');
  const now = () => clock;
  const resolver = new ContextResolver({
    merchant,
    tokens: {
      get: async () => 'synthetic-dispute-token',
      isSensitive: (v) => JSON.stringify(v).includes('synthetic-dispute-token'),
    },
    now,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), method: init.method });
      assert.equal(
        url,
        `https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}`,
      );
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.equal(init.redirect, 'error');
      assert.equal(
        init.headers.Authorization,
        'Bearer synthetic-dispute-token',
      );
      if (options.fetch) return options.fetch(record, init);
      return Response.json(record);
    },
  });
  return {
    record,
    resolver,
    seen,
    now,
    setClock: (v) => {
      clock = v;
    },
  };
}
