export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };
export type DenyReason =
  | 'unsupported_tool'
  | 'invalid_arguments'
  | 'unresolved_context'
  | 'stale_context';

export class ResolutionError extends Error {
  readonly reason: DenyReason;
  constructor(reason: DenyReason = 'unresolved_context') {
    super('Context resolution denied.');
    this.reason = reason;
  }
}
export function fail(reason: DenyReason = 'unresolved_context'): never {
  throw new ResolutionError(reason);
}
export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail();
  return value as JsonObject;
}
export function identifier(value: unknown, minimum = 1, maximum = 128): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    fail();
  return value;
}
export function email(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(
      value,
    )
  )
    fail();
  const [local, domain] = value.split('@');
  return `${local}@${domain!.toLowerCase()}`;
}

// Copy inert JSON without running getters/toJSON; bound both structure and text.
export function snapshot(input: unknown): Json {
  let values = 4096;
  let bytes = 65_536;
  const ancestors = new Set<object>();
  const text = (value: string) => {
    bytes -= Buffer.byteLength(value);
    if (bytes < 0) fail('invalid_arguments');
    return value;
  };
  const copy = (value: unknown, depth: number): Json => {
    if (--values < 0 || depth > 16) fail('invalid_arguments');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null || ancestors.has(value))
      fail('invalid_arguments');
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (
      (array && proto !== Array.prototype) ||
      (!array && proto !== Object.prototype && proto !== null) ||
      Object.getOwnPropertySymbols(value).length
    )
      fail('invalid_arguments');
    const fields = Object.getOwnPropertyDescriptors(value);
    ancestors.add(value);
    let result: Json;
    if (array) {
      const length = fields.length!.value as number;
      if (length > values || Object.keys(fields).length !== length + 1)
        fail('invalid_arguments');
      result = Array.from({ length }, (_, i) => {
        const field = fields[String(i)];
        if (!field || !('value' in field)) fail('invalid_arguments');
        return copy(field.value, depth + 1);
      });
    } else {
      const output: JsonObject = {};
      for (const [key, field] of Object.entries(fields)) {
        if (
          ['__proto__', 'constructor', 'prototype'].includes(key) ||
          !field.enumerable ||
          !('value' in field)
        )
          fail('invalid_arguments');
        output[text(key)] = copy(field.value, depth + 1);
      }
      result = output;
    }
    ancestors.delete(value);
    return result;
  };
  return copy(input, 0);
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
