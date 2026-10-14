import { createHash } from 'node:crypto';
import { Environment, type ASTNode } from '@marcbachmann/cel-js';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const name = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'Must not be blank.',
  });
const agentId = name.refine(
  (value) => !['__proto__', 'prototype', 'constructor'].includes(value),
  { message: 'Reserved agent ID.' },
);
const tools = z
  .strictObject({
    allow: z.array(name).readonly(),
    deny: z.array(name).readonly(),
  })
  .readonly();
const rule = z
  .strictObject({
    id: name,
    when: name.max(4_096),
    then: z.enum(['allow', 'deny', 'require_approval']),
  })
  .readonly();

export const policySchema = z
  .strictObject({
    agents: z
      .unknown()
      // Zod records omit __proto__ before key validation, so inspect the input.
      .refine(
        (value) =>
          value === null ||
          typeof value !== 'object' ||
          !Object.hasOwn(value, '__proto__'),
        { message: 'Reserved agent ID.' },
      )
      .pipe(z.record(agentId, z.strictObject({ tools }).readonly()))
      .readonly(),
    rules: z.array(rule).readonly(),
    default: z.literal('deny'),
  })
  .superRefine((policy, context) => {
    const ids = new Set<string>();
    policy.rules.forEach((entry, index) => {
      if (ids.has(entry.id))
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'id'],
          message: 'Duplicate rule ID.',
        });
      ids.add(entry.id);
    });
  })
  .readonly();

export type Policy = z.infer<typeof policySchema>;
type CompiledRule = Policy['rules'][number] & {
  readonly condition: (context: Record<string, unknown>) => unknown;
};
export type LoadedPolicy = Omit<Policy, 'rules'> & {
  readonly rules: readonly CompiledRule[];
  readonly policyVersion: string;
};

const cel = new Environment({
  unlistedVariablesAreDyn: true,
  limits: { maxDepth: 64, maxAstNodes: 4_096 },
});

function pathFor(parts: PropertyKey[]): string {
  return parts.reduce<string>((path, part) => {
    if (typeof part === 'number') return `${path}[${part}]`;
    const key = String(part);
    return /^[A-Za-z_]\w*$/.test(key)
      ? `${path}.${key}`
      : `${path}[${JSON.stringify(key)}]`;
  }, '$');
}

function invalid(path: string, reason: string): never {
  throw new Error(`Invalid policy at ${path}: ${reason}`);
}

function checkAstDepth(ast: ASTNode): void {
  const pending: { value: unknown; depth: number }[] = [
    { value: ast, depth: 0 },
  ];
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, depth });
    } else if (
      value !== null &&
      typeof value === 'object' &&
      'op' in value &&
      'args' in value
    ) {
      if (depth > 64) throw new Error('Excessive CEL AST depth.');
      if (value.op !== 'value' && value.op !== 'id')
        pending.push({ value: value.args, depth: depth + 1 });
    }
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function loadPolicy(source: string): LoadedPolicy {
  if (typeof source !== 'string') invalid('$', 'Expected YAML text.');
  if (Buffer.byteLength(source, 'utf8') > 65_536)
    invalid('$', 'YAML must not exceed 64 KiB.');

  const document = parseDocument(source, {
    version: '1.2',
    schema: 'core',
    stringKeys: true,
    uniqueKeys: true,
  });
  const diagnostic = document.errors[0] ?? document.warnings[0];
  if (diagnostic) {
    const position = diagnostic.linePos?.[0];
    const location = position
      ? `$ (line ${position.line}, column ${position.col})`
      : '$';
    invalid(location, `YAML ${diagnostic.code}.`);
  }
  if (document.directives?.yaml.version !== '1.2')
    invalid('$', 'Only YAML 1.2 is supported.');

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    invalid('$', 'YAML aliases or invalid values are not supported.');
  }
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    invalid(pathFor(issue.path), issue.message);
  }
  const policy = parsed.data;
  const rules = policy.rules.map((entry, index) => {
    let expression;
    try {
      expression = cel.parse(entry.when);
      // The parser's depth limit does not cover every operator, including unary.
      checkAstDepth(expression.ast);
    } catch {
      invalid(`$.rules[${index}].when`, 'Invalid or excessive CEL expression.');
    }
    const condition = (context: Record<string, unknown>): unknown =>
      expression(context);
    return Object.freeze({ ...entry, condition: Object.freeze(condition) });
  });
  return Object.freeze({
    ...policy,
    rules: Object.freeze(rules),
    policyVersion: createHash('sha256').update(canonical(policy)).digest('hex'),
  });
}
