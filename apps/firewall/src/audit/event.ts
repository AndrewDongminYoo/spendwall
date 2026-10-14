import { createHash } from 'node:crypto';

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type AuditEvent = {
  agentId: string;
  tool: string;
  args: unknown;
  resolvedCtx: unknown;
  decision: 'allow' | 'deny' | 'require_approval';
  matchedRules: readonly string[];
  policyVersion: string;
  eventKind:
    'tool_call' | 'approval_created' | 'approval_decided' | 'approval_executed';
  approvalId?: string;
  upstreamStatus?: number;
  upstreamResultRef?: string;
  latencyMs: number;
};

function invalid(): never {
  throw new Error('Invalid audit event.');
}

// Snapshot JSON without invoking getters, toJSON, or coercion. Hash only JSON.
function snapshot(value: unknown, depth = 0): Json {
  if (depth > 32) invalid();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) invalid();
    const result: Json[] = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !('value' in descriptor)) invalid();
      result.push(snapshot(descriptor.value, depth + 1));
    }
    return result;
  }
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const result: { [key: string]: Json } = Object.create(null);
  for (const key of Reflect.ownKeys(value).sort((a, b) =>
    String(a).localeCompare(String(b)),
  )) {
    if (
      typeof key !== 'string' ||
      ['__proto__', 'constructor', 'prototype'].includes(key)
    )
      invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      invalid();
    result[key] = snapshot(descriptor.value, depth + 1);
  }
  return result;
}

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const numericFields = new Set([
  'amount_minor',
  'refunded_minor',
  'remaining_minor',
  'age_hours',
  'quantity',
]);
const statuses = new Set([
  'COMPLETED',
  'PENDING',
  'FAILED',
  'CANCELLED',
  'DENIED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
]);
// Match the demo's supported currencies without importing policy code.
const currencies = new Set(['USD', 'EUR', 'KRW']);

function money(value: Json): Json | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return;
  const currency = value.currency_code ?? value.currency;
  if (
    typeof currency !== 'string' ||
    !currencies.has(currency) ||
    typeof value.value !== 'string' ||
    !/^\d{1,12}(?:\.\d{1,2})?$/.test(value.value) ||
    (currency === 'KRW' && value.value.includes('.')) ||
    (Object.hasOwn(value, 'currency') && value.currency !== currency) ||
    (Object.hasOwn(value, 'currency_code') && value.currency_code !== currency)
  )
    return;
  return {
    value: value.value,
    ...(Object.hasOwn(value, 'currency') ? { currency } : {}),
    ...(Object.hasOwn(value, 'currency_code')
      ? { currency_code: currency }
      : {}),
  };
}

// Conservative allowlist: no arbitrary field names, identifiers, arrays or text.
function redact(value: Json): Json {
  const safe: { [key: string]: Json } = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return safe;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'amount') {
      const amount = money(entry);
      if (amount !== undefined) safe[key] = amount;
    } else if (
      numericFields.has(key) &&
      typeof entry === 'number' &&
      Number.isSafeInteger(entry) &&
      entry >= 0
    )
      safe[key] = entry;
    else if (
      ['currency', 'currency_code'].includes(key) &&
      typeof entry === 'string' &&
      currencies.has(entry)
    )
      safe[key] = entry;
    else if (
      key === 'status' &&
      typeof entry === 'string' &&
      statuses.has(entry)
    )
      safe[key] = entry;
  }
  return safe;
}

function label(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value) ||
    /^(?:Bearer|Basic|gh[pousr]_|sk[-_])/i.test(value)
  )
    invalid();
  return value;
}

function uuid(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    invalid();
  return value.toLowerCase();
}

export function prepareEvent(input: AuditEvent) {
  const args = snapshot(input.args);
  const context = snapshot(input.resolvedCtx);
  const original = canonical(args);
  if (
    Buffer.byteLength(original) > 65_536 ||
    Buffer.byteLength(canonical(context)) > 65_536
  )
    invalid();
  if (
    !['allow', 'deny', 'require_approval'].includes(input.decision) ||
    ![
      'tool_call',
      'approval_created',
      'approval_decided',
      'approval_executed',
    ].includes(input.eventKind)
  )
    invalid();
  if (
    typeof input.policyVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.policyVersion)
  )
    invalid();
  if (
    !Number.isSafeInteger(input.latencyMs) ||
    input.latencyMs < 0 ||
    input.latencyMs > 2_147_483_647
  )
    invalid();
  if (
    input.upstreamStatus !== undefined &&
    (!Number.isInteger(input.upstreamStatus) ||
      input.upstreamStatus < 100 ||
      input.upstreamStatus > 599)
  )
    invalid();
  if (!Array.isArray(input.matchedRules) || input.matchedRules.length > 128)
    invalid();
  const approval = uuid(input.approvalId);
  if (input.eventKind !== 'tool_call' && !approval) invalid();
  return {
    agent_id: label(input.agentId),
    tool: label(input.tool),
    args_redacted: redact(args),
    args_hash: createHash('sha256').update(original).digest('hex'),
    resolved_ctx: redact(context),
    decision: input.decision,
    matched_rules: input.matchedRules.map(label),
    policy_version: input.policyVersion,
    event_kind: input.eventKind,
    approval_id: approval,
    upstream_status: input.upstreamStatus ?? null,
    upstream_result_ref: uuid(input.upstreamResultRef),
    latency_ms: input.latencyMs,
  };
}
