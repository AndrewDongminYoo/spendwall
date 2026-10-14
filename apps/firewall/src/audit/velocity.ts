import { object, snapshot } from '../context/json.ts';

export type VelocityMetadata = Readonly<{
  v: 1;
  key_id: string;
  merchant_ref: string;
  customer_ref: string;
  request_id: string;
  binding_hash: string;
  usd_cents: number;
}>;

export function parseVelocityMetadata(input: unknown): VelocityMetadata {
  const invalid = (): never => {
    throw new Error('Invalid velocity metadata.');
  };
  try {
    const value = object(snapshot(input));
    const fields = [
      'v',
      'key_id',
      'merchant_ref',
      'customer_ref',
      'request_id',
      'binding_hash',
      'usd_cents',
    ];
    if (
      Object.keys(value).length !== fields.length ||
      fields.some((key) => !Object.hasOwn(value, key)) ||
      value.v !== 1
    )
      invalid();
    const hex = (entry: unknown): string => {
      if (typeof entry !== 'string' || !/^[a-f0-9]{64}$/.test(entry)) invalid();
      return entry as string;
    };
    const request = value.request_id;
    const cents = value.usd_cents;
    if (
      typeof request !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        request,
      ) ||
      typeof cents !== 'number' ||
      !Number.isSafeInteger(cents) ||
      cents < 0 ||
      cents > 1_000_000_000
    )
      invalid();
    return Object.freeze({
      v: 1,
      key_id: hex(value.key_id),
      merchant_ref: hex(value.merchant_ref),
      customer_ref: hex(value.customer_ref),
      request_id: request as string,
      binding_hash: hex(value.binding_hash),
      usd_cents: cents as number,
    });
  } catch {
    return invalid();
  }
}
