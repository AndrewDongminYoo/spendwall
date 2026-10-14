const rates = Object.freeze({
  USD: { decimals: 2, numerator: 1n, denominator: 1n },
  EUR: { decimals: 2, numerator: 11n, denominator: 10n },
  KRW: { decimals: 0, numerator: 1n, denominator: 14n },
});

export type NormalizedAmount = Readonly<{
  value: string;
  currency: keyof typeof rates;
  usd: number;
}>;

function invalid(): never {
  throw new Error('Invalid amount for demo currency normalization.');
}

export function normalizeAmount(amount: unknown): NormalizedAmount {
  if (amount === null || typeof amount !== 'object' || Array.isArray(amount))
    invalid();
  const prototype = Object.getPrototypeOf(amount);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const fields = Object.getOwnPropertyDescriptors(amount);
  if (
    Reflect.ownKeys(amount).length !== 2 ||
    !fields.value ||
    !fields.currency ||
    !('value' in fields.value) ||
    !('value' in fields.currency)
  )
    invalid();
  const value: unknown = fields.value.value;
  const currency: unknown = fields.currency.value;
  if (
    typeof value !== 'string' ||
    typeof currency !== 'string' ||
    !Object.hasOwn(rates, currency)
  )
    invalid();
  const code = currency as keyof typeof rates;
  const rate = rates[code];
  const match = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$/.exec(value);
  if (!match || (match[2]?.length ?? 0) > rate.decimals) invalid();
  const minor = BigInt(match[1]! + (match[2] ?? '').padEnd(rate.decimals, '0'));
  const cents =
    (minor * rate.numerator + rate.denominator - 1n) / rate.denominator;
  if (cents > 1_000_000_000n) invalid();
  return Object.freeze({ value, currency: code, usd: Number(cents) / 100 });
}
