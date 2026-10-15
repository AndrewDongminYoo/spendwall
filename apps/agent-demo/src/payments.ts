import { readFileSync } from 'node:fs';

type Money = { value: string; currency_code: string };
const fixture: {
  merchantId: string;
  customerId: string;
  captures: Record<string, Money>;
} = JSON.parse(
  readFileSync(new URL('../recordings/payments.json', import.meta.url), 'utf8'),
);

export function recordedPayments() {
  const writes: { capture: string; executionId: string; amount: Money }[] = [];
  const refunds = new Map<string, Record<string, unknown>>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api-m.sandbox.paypal.com')
      throw new Error('Unrecorded payment origin.');
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === '/v1/oauth2/token' && init?.method === 'POST')
      return json({
        access_token: 'synthetic-demo-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    const parts = url.pathname.split('/');
    const capture = parts[4];
    if (parts[3] === 'captures' && capture && fixture.captures[capture]) {
      const amount = fixture.captures[capture];
      if (parts[5] === 'refund' && init?.method === 'POST') {
        const executionId = new Headers(init.headers).get('PayPal-Request-Id');
        const body = JSON.parse(String(init.body));
        if (
          !executionId ||
          body.amount?.value !== amount.value ||
          body.amount?.currency_code !== amount.currency_code
        )
          throw new Error('Unrecorded refund arguments.');
        const existing = writes.find((row) => row.executionId === executionId);
        if (existing) return json(refunds.get(existing.capture));
        if (refunds.has(capture))
          throw new Error('Capture was already refunded.');
        const result = {
          id: capture.replace('CAPTURE', 'REFUNDS'),
          status: 'COMPLETED',
          amount,
          links: [
            {
              rel: 'up',
              href: `${url.origin}/v2/payments/captures/${capture}`,
            },
          ],
        };
        writes.push({ capture, executionId, amount });
        refunds.set(capture, result);
        return json(result);
      }
      if (parts.length === 5 && (!init?.method || init.method === 'GET'))
        return json({
          id: capture,
          status: refunds.has(capture) ? 'REFUNDED' : 'COMPLETED',
          amount,
          payee: { merchant_id: fixture.merchantId },
          supplementary_data: {
            related_ids: { order_id: capture.replace('CAPTURE', 'ORDERID') },
          },
        });
    }
    if (
      parts[3] === 'orders' &&
      capture &&
      (!init?.method || init.method === 'GET')
    ) {
      const id = capture.replace('ORDERID', 'CAPTURE');
      const amount = fixture.captures[id];
      if (amount)
        return json({
          id: capture,
          status: 'COMPLETED',
          payer: { payer_id: fixture.customerId },
          purchase_units: [
            {
              payee: { merchant_id: fixture.merchantId },
              payments: {
                captures: [
                  {
                    id,
                    status: refunds.has(id) ? 'REFUNDED' : 'COMPLETED',
                    amount,
                  },
                ],
                refunds: refunds.has(id) ? [refunds.get(id)] : [],
              },
            },
          ],
        });
    }
    if (
      parts[3] === 'refunds' &&
      capture &&
      (!init?.method || init.method === 'GET')
    ) {
      const value = refunds.get(capture.replace('REFUNDS', 'CAPTURE'));
      if (value) return json(value);
    }
    throw new Error('Unrecorded payment request.');
  };
  return { fetchImpl, writes, merchantId: fixture.merchantId };
}
