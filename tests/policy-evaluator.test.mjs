import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluatePolicy,
  loadPolicy,
  normalizeAmount,
} from '../packages/policy/src/index.ts';

const allow = { id: 'allow', when: 'true', then: 'allow' };
const approval = { id: 'review', when: 'true', then: 'require_approval' };
const deny = { id: 'block', when: 'true', then: 'deny' };

function policy(
  rules = [allow],
  tools = { allow: ['create_refund'], deny: [] },
) {
  return loadPolicy(
    JSON.stringify({ agents: { support: { tools } }, rules, default: 'deny' }),
  );
}

function context(overrides = {}) {
  return {
    tool: 'create_refund',
    args: { capture_id: 'capture', items: [1, 2, 3] },
    amount: { value: '99.00', currency: 'USD' },
    agent: { id: 'support' },
    customer: { id: 'customer', vip: true },
    merchant: { id: 'merchant' },
    agg: { refund_usd_24h: 100, refund_count_1h: 2 },
    ...overrides,
  };
}

const small = { id: 'small', when: 'amount.usd <= 100', then: 'allow' };
const large = {
  id: 'large',
  when: 'amount.usd > 100',
  then: 'require_approval',
};

const cases = [
  { name: 'explicit allow', decision: 'allow', matches: ['allow'] },
  {
    name: 'explicit approval',
    rules: [approval],
    decision: 'require_approval',
    matches: ['review'],
  },
  {
    name: 'explicit deny',
    rules: [deny],
    decision: 'deny',
    matches: ['block'],
  },
  { name: 'no rules', rules: [], decision: 'deny' },
  {
    name: 'no matching rules',
    rules: [{ ...allow, when: 'false' }],
    decision: 'deny',
  },
  {
    name: 'approval wins over allow',
    rules: [allow, approval],
    decision: 'require_approval',
    matches: ['allow', 'review'],
  },
  {
    name: 'allow does not override approval',
    rules: [approval, allow],
    decision: 'require_approval',
    matches: ['review', 'allow'],
  },
  {
    name: 'deny wins over both',
    rules: [allow, approval, deny],
    decision: 'deny',
    matches: ['allow', 'review', 'block'],
  },
  {
    name: 'later allow does not override deny',
    rules: [deny, approval, allow],
    decision: 'deny',
    matches: ['block', 'review', 'allow'],
  },
  {
    name: 'only true rules are matched',
    rules: [{ ...deny, when: 'false' }, allow],
    decision: 'allow',
    matches: ['allow'],
  },
  {
    name: 'unknown agent',
    input: () => context({ agent: { id: 'other' } }),
    decision: 'deny',
  },
  {
    name: 'empty allow list',
    tools: { allow: [], deny: [] },
    decision: 'deny',
  },
  {
    name: 'tool absent from allow list',
    input: () => context({ tool: 'create_payout' }),
    decision: 'deny',
  },
  {
    name: 'deny list wins over allow list',
    tools: { allow: ['create_refund'], deny: ['create_refund'] },
    decision: 'deny',
  },
  {
    name: 'wildcard does not grant access',
    tools: { allow: ['*'], deny: [] },
    decision: 'deny',
  },
  {
    name: 'tool names are case sensitive',
    input: () => context({ tool: 'CREATE_REFUND' }),
    decision: 'deny',
  },
  {
    name: 'lower monetary boundary',
    rules: [small, large],
    input: () => context({ amount: { value: '99.99', currency: 'USD' } }),
    decision: 'allow',
    matches: ['small'],
  },
  {
    name: 'exact monetary boundary',
    rules: [small, large],
    input: () => context({ amount: { value: '100.00', currency: 'USD' } }),
    decision: 'allow',
    matches: ['small'],
  },
  {
    name: 'upper monetary boundary',
    rules: [small, large],
    input: () => context({ amount: { value: '100.01', currency: 'USD' } }),
    decision: 'require_approval',
    matches: ['large'],
  },
  {
    name: 'zero amount',
    rules: [small],
    input: () => context({ amount: { value: '0', currency: 'USD' } }),
    decision: 'allow',
    matches: ['small'],
  },
  {
    name: 'EUR crosses the ceiling after rounding',
    rules: [small, large],
    input: () => context({ amount: { value: '90.91', currency: 'EUR' } }),
    decision: 'require_approval',
    matches: ['large'],
  },
  {
    name: 'KRW exact converted boundary',
    rules: [small, large],
    input: () => context({ amount: { value: '140000', currency: 'KRW' } }),
    decision: 'allow',
    matches: ['small'],
  },
  {
    name: 'KRW fractional cent rounds upward',
    rules: [small, large],
    input: () => context({ amount: { value: '140001', currency: 'KRW' } }),
    decision: 'require_approval',
    matches: ['large'],
  },
  {
    name: 'unsupported currency',
    input: () => context({ amount: { value: '1', currency: 'ZZZ' } }),
    decision: 'deny',
  },
  {
    name: 'caller cannot inject USD',
    input: () =>
      context({ amount: { value: '1000', currency: 'USD', usd: 1 } }),
    decision: 'deny',
  },
  {
    name: 'negative amount',
    input: () => context({ amount: { value: '-1', currency: 'USD' } }),
    decision: 'deny',
  },
  {
    name: 'numeric amount loses source precision',
    input: () => context({ amount: { value: 1, currency: 'USD' } }),
    decision: 'deny',
  },
  {
    name: 'attempted missing nested field',
    rules: [{ ...allow, when: 'customer.unknown == true' }],
    decision: 'deny',
  },
  {
    name: 'unknown root variable',
    rules: [{ ...allow, when: 'untrusted == true' }],
    decision: 'deny',
  },
  {
    name: 'division by zero',
    rules: [{ ...allow, when: '1 / 0 > 0' }],
    decision: 'deny',
  },
  {
    name: 'logical OR cannot mask an error',
    rules: [{ ...allow, when: '(1 / 0 > 0) || true' }],
    decision: 'deny',
  },
  {
    name: 'logical OR cannot mask a missing field',
    rules: [{ ...allow, when: 'customer.missing == true || true' }],
    decision: 'deny',
  },
  {
    name: 'logical AND cannot hide an error from later rules',
    rules: [{ ...deny, when: '(1 / 0 > 0) && false' }, allow],
    decision: 'deny',
    matches: ['allow'],
  },
  {
    name: 'unreachable error is not evaluated',
    rules: [{ ...allow, when: 'true || (1 / 0 > 0)' }],
    decision: 'allow',
    matches: ['allow'],
  },
  {
    name: 'unreachable field access is not evaluated',
    rules: [{ ...deny, when: 'false && customer.missing' }, allow],
    decision: 'allow',
    matches: ['allow'],
  },
  {
    name: 'presence check may test an absent optional field',
    rules: [{ ...allow, when: '!has(customer.optional)' }],
    decision: 'allow',
    matches: ['allow'],
  },
  {
    name: 'has still requires the containing object',
    rules: [{ ...allow, when: 'has(customer.absent.vip) || true' }],
    decision: 'deny',
  },
  {
    name: 'quantifier cannot mask an error',
    rules: [{ ...allow, when: '[0, 1].exists(x, 1 / x > 0)' }],
    decision: 'deny',
  },
  {
    name: 'quantifier preserves early success',
    rules: [{ ...allow, when: '[1, 0].exists(x, 1 / x > 0)' }],
    decision: 'allow',
    matches: ['allow'],
  },
  {
    name: 'all cannot hide an error from later rules',
    rules: [{ ...deny, when: '[0, 1].all(x, 1 / x < 0)' }, allow],
    decision: 'deny',
    matches: ['allow'],
  },
  {
    name: 'nonfinite arithmetic cannot match',
    rules: [{ ...allow, when: '1.0 / 0.0 > 0.0' }],
    decision: 'deny',
  },
  {
    name: 'numeric result is not boolean',
    rules: [{ ...deny, when: '1' }, allow],
    decision: 'deny',
    matches: ['allow'],
  },
  {
    name: 'string result is not boolean',
    rules: [{ ...deny, when: '"true"' }, allow],
    decision: 'deny',
    matches: ['allow'],
  },
  {
    name: 'null result is not boolean',
    rules: [{ ...deny, when: 'null' }, allow],
    decision: 'deny',
    matches: ['allow'],
  },
  {
    name: 'list result is not boolean',
    rules: [{ ...deny, when: '[true]' }, allow],
    decision: 'deny',
    matches: ['allow'],
  },
  {
    name: 'all context namespaces reach CEL',
    rules: [
      {
        ...allow,
        when: 'tool == "create_refund" && args.capture_id == "capture" && amount.usd == 99 && agent.id == "support" && customer.vip && merchant.id == "merchant" && agg.refund_count_1h == 2 && args.items.all(x, x > 0)',
      },
    ],
    decision: 'allow',
    matches: ['allow'],
  },
];

for (const { name, rules, tools, input, decision, matches = [] } of cases) {
  test(`policy decision: ${name}`, () => {
    const loaded = policy(rules, tools);
    assert.deepEqual(evaluatePolicy(loaded, input ? input() : context()), {
      decision,
      matchedRules: matches,
      policyVersion: loaded.policyVersion,
    });
  });
}

for (const field of [
  'tool',
  'args',
  'amount',
  'agent',
  'customer',
  'merchant',
  'agg',
]) {
  test(`missing required ${field} denies even for a true allow rule`, () => {
    const input = context();
    delete input[field];
    assert.equal(evaluatePolicy(policy(), input).decision, 'deny');
  });
}

for (const field of ['agent', 'customer', 'merchant']) {
  for (const identity of [{}, { id: '' }, { id: ' ' }, { id: 1 }]) {
    test(`invalid ${field} identity ${JSON.stringify(identity)} denies`, () => {
      assert.equal(
        evaluatePolicy(policy(), context({ [field]: identity })).decision,
        'deny',
      );
    });
  }
}

for (const [value, currency, usd] of [
  ['0', 'USD', 0],
  ['0.01', 'USD', 0.01],
  ['12.3', 'USD', 12.3],
  ['100', 'USD', 100],
  ['90.90', 'EUR', 99.99],
  ['90.91', 'EUR', 100.01],
  ['0.01', 'EUR', 0.02],
  ['1', 'KRW', 0.01],
  ['14', 'KRW', 0.01],
  ['15', 'KRW', 0.02],
  ['140000', 'KRW', 100],
  ['140001', 'KRW', 100.01],
  ['10000000.00', 'USD', 10000000],
]) {
  test(`normalizes ${currency} ${value} to USD ${usd}`, () => {
    const normalized = normalizeAmount({ value, currency });
    assert.deepEqual(normalized, { value, currency, usd });
    assert.ok(Object.isFrozen(normalized));
  });
}

for (const input of [
  null,
  {},
  { value: '1' },
  { currency: 'USD' },
  { value: '1', currency: 'usd' },
  { value: '1', currency: 'GBP' },
  { value: '-1', currency: 'USD' },
  { value: '+1', currency: 'USD' },
  { value: '1e2', currency: 'USD' },
  { value: '01', currency: 'USD' },
  { value: ' 1', currency: 'USD' },
  { value: '1\n', currency: 'USD' },
  { value: '1\r\n', currency: 'USD' },
  { value: '.1', currency: 'USD' },
  { value: '1.', currency: 'USD' },
  { value: '0.001', currency: 'USD' },
  { value: '1.1', currency: 'KRW' },
  { value: 1, currency: 'USD' },
  { value: 'NaN', currency: 'USD' },
  { value: 'Infinity', currency: 'USD' },
  { value: '10000000.01', currency: 'USD' },
  { value: '999999999999999999999999999999999999', currency: 'USD' },
  { value: '1', currency: 'USD', usd: 0 },
]) {
  test(`rejects invalid original amount ${JSON.stringify(input)}`, () => {
    assert.throws(() => normalizeAmount(input), /Invalid amount/);
  });
}

test('tool filtering runs before any condition', () => {
  const loaded = policy();
  let calls = 0;
  const instrumented = {
    ...loaded,
    rules: [
      {
        ...loaded.rules[0],
        condition: () => {
          calls++;
          throw new Error('must not run');
        },
      },
    ],
  };
  const result = evaluatePolicy(
    instrumented,
    context({ tool: 'create_payout' }),
  );
  assert.equal(result.decision, 'deny');
  assert.equal(calls, 0);
});

test('preserves normal prepared-condition behavior and adds opt-in fail-closed evaluation', () => {
  const loaded = policy([{ ...allow, when: '(1 / 0 > 0) || true' }]);
  assert.equal(loaded.rules[0].condition(context()), true);
  assert.throws(() =>
    loaded.rules[0].condition(context(), { failClosed: true }),
  );
  assert.equal(loaded.rules[0].condition(context()), true);
});

test('does not let malformed source escape the private CEL wrapper', () => {
  assert.throws(
    () => policy([{ ...allow, when: 'true) || spendwall_observe(true' }]),
    /\$\.rules\[0\]\.when/,
  );
});

for (const when of [
  'spendwall_observe(true).value',
  'true || spendwall_observe(true).value',
  '[spendwall_observe(true).value][0]',
  'args.items.all(x, spendwall_observe(x > 0).value)',
]) {
  test(`rejects policy calls to the private observer: ${when}`, () => {
    assert.throws(() => policy([{ ...allow, when }]), /\$\.rules\[0\]\.when/);
  });
}

test('permits the private observer name as ordinary string data', () => {
  const loaded = policy([
    { ...allow, when: '"spendwall_observe" == "spendwall_observe"' },
  ]);
  assert.equal(evaluatePolicy(loaded, context()).decision, 'allow');
});

test('does not expose observer state or change source policy hashes', () => {
  const loaded = policy();
  const before = JSON.stringify(loaded);
  evaluatePolicy(loaded, context());
  evaluatePolicy(loaded, context({ customer: { id: 'customer', vip: false } }));
  assert.equal(JSON.stringify(loaded), before);
  assert.equal(loaded.policyVersion, policy().policyVersion);
  assert.deepEqual(Object.keys(loaded.rules[0].condition), []);
});

test('reuses one loaded policy across mixed inputs without retaining an error', () => {
  const loaded = policy([{ ...allow, when: 'customer.vip || true' }]);
  for (let i = 0; i < 3; i++) {
    assert.equal(
      evaluatePolicy(loaded, context({ customer: { id: 'customer' } }))
        .decision,
      'deny',
    );
    assert.equal(
      evaluatePolicy(
        loaded,
        context({ customer: { id: 'customer', vip: false } }),
      ).decision,
      'allow',
    );
  }
});

for (const vip of ['invalid', 0, null, {}]) {
  test(`logical OR cannot mask nonboolean operand ${JSON.stringify(vip)}`, () => {
    const loaded = policy([{ ...allow, when: 'customer.vip || true' }]);
    const input = context({ customer: { id: 'customer', vip } });
    assert.equal(loaded.rules[0].condition(input), true);
    assert.equal(evaluatePolicy(loaded, input).decision, 'deny');
  });
}

test('logical AND cannot hide a nonboolean operand from later rules', () => {
  const loaded = policy([{ ...deny, when: 'customer.vip && false' }, allow]);
  const input = context({ customer: { id: 'customer', vip: 'invalid' } });
  assert.equal(evaluatePolicy(loaded, input).decision, 'deny');
});

test('bounds nested quantifier work and resets the operation budget per call', () => {
  const loaded = policy([
    {
      ...allow,
      when: 'args.items.all(x, args.items.all(y, x == y || x != y))',
    },
  ]);
  assert.equal(
    evaluatePolicy(
      loaded,
      context({ args: { items: Array.from({ length: 100 }, (_, i) => i) } }),
    ).decision,
    'deny',
  );
  assert.equal(
    evaluatePolicy(loaded, context({ args: { items: [1] } })).decision,
    'allow',
  );
});

test('snapshots caller data and freezes decision evidence', () => {
  const input = context();
  const before = structuredClone(input);
  const result = evaluatePolicy(policy(), input);
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.matchedRules));
  assert.throws(() => result.matchedRules.push('forged'));
  assert.equal(Object.hasOwn(input.amount, 'usd'), false);
});

for (const [name, mutate] of [
  [
    'undefined',
    (input) => {
      input.args.bad = undefined;
    },
  ],
  [
    'nonfinite number',
    (input) => {
      input.agg.total = Infinity;
    },
  ],
  [
    'function',
    (input) => {
      input.args.bad = () => true;
    },
  ],
  [
    'cycle',
    (input) => {
      input.args.self = input.args;
    },
  ],
  [
    'date',
    (input) => {
      input.args.date = new Date(0);
    },
  ],
  [
    'inherited identity',
    (input) => {
      input.agent = Object.create({ id: 'support' });
    },
  ],
  [
    'prototype-sensitive own key',
    (input) => {
      input.args = JSON.parse('{"__proto__":{"allowed":true}}');
    },
  ],
  [
    'sparse array',
    (input) => {
      input.args.items = new Array(2);
    },
  ],
  [
    'too many values',
    (input) => {
      input.args.items = Array(4096).fill(1);
    },
  ],
  [
    'too much text',
    (input) => {
      input.args.text = 'x'.repeat(65537);
    },
  ],
  [
    'too much depth',
    (input) => {
      for (let i = 0; i < 20; i++) input.args = { nested: input.args };
    },
  ],
]) {
  test(`rejects non-JSON or excessive context: ${name}`, () => {
    const input = context();
    mutate(input);
    assert.equal(evaluatePolicy(policy(), input).decision, 'deny');
  });
}

test('rejects accessors without invoking them', () => {
  const input = context();
  let calls = 0;
  Object.defineProperty(input.customer, 'vip', {
    enumerable: true,
    get() {
      calls++;
      return true;
    },
  });
  assert.equal(evaluatePolicy(policy(), input).decision, 'deny');
  assert.equal(calls, 0);
});

test('accepts plain null-prototype JSON objects', () => {
  const input = context();
  input.args = Object.assign(Object.create(null), { capture_id: 'capture' });
  assert.equal(evaluatePolicy(policy(), input).decision, 'allow');
});
