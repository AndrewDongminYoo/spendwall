import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PayPalWebhookVerifier } from '../apps/firewall/src/webhooks/paypal.ts';

const api = 'https://api-m.sandbox.paypal.com';
export const webhookHeaders = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': `${api}/v1/notifications/certs/CERT-synthetic`,
  'paypal-transmission-id': 'delivery-synthetic',
  'paypal-transmission-sig': 'c3ludGhldGlj',
  'paypal-transmission-time': '2026-10-16T08:00:00Z',
};
export const refundEvent = () => ({
  id: 'WH-SYNTHETIC-EVENT-1',
  event_type: 'PAYMENT.CAPTURE.REFUNDED',
  resource_type: 'refund',
  resource_version: '2.0',
  create_time: '2026-10-16T08:00:00Z',
  resource: {
    id: 'REFUND123456789012',
    status: 'COMPLETED',
    amount: { value: '5.00', currency_code: 'USD' },
    note_to_payer: 'private note must not be stored',
    links: [
      {
        rel: 'self',
        method: 'GET',
        href: `${api}/v2/payments/refunds/REFUND123456789012`,
      },
      {
        rel: 'up',
        method: 'GET',
        href: `${api}/v2/payments/captures/CAPTURE12345678901`,
      },
    ],
  },
});
function fixture(overrides = {}) {
  const calls = [];
  const verifier = new PayPalWebhookVerifier({
    env: {
      PAYPAL_CLIENT_ID: 'synthetic-client',
      PAYPAL_CLIENT_SECRET: 'synthetic-secret',
    },
    merchantId: 'merchantA',
    webhookId: 'WEBHOOK12345678901',
    ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      if (url.endsWith('/oauth2/token'))
        return Response.json({
          access_token: 'synthetic-token',
          token_type: 'Bearer',
          expires_in: 300,
        });
      if (url.endsWith('/verify-webhook-signature'))
        return (
          overrides.verification?.(init) ??
          Response.json({ verification_status: 'SUCCESS' })
        );
      assert.equal(url, `${api}/v2/payments/captures/CAPTURE12345678901`);
      assert.equal(init.method, 'GET');
      return (
        overrides.capture?.(init) ??
        Response.json({
          id: 'CAPTURE12345678901',
          status: 'REFUNDED',
          amount: { value: '5.00', currency_code: 'USD' },
          payee: { merchant_id: 'merchantA' },
        })
      );
    },
  });
  return { verifier, calls };
}
test('verifies the configured webhook and binds the refund to the capture merchant', async () => {
  const { verifier, calls } = fixture();
  const event = refundEvent();
  const result = await verifier.verify(webhookHeaders, JSON.stringify(event));
  assert.equal(result.refundId, event.resource.id);
  assert.equal(result.captureId, 'CAPTURE12345678901');
  assert.equal(result.usdCents, 500);
  assert.match(verifier.adapterRef, /^[a-f0-9]{64}$/);
  const sent = JSON.parse(calls[1].init.body);
  assert.equal(sent.webhook_id, 'WEBHOOK12345678901');
  assert.deepEqual(sent.webhook_event, event);
  assert.equal(sent.transmission_id, webhookHeaders['paypal-transmission-id']);
  assert.equal(calls.length, 3);
});
test('postback keeps the exact validated raw event representation', async () => {
  const event = { ...refundEvent(), debug_count: 1000, unicode: 'a' };
  const raw =
    '\r\n' +
    JSON.stringify(event, null, 2)
      .replace('"debug_count": 1000', '"debug_count": 1e3')
      .replace('"unicode": "a"', '"unicode": "\\u0061"') +
    '\r\n';
  const { verifier, calls } = fixture({
    verification: (init) => {
      assert.ok(init.body.endsWith('"webhook_event":' + raw + '}'));
      assert.deepEqual(JSON.parse(init.body).webhook_event, event);
      return Response.json({ verification_status: 'SUCCESS' });
    },
  });
  assert.equal((await verifier.verify(webhookHeaders, raw)).usdCents, 500);
  assert.equal(calls.length, 3);
  for (const invalid of [
    '{} , "webhook_id": "other"',
    '[]',
    '{bad',
    '\ufeff{}',
  ]) {
    const next = fixture();
    await assert.rejects(next.verifier.verify(webhookHeaders, invalid));
    assert.equal(next.calls.length, 0);
  }
});
test('signature failure and provider errors never proceed to capture lookup', async () => {
  for (const response of [
    () => Response.json({ verification_status: 'FAILURE' }),
    () => Response.json({ verification_status: 'SUCCESS' }, { status: 500 }),
    () => Response.json({}),
    () => {
      throw new Error('synthetic network failure');
    },
    () => {
      throw new DOMException('Timeout', 'TimeoutError');
    },
  ]) {
    const { verifier, calls } = fixture({ verification: response });
    await assert.rejects(
      verifier.verify(webhookHeaders, JSON.stringify(refundEvent())),
    );
    assert.equal(calls.length, 2);
  }
});
test('rejects missing, duplicate and foreign certificate headers before network calls', async () => {
  for (const replacement of [
    undefined,
    ['a', 'b'],
    'https://evil.invalid/cert',
  ]) {
    const { verifier, calls } = fixture();
    await assert.rejects(
      verifier.verify(
        { ...webhookHeaders, 'paypal-cert-url': replacement },
        JSON.stringify(refundEvent()),
      ),
    );
    assert.equal(calls.length, 0);
  }
});
test('wrong merchant, capture identity or currency cannot become verified evidence', async () => {
  for (const changed of [
    { payee: { merchant_id: 'merchantB' } },
    { id: 'OTHER123456789012' },
    { amount: { value: '5.00', currency_code: 'EUR' } },
  ]) {
    const { verifier } = fixture({
      capture: () =>
        Response.json({
          id: 'CAPTURE12345678901',
          status: 'REFUNDED',
          amount: { value: '5.00', currency_code: 'USD' },
          payee: { merchant_id: 'merchantA' },
          ...changed,
        }),
    });
    await assert.rejects(
      verifier.verify(webhookHeaders, JSON.stringify(refundEvent())),
    );
  }
});
test('refund envelope rejects noncompleted, ambiguous and foreign capture links', async () => {
  for (const change of [
    (e) => {
      e.resource.status = 'PENDING';
    },
    (e) => {
      e.resource.links[1].href =
        'https://evil.invalid/v2/payments/captures/CAPTURE12345678901';
    },
    (e) => {
      e.resource.links.push({ ...e.resource.links[1] });
    },
    (e) => {
      e.resource.amount.value = '0.001';
    },
    (e) => {
      e.resource_type = 'capture';
    },
  ]) {
    const { verifier } = fixture();
    const event = refundEvent();
    change(event);
    await assert.rejects(
      verifier.verify(webhookHeaders, JSON.stringify(event)),
    );
  }
});
test('other event types are ignored only after successful verification', async () => {
  const { verifier, calls } = fixture();
  const event = { ...refundEvent(), event_type: 'CUSTOMER.DISPUTE.CREATED' };
  assert.equal(
    await verifier.verify(webhookHeaders, JSON.stringify(event)),
    null,
  );
  assert.equal(calls.length, 2);
  const failed = fixture({
    verification: () => Response.json({ verification_status: 'FAILURE' }),
  });
  await assert.rejects(
    failed.verifier.verify(webhookHeaders, JSON.stringify(event)),
  );
});
test('a stalled verifier request is aborted before capture lookup', async () => {
  const { verifier, calls } = fixture({
    timeoutMs: 10,
    verification: (init) =>
      new Promise((resolve, reject) => {
        const keepAlive = setTimeout(
          () => resolve(Response.json({ verification_status: 'SUCCESS' })),
          2000,
        );
        init.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive);
            reject(init.signal.reason);
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(
    verifier.verify(webhookHeaders, JSON.stringify(refundEvent())),
  );
  assert.equal(calls.length, 2);
});
test('a verification authorization expiry refreshes once without changing the event', async () => {
  let attempt = 0;
  const { verifier, calls } = fixture({
    verification: () =>
      ++attempt === 1
        ? new Response(null, { status: 401 })
        : Response.json({ verification_status: 'SUCCESS' }),
  });
  assert.equal(
    (await verifier.verify(webhookHeaders, JSON.stringify(refundEvent())))
      .usdCents,
    500,
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith('/oauth2/token')).length,
    2,
  );
  const requests = calls.filter((call) =>
    call.url.endsWith('/verify-webhook-signature'),
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.body, requests[1].init.body);
});
