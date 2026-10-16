import { email, fail, identifier, object } from './json.ts';
import { parseMoney } from './money.ts';

const statuses = new Set([
  'OPEN',
  'WAITING_FOR_BUYER_RESPONSE',
  'WAITING_FOR_SELLER_RESPONSE',
  'UNDER_REVIEW',
  'RESOLVED',
  'OTHER',
]);
const stages = new Set([
  'INQUIRY',
  'CHARGEBACK',
  'PRE_ARBITRATION',
  'ARBITRATION',
]);
const claimTypes = new Set([
  'REFUND',
  'REFUND_WITH_RETURN',
  'PARTIAL_REFUND',
  'REFUND_WITH_RETURN_SHIPMENT_LABEL',
]);

export function disputeIdentifier(value: unknown): string {
  const id = identifier(value, 1, 255);
  if (!/^[A-Za-z0-9-]+$/.test(id)) fail('invalid_arguments');
  return id;
}

// This baseline accepts canonical UTC seconds or milliseconds, not date coercion.
export function disputeDeadline(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    fail();
  const millis = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (
    !Number.isSafeInteger(millis) ||
    millis < 0 ||
    new Date(millis).toISOString() !== canonical
  )
    fail();
  return canonical;
}

export async function readDispute(
  get: (path: string) => Promise<unknown>,
  id: string,
  merchantId: string,
  merchantEmail: string,
) {
  const record = object(
    await get(`/v1/customer/disputes/${disputeIdentifier(id)}`),
  );
  if (
    record.dispute_id !== id ||
    typeof record.status !== 'string' ||
    !statuses.has(record.status) ||
    typeof record.dispute_life_cycle_stage !== 'string' ||
    !stages.has(record.dispute_life_cycle_stage) ||
    Object.hasOwn(record, 'dispute_asset') ||
    !Array.isArray(record.disputed_transactions) ||
    record.disputed_transactions.length !== 1
  )
    fail();
  const transaction = object(record.disputed_transactions[0]);
  const seller = object(transaction.seller);
  if (
    seller.merchant_id !== merchantId ||
    (Object.hasOwn(seller, 'email') && email(seller.email) !== merchantEmail) ||
    Object.hasOwn(transaction, 'gross_asset') ||
    typeof transaction.transaction_status !== 'string' ||
    !['COMPLETED', 'HELD'].includes(transaction.transaction_status)
  )
    fail();
  const transactionId = disputeIdentifier(transaction.seller_transaction_id);
  const amount = parseMoney(record.dispute_amount);
  const gross = parseMoney(transaction.gross_amount);
  if (amount.currency !== gross.currency || amount.minor > gross.minor) fail();
  const dueAt = Object.hasOwn(record, 'seller_response_due_date')
    ? disputeDeadline(record.seller_response_due_date)
    : undefined;
  let refund = false;
  if (Object.hasOwn(record, 'allowed_response_options')) {
    const options = object(record.allowed_response_options);
    if (Object.hasOwn(options, 'accept_claim')) {
      const types = object(options.accept_claim).accept_claim_types;
      if (
        !Array.isArray(types) ||
        types.length === 0 ||
        types.length > claimTypes.size ||
        new Set(types).size !== types.length ||
        types.some((v) => typeof v !== 'string' || !claimTypes.has(v))
      )
        fail();
      refund = types.includes('REFUND');
    }
  }
  let linked = false;
  if (Object.hasOwn(record, 'links')) {
    if (!Array.isArray(record.links) || record.links.length > 32) fail();
    const links = record.links
      .map(object)
      .filter((link) => link.rel === 'accept-claim');
    if (links.length > 1) fail();
    linked =
      links.length === 1 &&
      links[0]!.method === 'POST' &&
      links[0]!.href ===
        `https://api-m.sandbox.paypal.com/v1/customer/disputes/${id}/accept-claim`;
  }
  return {
    id,
    transactionId,
    amount,
    gross,
    transactionStatus: transaction.transaction_status,
    status: record.status,
    stage: record.dispute_life_cycle_stage,
    ...(dueAt === undefined ? {} : { dueAt }),
    canAccept:
      !['RESOLVED', 'OTHER'].includes(record.status) && refund && linked,
  };
}
