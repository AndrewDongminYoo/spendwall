type Money = { value: string; currency_code: string };
type SyntheticOrder = {
  id: string;
  status: 'CREATED' | 'APPROVED' | 'COMPLETED';
  amount: Money;
  customId: string;
  capture?: { id: string; status: 'COMPLETED'; amount: Money };
};
export type CaptureWrite = {
  order: string;
  executionId: string;
  amount: Money;
};

// Synthetic Orders v2 responses for demos and tests. There is no network fallback.
// Buyer approval is a runner capability, never an agent tool.
export function recordedOrders(merchantId = 'demo-merchant') {
  const orders = new Map<string, SyntheticOrder>();
  const creations = new Map<string, string>();
  const writes: CaptureWrite[] = [];
  let sequence = 0;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const representation = (order: SyntheticOrder) => ({
    id: order.id,
    intent: 'CAPTURE',
    status: order.status,
    purchase_units: [
      {
        custom_id: order.customId,
        payee: { merchant_id: merchantId },
        amount: order.amount,
        ...(order.capture ? { payments: { captures: [order.capture] } } : {}),
      },
    ],
    links: [
      {
        rel: 'approve',
        href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`,
      },
    ],
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api-m.sandbox.paypal.com')
      throw new Error('Unrecorded payment origin.');
    if (url.pathname === '/v1/oauth2/token' && init?.method === 'POST')
      return json({
        access_token: 'synthetic-demo-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    const parts = url.pathname.split('/');
    if (parts[1] !== 'v2' || parts[2] !== 'checkout' || parts[3] !== 'orders')
      throw new Error('Unrecorded payment request.');
    const requestId = new Headers(init?.headers).get('PayPal-Request-Id');
    if (parts.length === 4 && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const unit = body?.purchase_units?.[0];
      if (!requestId || !unit?.custom_id || unit.custom_id !== requestId)
        throw new Error('Unrecorded order arguments.');
      const existing = creations.get(requestId);
      if (existing) return json(representation(orders.get(existing)!), 201);
      const amount = {
        value: String(unit.amount.value),
        currency_code: String(unit.amount.currency_code),
      };
      const order: SyntheticOrder = {
        id: `DEMOORDER${String(++sequence).padStart(9, '0')}`,
        status: 'CREATED',
        amount,
        customId: requestId,
      };
      orders.set(order.id, order);
      creations.set(requestId, order.id);
      return json(representation(order), 201);
    }
    const order = parts[4] ? orders.get(parts[4]) : undefined;
    if (!order) return json({ name: 'RESOURCE_NOT_FOUND' }, 404);
    if (parts.length === 5 && (!init?.method || init.method === 'GET'))
      return json(representation(order));
    if (
      parts.length === 6 &&
      parts[5] === 'capture' &&
      init?.method === 'POST'
    ) {
      if (!requestId) throw new Error('Unrecorded capture arguments.');
      const replay = writes.find(
        (row) => row.executionId === requestId && row.order === order.id,
      );
      if (replay) return json(representation(order), 201);
      if (order.status !== 'APPROVED')
        return json(
          {
            name: 'UNPROCESSABLE_ENTITY',
            details: [{ issue: 'ORDER_NOT_APPROVED' }],
          },
          422,
        );
      order.status = 'COMPLETED';
      order.capture = {
        id: order.id.replace('DEMOORDER', 'DEMOCAPTR'),
        status: 'COMPLETED',
        amount: order.amount,
      };
      writes.push({
        order: order.id,
        executionId: requestId,
        amount: order.amount,
      });
      return json(representation(order), 201);
    }
    throw new Error('Unrecorded payment request.');
  };
  return {
    fetchImpl,
    writes,
    merchantId,
    // Scripted buyer approval on the synthetic PayPal page.
    approve(id: string) {
      const order = orders.get(id);
      if (!order || order.status !== 'CREATED')
        throw new Error('Unknown or already approved synthetic order.');
      order.status = 'APPROVED';
    },
    status(id: string) {
      return orders.get(id)?.status;
    },
  };
}
