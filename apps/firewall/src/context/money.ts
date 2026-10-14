import { normalizeAmount } from '../../../../packages/policy/src/index.ts';
import type { NormalizedAmount } from '../../../../packages/policy/src/index.ts';
import { fail, object } from './json.ts';

export type Currency = NormalizedAmount['currency'];
export type Money = { value: string; currency: Currency; minor: bigint };

export function parseMoney(input: unknown, positive = true): Money {
  const value = object(input);
  if (
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'value') ||
    !Object.hasOwn(value, 'currency_code')
  )
    fail();
  const normalized = normalizeAmount({
    value: value.value,
    currency: value.currency_code,
  });
  const [whole, fraction = ''] = normalized.value.split('.');
  const decimals = normalized.currency === 'KRW' ? 0 : 2;
  const minor = BigInt(whole! + fraction.padEnd(decimals, '0'));
  if (positive && minor <= 0n) fail();
  return { value: normalized.value, currency: normalized.currency, minor };
}

export function fromMinor(minor: bigint, currency: Currency): Money {
  if (minor < 0n) fail();
  const scale = currency === 'KRW' ? 1n : 100n;
  const value =
    currency === 'KRW'
      ? String(minor)
      : `${minor / scale}.${String(minor % scale).padStart(2, '0')}`;
  return parseMoney({ value, currency_code: currency }, false);
}
export function policyAmount(money: Money) {
  return { value: money.value, currency: money.currency };
}
export function normalizedAmount(money: Money) {
  return normalizeAmount(policyAmount(money));
}
