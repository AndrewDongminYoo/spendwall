import { randomUUID } from 'node:crypto';
import { ContextResolver } from '../../apps/firewall/src/context/index.ts';
export const key = '9'.repeat(64);
export function trusted(
  email = 'buyer@example.invalid',
  customer = 'customerA',
  agent = 'support',
) {
  return { agent: { id: agent }, customer: { id: customer, email }, agg: {} };
}
export function draft(value = '25.00', email = 'buyer@example.invalid') {
  return {
    requestId: randomUUID(),
    tool: 'create_invoice',
    args: {
      currency_code: 'USD',
      primary_recipients: [{ billing_info: { email_address: email } }],
      items: [
        {
          name: 'Synthetic invoice',
          quantity: '1',
          unit_amount: { value, currency_code: 'USD' },
        },
      ],
    },
  };
}
export function send(id = `INV2-${randomUUID()}`) {
  return {
    requestId: randomUUID(),
    tool: 'send_invoice',
    args: { invoice_id: id },
  };
}
export function resolver({
  value = '25.00',
  email = 'buyer@example.invalid',
  merchant = 'merchantA',
} = {}) {
  return new ContextResolver({
    merchant: { id: merchant, email: 'merchant@example.invalid' },
    tokens: { get: async () => 'synthetic-token', isSensitive: () => false },
    fetchImpl: async (url, options) => {
      if (
        options.method !== 'GET' ||
        !String(url).startsWith(
          'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/',
        )
      )
        throw new Error('Unexpected provider operation');
      const args = draft(value, email).args;
      return Response.json({
        id: String(url).split('/').at(-1),
        status: 'DRAFT',
        detail: { currency_code: 'USD' },
        invoicer: { email_address: 'merchant@example.invalid' },
        primary_recipients: args.primary_recipients,
        items: args.items,
        amount: {
          value,
          currency_code: 'USD',
          breakdown: { item_total: { value, currency_code: 'USD' } },
        },
      });
    },
  });
}
