import { fail, identifier, object } from './json.ts';
import type { JsonObject } from './json.ts';
import { fromMinor, parseMoney } from './money.ts';
import type { Currency, Money } from './money.ts';

export type OrderLine = {
  name: string;
  description?: string;
  quantity: number;
  unit: Money;
  unitTax: Money;
};
export type OrderDraftFacts = {
  total: Money;
  itemTotal: Money;
  taxTotal: Money;
  shipping: Money;
  discount: Money;
  lines: OrderLine[];
};
export type OrderFacts = {
  id: string;
  status: string;
  total: Money;
  customId: string | null;
  captureId: string | null;
};

const orderStatuses = [
  'CREATED',
  'SAVED',
  'APPROVED',
  'PAYER_ACTION_REQUIRED',
  'VOIDED',
  'COMPLETED',
];

// Catalog amounts are JSON numbers. Accept only values whose shortest decimal
// form is a plain two-decimal amount; anything else is unresolved context.
function amount(input: unknown, currency: Currency, positive: boolean): Money {
  if (typeof input !== 'number' || !Number.isFinite(input)) fail();
  const text = String(input);
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(text)) fail();
  return parseMoney({ value: text, currency_code: currency }, positive);
}

function text(input: unknown, maximum: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum)
    fail();
  return input;
}

function line(input: unknown, currency: Currency): OrderLine {
  const item = object(input);
  const quantity = Object.hasOwn(item, 'quantity') ? item.quantity : 1;
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 1_000_000
  )
    fail();
  const unit = amount(item.itemCost, currency, true);
  // A supplied line total is reconciled, never trusted.
  const declared = amount(item.itemTotal, currency, true);
  if (declared.minor !== unit.minor * BigInt(quantity)) fail();
  const taxPercent = Object.hasOwn(item, 'taxPercent') ? item.taxPercent : 0;
  if (
    typeof taxPercent !== 'number' ||
    !/^(0|[1-9]\d{0,2})(\.\d{1,2})?$/.test(String(taxPercent)) ||
    taxPercent > 100
  )
    fail();
  const basisPoints = BigInt(Math.round(taxPercent * 100));
  // Per-unit tax must be exact in minor units; rounding rules are not assumed.
  if ((unit.minor * basisPoints) % 10_000n !== 0n) fail();
  const unitTax = fromMinor((unit.minor * basisPoints) / 10_000n, currency);
  const result: OrderLine = {
    name: text(item.name, 127),
    quantity,
    unit,
    unitTax,
  };
  if (Object.hasOwn(item, 'description'))
    result.description = text(item.description, 127);
  return result;
}

export function createOrder(args: JsonObject): OrderDraftFacts {
  // Return and cancel URLs, addresses and notes belong to the trusted server.
  if (
    ['shippingAddress', 'notes', 'returnUrl', 'cancelUrl'].some((key) =>
      Object.hasOwn(args, key),
    )
  )
    fail();
  const currency = parseMoney(
    { value: '0', currency_code: args.currencyCode },
    false,
  ).currency;
  if (currency !== 'USD') fail();
  if (
    !Array.isArray(args.items) ||
    !args.items.length ||
    args.items.length > 50
  )
    fail();
  const lines = args.items.map((item) => line(item, currency));
  let items = 0n;
  let tax = 0n;
  for (const entry of lines) {
    items += entry.unit.minor * BigInt(entry.quantity);
    tax += entry.unitTax.minor * BigInt(entry.quantity);
  }
  const discount = amount(
    Object.hasOwn(args, 'discount') ? args.discount : 0,
    currency,
    false,
  );
  const shipping = amount(
    Object.hasOwn(args, 'shippingCost') ? args.shippingCost : 0,
    currency,
    false,
  );
  if (discount.minor > items) fail();
  const total = items + tax + shipping.minor - discount.minor;
  if (total <= 0n) fail();
  return {
    total: fromMinor(total, currency),
    itemTotal: fromMinor(items, currency),
    taxTotal: fromMinor(tax, currency),
    shipping,
    discount,
    lines,
  };
}

export async function readOrder(
  get: (path: string) => Promise<unknown>,
  id: string,
  merchantId: string,
): Promise<OrderFacts> {
  const order = object(await get(`/v2/checkout/orders/${id}`));
  if (
    order.id !== id ||
    order.intent !== 'CAPTURE' ||
    typeof order.status !== 'string' ||
    !orderStatuses.includes(order.status) ||
    !Array.isArray(order.purchase_units) ||
    order.purchase_units.length !== 1
  )
    fail();
  const unit = object(order.purchase_units[0]);
  if (object(unit.payee).merchant_id !== merchantId) fail();
  const summary = object(unit.amount);
  const total = parseMoney({
    value: summary.value,
    currency_code: summary.currency_code,
  });
  if (total.currency !== 'USD') fail();
  let captureId: string | null = null;
  if (Object.hasOwn(unit, 'payments')) {
    const payments = object(unit.payments);
    const captures = Object.hasOwn(payments, 'captures')
      ? payments.captures
      : [];
    if (!Array.isArray(captures) || captures.length > 1) fail();
    if (captures.length === 1) {
      const capture = object(captures[0]);
      captureId = identifier(capture.id, 15, 32);
      const captured = parseMoney(capture.amount);
      if (
        captured.currency !== total.currency ||
        captured.minor !== total.minor
      )
        fail();
    }
  }
  if ((order.status === 'COMPLETED') !== (captureId !== null)) fail();
  return {
    id,
    status: order.status,
    total,
    customId: Object.hasOwn(unit, 'custom_id')
      ? identifier(unit.custom_id, 1, 127)
      : null,
    captureId,
  };
}
