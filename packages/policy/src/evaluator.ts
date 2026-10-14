import type { LoadedPolicy, Policy } from './index.ts';
import { normalizeAmount } from './money.ts';

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type Decision = Policy['rules'][number]['then'];
export type PolicyDecision = Readonly<{
  decision: Decision;
  matchedRules: readonly string[];
  policyVersion: string;
}>;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonblank(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function snapshotContext(input: unknown): JsonObject {
  let remainingValues = 4_096;
  let remainingText = 65_536;
  const ancestors = new Set<object>();
  const text = (value: string): string => {
    remainingText -= Buffer.byteLength(value, 'utf8');
    if (remainingText < 0) throw new Error('Excessive context text.');
    return value;
  };
  const copy = (value: unknown, depth: number): JsonValue => {
    if (--remainingValues < 0 || depth > 16)
      throw new Error('Excessive context structure.');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || ancestors.has(value))
      throw new Error('Expected JSON context.');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== null && prototype !== Object.prototype)
    )
      throw new Error('Expected plain JSON context.');
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new Error('Unexpected context symbol.');
    const fields = Object.getOwnPropertyDescriptors(value);
    ancestors.add(value);
    let result: JsonValue;
    if (array) {
      const length = fields.length!.value as number;
      if (length > remainingValues || Object.keys(fields).length !== length + 1)
        throw new Error('Sparse or excessive context array.');
      result = Array.from({ length }, (_, index) => {
        const field = fields[String(index)];
        if (!field || !('value' in field))
          throw new Error('Invalid context array element.');
        return copy(field.value, depth + 1);
      });
    } else {
      const object: JsonObject = Object.create(null);
      for (const [key, field] of Object.entries(fields)) {
        if (
          ['__proto__', 'constructor', 'prototype'].includes(key) ||
          !field.enumerable ||
          !('value' in field)
        )
          throw new Error('Invalid context field.');
        object[text(key)] = copy(field.value, depth + 1);
      }
      result = object;
    }
    ancestors.delete(value);
    return result;
  };
  const result = copy(input, 0);
  if (!isObject(result)) throw new Error('Expected a context object.');
  return result;
}

const priority: Record<Decision, number> = {
  allow: 0,
  require_approval: 1,
  deny: 2,
};

export function evaluatePolicy(
  policy: LoadedPolicy,
  input: unknown,
): PolicyDecision {
  const matchedRules: string[] = [];
  const result = (decision: Decision): PolicyDecision =>
    Object.freeze({
      decision,
      matchedRules: Object.freeze(matchedRules),
      policyVersion: policy.policyVersion,
    });
  let context: JsonObject;
  try {
    context = snapshotContext(input);
    const expected = [
      'tool',
      'args',
      'amount',
      'agent',
      'customer',
      'merchant',
      'agg',
    ];
    if (
      Object.keys(context).length !== expected.length ||
      expected.some((key) => !Object.hasOwn(context, key)) ||
      !nonblank(context.tool) ||
      !isObject(context.args) ||
      !isObject(context.agg) ||
      ['agent', 'customer', 'merchant'].some((key) => {
        const identity = context[key];
        return !isObject(identity) || !nonblank(identity.id);
      })
    )
      return result('deny');
    context.amount = normalizeAmount(context.amount);
  } catch {
    return result('deny');
  }
  const agentId = (context.agent as JsonObject).id as string;
  const tool = context.tool as string;
  const agent = Object.hasOwn(policy.agents, agentId)
    ? policy.agents[agentId]
    : undefined;
  if (
    !agent ||
    agent.tools.deny.includes(tool) ||
    !agent.tools.allow.includes(tool)
  )
    return result('deny');

  let decision: Decision | undefined;
  let failed = false;
  for (const rule of policy.rules) {
    try {
      const matches = rule.condition(context, { failClosed: true });
      if (typeof matches !== 'boolean') {
        failed = true;
      } else if (matches) {
        matchedRules.push(rule.id);
        if (decision === undefined || priority[rule.then] > priority[decision])
          decision = rule.then;
      }
    } catch {
      failed = true;
    }
  }
  return result(failed ? 'deny' : (decision ?? policy.default));
}
