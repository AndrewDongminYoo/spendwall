import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import * as policyModule from '../packages/policy/src/index.ts';

const minimal = 'agents: {}\nrules: []\ndefault: deny\n';
const example = `
agents:
  support:
    tools:
      allow: [get_order, create_refund]
      deny: [create_payout]
rules:
  - id: small-refund
    when: 'tool == "create_refund" && amount.usd <= 100'
    then: allow
  - id: review-refund
    when: 'amount.usd > 100'
    then: require_approval
default: deny
`;

test('the package name exposes the loader to a Node consumer', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {loadPolicy} from '@spendwall/policy';
       console.log(loadPolicy(${JSON.stringify(minimal)}).default);`,
    ],
    {
      cwd: new URL('../packages/policy/', import.meta.url),
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'deny');
});

function load(source = example) {
  const result = policyModule.loadPolicy(source);
  assert.ok(result, 'loadPolicy must return a validated policy');
  return result;
}

function rejects(source, path) {
  assert.throws(
    () => policyModule.loadPolicy(source),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(path), error.message);
      return true;
    },
    `must reject the policy at ${path}`,
  );
}

test('loads the empty deny policy and publishes a canonical SHA-256 version', () => {
  const loaded = load(minimal);
  assert.deepEqual(loaded.agents, {});
  assert.deepEqual(loaded.rules, []);
  assert.equal(loaded.default, 'deny');
  assert.equal(
    loaded.policyVersion,
    createHash('sha256')
      .update('{"agents":{},"default":"deny","rules":[]}')
      .digest('hex'),
  );
});

test('exports a strict Zod schema for the same policy shape', () => {
  assert.ok(policyModule.policySchema, 'policySchema must be exported');
  assert.deepEqual(
    policyModule.policySchema.parse({ agents: {}, rules: [], default: 'deny' }),
    { agents: {}, rules: [], default: 'deny' },
  );
  assert.equal(
    policyModule.policySchema.safeParse({
      agents: {},
      rules: [],
      default: 'allow',
    }).success,
    false,
  );
});

test('prepares actual CEL conditions for reuse with different runtime contexts', () => {
  const loaded = load();
  assert.deepEqual(loaded.agents.support.tools, {
    allow: ['get_order', 'create_refund'],
    deny: ['create_payout'],
  });
  const rule = loaded.rules[0];
  assert.equal(rule.id, 'small-refund');
  assert.equal(rule.then, 'allow');
  assert.equal(
    rule.condition({ tool: 'create_refund', amount: { usd: 100 } }),
    true,
  );
  assert.equal(
    rule.condition({ tool: 'create_refund', amount: { usd: 100.01 } }),
    false,
  );
  assert.equal(
    rule.condition({ tool: 'get_order', amount: { usd: 5 } }),
    false,
  );
  assert.equal(loaded.rules[1].condition({ amount: { usd: 101 } }), true);
});

test('supports the #7 context names, presence tests, lists and CEL macros', () => {
  const source = `
agents: {}
rules:
  - id: context
    when: >-
      tool == "create_refund" && args.capture_id == "capture"
      && amount.usd <= 100 && agent.id == "support"
      && has(customer.vip) && customer.vip
      && merchant.id == "merchant" && agg.refund_count < 3
      && args.items.all(item, item > 0)
    then: allow
default: deny
`;
  const condition = load(source).rules[0].condition;
  const context = {
    tool: 'create_refund',
    args: { capture_id: 'capture', items: [1, 2] },
    amount: { usd: 99.99 },
    agent: { id: 'support' },
    customer: { vip: true },
    merchant: { id: 'merchant' },
    agg: { refund_count: 2 },
  };
  assert.equal(condition(context), true);
  assert.equal(condition({ ...context, customer: {} }), false);
  assert.equal(
    condition({ ...context, args: { ...context.args, items: [1, 0] } }),
    false,
  );
});

test('syntax preparation neither needs runtime context nor grants a decision', () => {
  const loaded = load(example.replace('amount.usd > 100', 'unknown.value'));
  assert.throws(() => loaded.rules[1].condition({}));
  const numeric = load(example.replace('amount.usd > 100', '42'));
  assert.equal(numeric.rules[1].condition({}), 42n);
});

for (const [label, source, path] of [
  ['unsafe default', minimal.replace('deny', 'allow'), '$.default'],
  [
    'approval default',
    minimal.replace('deny', 'require_approval'),
    '$.default',
  ],
  ['missing default', 'agents: {}\nrules: []', '$.default'],
  ['missing agents', 'rules: []\ndefault: deny', '$.agents'],
  ['missing rules', 'agents: {}\ndefault: deny', '$.rules'],
  ['unknown field', `${minimal}version: 1`, '$'],
  ['wrong agents type', minimal.replace('{}', '[]'), '$.agents'],
  ['wrong rules type', minimal.replace('[]', '{}'), '$.rules'],
  [
    'unknown agent field',
    example.replace('    tools:', '    admin: true\n    tools:'),
    '$.agents.support',
  ],
  [
    'missing deny list',
    example.replace('      deny: [create_payout]', ''),
    '$.agents.support.tools.deny',
  ],
  [
    'coerced tool name',
    example.replace('get_order, create_refund', '123, create_refund'),
    '$.agents.support.tools.allow[0]',
  ],
  [
    'blank tool name',
    example.replace('get_order, create_refund', '" ", create_refund'),
    '$.agents.support.tools.allow[0]',
  ],
  ['blank agent ID', example.replace('  support:', '  " ":'), '$.agents'],
  [
    'prototype agent ID',
    example.replace('  support:', '  __proto__:'),
    '$.agents',
  ],
  [
    'constructor agent ID',
    example.replace('  support:', '  constructor:'),
    '$.agents',
  ],
  [
    'unknown decision',
    example.replace('then: allow', 'then: approve'),
    '$.rules[0].then',
  ],
  [
    'boolean condition',
    example.replace("'amount.usd > 100'", 'true'),
    '$.rules[1].when',
  ],
  [
    'blank condition',
    example.replace("'amount.usd > 100'", "'  '"),
    '$.rules[1].when',
  ],
  [
    'duplicate rule ID',
    example.replace('id: review-refund', 'id: small-refund'),
    '$.rules[1].id',
  ],
  [
    'unknown rule field',
    example.replace('then: allow', 'then: allow\n    enabled: true'),
    '$.rules[0]',
  ],
  [
    'malformed CEL',
    example.replace('amount.usd > 100', 'amount.usd >'),
    '$.rules[1].when',
  ],
  [
    'CEL lexical error',
    example.replace('amount.usd > 100', 'true @ false'),
    '$.rules[1].when',
  ],
  [
    'CEL trailing input',
    example.replace('amount.usd > 100', 'true false'),
    '$.rules[1].when',
  ],
  [
    'oversized CEL',
    example.replace('amount.usd > 100', `true${' '.repeat(4096)}`),
    '$.rules[1].when',
  ],
  [
    'deep CEL',
    example.replace(
      'amount.usd > 100',
      `${'('.repeat(70)}true${')'.repeat(70)}`,
    ),
    '$.rules[1].when',
  ],
]) {
  test(`rejects ${label} with its policy path`, () => rejects(source, path));
}

test('accepts 64 unary CEL operators at the AST depth boundary', () => {
  const loaded = load(
    example.replace('amount.usd > 100', `${'!'.repeat(64)}true`),
  );
  assert.equal(loaded.rules[1].condition({}), true);
});

for (const count of [65, 4000]) {
  test(`rejects ${count} unary CEL operators before returning a condition`, () => {
    rejects(
      example.replace('amount.usd > 100', `${'!'.repeat(count)}true`),
      '$.rules[1].when',
    );
  });
}

for (const [label, source] of [
  ['empty YAML', ''],
  ['null YAML', 'null'],
  ['scalar YAML', 'hello'],
  ['sequence YAML', '[]'],
  ['duplicate YAML keys', `${minimal}default: allow`],
  ['multiple YAML documents', `${minimal}\n---\n${minimal}`],
  ['YAML alias', 'agents: &agents {}\nrules: *agents\ndefault: deny'],
  ['YAML cycle', 'agents: &agents {self: *agents}\nrules: []\ndefault: deny'],
  ['custom YAML tag', minimal.replace('deny', '!custom deny')],
  ['YAML 1.1', `%YAML 1.1\n---\n${minimal}`],
  [
    'merge key',
    'agents: {support: {<<: {tools: {allow: [], deny: []}}}}\nrules: []\ndefault: deny',
  ],
  ['oversized input', `${minimal}#${'x'.repeat(65_536)}`],
]) {
  test(`rejects ${label} without returning a policy`, () =>
    rejects(source, '$'));
}

test('YAML syntax failures include source coordinates without echoing the input', () => {
  assert.throws(
    () => policyModule.loadPolicy('agents: [not-a-secret-marker'),
    (error) => {
      assert.match(error.message, /\$.*line \d+.*column \d+/);
      assert.equal(error.message.includes('not-a-secret-marker'), false);
      return true;
    },
  );
});

test('counts UTF-8 bytes when bounding YAML input', () => {
  rejects(`${minimal}#${'한'.repeat(22_000)}`, '$');
});

test('hashes ignore YAML comments, quoting, whitespace and mapping order', () => {
  const equivalent = `
# A different presentation of the same policy
default: "deny"
rules:
  - then: allow
    when: 'tool == "create_refund" && amount.usd <= 100'
    id: small-refund
  - then: require_approval
    id: review-refund
    when: 'amount.usd > 100'
agents:
  support:
    tools:
      deny:
        - create_payout
      allow:
        - get_order
        - create_refund
`;
  assert.equal(load().policyVersion, load(equivalent).policyVersion);
});

test('content hashes include every policy field and preserve array order', () => {
  const original = load().policyVersion;
  const changes = [
    example.replace('support:', 'reviewer:'),
    example.replace('get_order, create_refund', 'create_refund, get_order'),
    example.replace('[create_payout]', '[]'),
    example.replace('id: small-refund', 'id: another-refund'),
    example.replace('amount.usd <= 100', 'amount.usd <= 99'),
    example.replace('then: allow', 'then: deny'),
    example.replace('amount.usd > 100', 'amount.usd  > 100'),
    example.replace(
      "  - id: small-refund\n    when: 'tool == \"create_refund\" && amount.usd <= 100'\n    then: allow\n  - id: review-refund\n    when: 'amount.usd > 100'\n    then: require_approval",
      "  - id: review-refund\n    when: 'amount.usd > 100'\n    then: require_approval\n  - id: small-refund\n    when: 'tool == \"create_refund\" && amount.usd <= 100'\n    then: allow",
    ),
  ];
  for (const changed of changes)
    assert.notEqual(load(changed).policyVersion, original);
});

test('policy data and compiled expressions cannot be changed under a saved hash', () => {
  const loaded = load();
  const mutations = [
    () => {
      loaded.default = 'allow';
    },
    () => {
      loaded.policyVersion = 'forged';
    },
    () => {
      loaded.agents.other = loaded.agents.support;
    },
    () => {
      loaded.agents.support.tools = { allow: ['*'], deny: [] };
    },
    () => {
      loaded.agents.support.tools.allow.push('create_payout');
    },
    () => {
      loaded.agents.support.tools.deny.pop();
    },
    () => {
      loaded.rules.reverse();
    },
    () => {
      loaded.rules[0].when = 'true';
    },
    () => {
      loaded.rules[0].then = 'deny';
    },
    () => {
      loaded.rules[0].condition = () => true;
    },
  ];
  for (const mutate of mutations) assert.throws(mutate, TypeError);
  assert.equal('ast' in loaded.rules[0].condition, false);
  assert.equal('check' in loaded.rules[0].condition, false);
  assert.equal(
    loaded.rules[0].condition({ tool: 'get_order', amount: { usd: 0 } }),
    false,
  );
});
