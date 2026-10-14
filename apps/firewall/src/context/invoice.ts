import { email, fail, object } from './json.ts';
import type { JsonObject } from './json.ts';
import { fromMinor, parseMoney } from './money.ts';
import type { Currency, Money } from './money.ts';

export type InvoiceFacts = {
  id: string | null;
  status: string;
  recipient: string;
  additionalRecipients: number;
  total: Money;
  itemTotal: Money;
  shipping: Money;
};

function recipient(input: unknown): string {
  if (!Array.isArray(input) || input.length !== 1) fail();
  return email(object(object(input[0]).billing_info).email_address);
}

function itemsTotal(input: unknown, currency: Currency): Money {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) fail();
  let total = 0n;
  for (const item of input) {
    const line = object(item);
    if (
      typeof line.name !== 'string' ||
      !line.name.trim() ||
      typeof line.quantity !== 'string' ||
      !/^[1-9]\d{0,6}$/.test(line.quantity) ||
      BigInt(line.quantity) > 1_000_000n ||
      Object.hasOwn(line, 'tax') ||
      Object.hasOwn(line, 'discount')
    )
      fail();
    const unit = parseMoney(line.unit_amount);
    if (unit.currency !== currency) fail();
    total += unit.minor * BigInt(line.quantity);
  }
  return fromMinor(total, currency);
}

export function createInvoice(
  args: JsonObject,
  merchantEmail: string,
): InvoiceFacts {
  if (
    Object.hasOwn(args, 'invoicer_email_address') &&
    email(args.invoicer_email_address) !== merchantEmail
  )
    fail();
  if (
    args.allow_partial_payment === true ||
    args.allow_tip === true ||
    [
      'minimum_partial_payment_amount',
      'enable_pay_by_bank',
      'pay_by_bank_exclusive_above_threshold',
    ].some((key) => Object.hasOwn(args, key))
  )
    fail();
  // Normalize an inert zero amount to validate the existing policy currency set.
  const currency = parseMoney(
    { value: '0', currency_code: args.currency_code },
    false,
  ).currency;
  const itemTotal = itemsTotal(args.items, currency);
  const shipping = parseMoney(
    { value: args.shipping_cost ?? '0', currency_code: currency },
    false,
  );
  const total = fromMinor(itemTotal.minor + shipping.minor, currency);
  return {
    id: null,
    status: 'PROPOSED',
    recipient: recipient(args.primary_recipients),
    additionalRecipients: 0,
    total,
    itemTotal,
    shipping,
  };
}

export async function readInvoice(
  get: (path: string) => Promise<unknown>,
  id: string,
  merchantEmail: string,
): Promise<InvoiceFacts> {
  const invoice = object(await get(`/v2/invoicing/invoices/${id}`));
  if (
    invoice.id !== id ||
    typeof invoice.status !== 'string' ||
    ![
      'DRAFT',
      'SCHEDULED',
      'SENT',
      'UNPAID',
      'PAID',
      'PARTIALLY_PAID',
      'CANCELLED',
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'MARKED_AS_PAID',
      'MARKED_AS_REFUNDED',
      'PAYMENT_PENDING',
    ].includes(invoice.status) ||
    email(object(invoice.invoicer).email_address) !== merchantEmail
  )
    fail();
  const summary = object(invoice.amount);
  if (
    Object.keys(summary).some(
      (key) => !['value', 'currency_code', 'breakdown'].includes(key),
    )
  )
    fail();
  const total = parseMoney({
    value: summary.value,
    currency_code: summary.currency_code,
  });
  if (object(invoice.detail).currency_code !== total.currency) fail();
  const itemTotal = itemsTotal(invoice.items, total.currency);
  let shipping = fromMinor(0n, total.currency);
  if (Object.hasOwn(summary, 'breakdown')) {
    const breakdown = object(summary.breakdown);
    if (
      Object.keys(breakdown).some(
        (key) => !['item_total', 'shipping', 'tax_total'].includes(key),
      )
    )
      fail();
    if (Object.hasOwn(breakdown, 'item_total')) {
      const declared = parseMoney(breakdown.item_total, false);
      if (
        declared.currency !== total.currency ||
        declared.minor !== itemTotal.minor
      )
        fail();
    }
    if (Object.hasOwn(breakdown, 'tax_total')) {
      const tax = parseMoney(breakdown.tax_total, false);
      if (tax.currency !== total.currency || tax.minor !== 0n) fail();
    }
    if (Object.hasOwn(breakdown, 'shipping')) {
      const value = object(breakdown.shipping);
      if (Object.keys(value).some((key) => key !== 'amount')) fail();
      shipping = parseMoney(value.amount, false);
      if (shipping.currency !== total.currency) fail();
    }
  }
  if (Object.hasOwn(invoice, 'configuration')) {
    const config = object(invoice.configuration);
    for (const [key, value] of Object.entries(config)) {
      if (key === 'tax_calculated_after_discount' && typeof value === 'boolean')
        continue;
      if (
        ['allow_tip', 'tax_inclusive', 'has_conditional_rule'].includes(key) &&
        value === false
      )
        continue;
      if (key === 'template_id' && typeof value === 'string') continue;
      fail();
    }
  }
  if (total.minor !== itemTotal.minor + shipping.minor) fail();
  const additional = Object.hasOwn(invoice, 'additional_recipients')
    ? invoice.additional_recipients
    : [];
  if (!Array.isArray(additional) || additional.length > 100) fail();
  for (const address of additional) email(address);
  return {
    id,
    status: invoice.status,
    recipient: recipient(invoice.primary_recipients),
    additionalRecipients: additional.length,
    total,
    itemTotal,
    shipping,
  };
}
