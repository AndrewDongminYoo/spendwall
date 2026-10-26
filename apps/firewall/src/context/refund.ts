import { fail, identifier, object } from './json.ts';
import { fromMinor, parseMoney } from './money.ts';
import type { Money } from './money.ts';

export type RefundFacts = {
  captureId: string;
  payerId: string;
  status: string;
  original: Money;
  refunded: Money;
  remaining: Money;
};
export async function readRefund(
  get: (path: string) => Promise<unknown>,
  captureId: string,
  merchantId: string,
): Promise<RefundFacts> {
  const capture = object(await get(`/v2/payments/captures/${captureId}`));
  if (
    capture.id !== captureId ||
    typeof capture.status !== 'string' ||
    !['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(capture.status) ||
    object(capture.payee).merchant_id !== merchantId
  )
    fail();
  const original = parseMoney(capture.amount);
  const orderId = identifier(
    object(object(capture.supplementary_data).related_ids).order_id,
    15,
    32,
  );
  const order = object(await get(`/v2/checkout/orders/${orderId}`));
  if (
    order.id !== orderId ||
    order.status !== 'COMPLETED' ||
    !Array.isArray(order.purchase_units) ||
    order.purchase_units.length !== 1
  )
    fail();
  const payerId = identifier(object(order.payer).payer_id);
  const unit = object(order.purchase_units[0]);
  if (object(unit.payee).merchant_id !== merchantId) fail();
  const payments = object(unit.payments);
  // Orders v2 may omit an empty refunds array. A present non-array is denied,
  // and the capture status check below still requires refunds when it reports
  // any.
  const refunds = Object.hasOwn(payments, 'refunds') ? payments.refunds : [];
  if (
    !Array.isArray(payments.captures) ||
    payments.captures.length !== 1 ||
    !Array.isArray(refunds) ||
    refunds.length > 100
  )
    fail();
  const linked = object(payments.captures[0]);
  const linkedAmount = parseMoney(linked.amount);
  if (
    linked.id !== captureId ||
    linked.status !== capture.status ||
    linkedAmount.currency !== original.currency ||
    linkedAmount.minor !== original.minor
  )
    fail();
  let refunded = 0n;
  const ids = new Set<string>();
  for (const candidate of refunds) {
    const refund = object(candidate);
    const id = identifier(refund.id, 15, 32);
    if (
      ids.has(id) ||
      typeof refund.status !== 'string' ||
      !['COMPLETED', 'FAILED', 'CANCELLED'].includes(refund.status)
    )
      fail();
    ids.add(id);
    const amount = parseMoney(refund.amount);
    if (amount.currency !== original.currency || !Array.isArray(refund.links))
      fail();
    const parents = refund.links
      .map(object)
      .filter((link) => link.rel === 'up');
    if (
      parents.length !== 1 ||
      parents[0]!.href !==
        `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}`
    )
      fail();
    if (refund.status === 'COMPLETED') refunded += amount.minor;
  }
  if (
    refunded > original.minor ||
    (capture.status === 'COMPLETED' && refunded !== 0n) ||
    (capture.status === 'PARTIALLY_REFUNDED' &&
      (refunded <= 0n || refunded >= original.minor)) ||
    (capture.status === 'REFUNDED' && refunded !== original.minor)
  )
    fail();
  return {
    captureId,
    payerId,
    status: capture.status,
    original,
    refunded: fromMinor(refunded, original.currency),
    remaining: fromMinor(original.minor - refunded, original.currency),
  };
}

export function refundAmount(
  args: Record<string, unknown>,
  facts: RefundFacts,
  customerId: string,
): Money {
  if (facts.payerId !== customerId || facts.remaining.minor <= 0n) fail();
  const amount = Object.hasOwn(args, 'amount')
    ? parseMoney(args.amount)
    : facts.remaining;
  if (
    amount.currency !== facts.original.currency ||
    amount.minor > facts.remaining.minor
  )
    fail();
  return amount;
}
