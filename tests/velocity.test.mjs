import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareEvent } from '../apps/firewall/src/audit/event.ts';
import { foldHistory } from '../apps/firewall/src/velocity/aggregate.ts';
import {
  encodeRuleReferences,
  decodeRuleReferences,
} from '../apps/firewall/src/velocity/references.ts';

const hour = 3_600_000;
const now = Date.UTC(2026, 9, 14);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = {
  now,
  merchantRef: '1'.repeat(64),
  customerRef: '2'.repeat(64),
  agentId: 'agent:' + '8'.repeat(64),
  keyId: '3'.repeat(64),
};
function metadata(n = 1, changes = {}) {
  return {
    v: 1,
    key_id: scope.keyId,
    merchant_ref: scope.merchantRef,
    customer_ref: scope.customerRef,
    request_id: uuid(n),
    binding_hash: '4'.repeat(64),
    usd_cents: 100,
    ...changes,
  };
}
function row(n = 1, changes = {}, meta = {}) {
  return {
    id: String(n),
    row_hash: '5'.repeat(64),
    ts_ms: now,
    agent_id: scope.agentId,
    tool: 'create_refund',
    args_hash: '6'.repeat(64),
    decision: 'allow',
    event_kind: 'tool_call',
    approval_id: null,
    upstream_status: null,
    upstream_result_ref: null,
    policy_version: '7'.repeat(64),
    matched_rules: ['rules.v1:0'],
    resolved_ctx: { velocity: metadata(n, meta) },
    ...changes,
  };
}
function lifecycle(id, kind, decision, changes = {}) {
  return row(id, {
    event_kind: kind,
    decision,
    approval_id: uuid(100),
    resolved_ctx: { velocity: metadata(1) },
    ...changes,
  });
}
const pending = () =>
  row(1, { decision: 'require_approval', approval_id: uuid(100) });

test('velocity windows use integer cents and exclude the exact lower boundary', () => {
  const history = [
    row(1, { ts_ms: now - 24 * hour }, { usd_cents: 100 }),
    row(2, { ts_ms: now - 24 * hour + 1 }, { usd_cents: 200 }),
    row(3, { ts_ms: now - hour }, { usd_cents: 300 }),
    row(4, { ts_ms: now - hour + 1 }, { usd_cents: 400 }),
    row(5, {}, { usd_cents: 500 }),
    row(6, { ts_ms: now - 168 * hour, agent_id: 'agent:' + '9'.repeat(64) }),
    row(7, {
      ts_ms: now - 168 * hour + 1,
      agent_id: 'agent:' + '9'.repeat(64),
    }),
  ];
  assert.deepEqual(foldHistory(history, scope).agg, {
    refund_usd_24h: 14,
    refund_count_1h: 2,
    customer_refund_count_7d: 6,
  });
});

test('merchant, agent and customer scopes differ without cross-tenant leakage', () => {
  const history = [
    row(1),
    row(2, { agent_id: 'agent:' + '9'.repeat(64) }),
    row(3, {}, { customer_ref: 'a'.repeat(64) }),
    row(4, {}, { merchant_ref: 'b'.repeat(64) }),
  ];
  assert.deepEqual(foldHistory(history, scope).agg, {
    refund_usd_24h: 2,
    refund_count_1h: 2,
    customer_refund_count_7d: 2,
  });
});

test('pending reservations remain charged past every accepted-event window', () => {
  const initial = { ...pending(), ts_ms: now - 200 * hour };
  assert.deepEqual(foldHistory([initial], scope).agg, {
    refund_usd_24h: 1,
    refund_count_1h: 1,
    customer_refund_count_7d: 1,
  });
});

test('approval lifecycle contributes once and confirmed execution starts its window', () => {
  const history = [
    { ...pending(), ts_ms: now - 200 * hour },
    lifecycle(2, 'approval_created', 'require_approval'),
    lifecycle(3, 'approval_decided', 'allow'),
  ];
  assert.equal(foldHistory(history, scope).agg.refund_count_1h, 1);
  history.push(
    lifecycle(4, 'approval_executed', 'allow', {
      upstream_status: 201,
      upstream_result_ref: uuid(200),
    }),
  );
  assert.equal(foldHistory(history, scope).agg.refund_usd_24h, 1);
  assert.equal(
    foldHistory(history, { ...scope, now: now + 24 * hour }).agg.refund_usd_24h,
    0,
  );
  assert.equal(
    foldHistory(history, { ...scope, now: now + 168 * hour }).agg
      .customer_refund_count_7d,
    0,
  );
});

test('explicit approval denial releases a reservation while uncertain execution does not', () => {
  assert.equal(
    foldHistory([pending(), lifecycle(2, 'approval_decided', 'deny')], scope)
      .agg.refund_count_1h,
    0,
  );
  const uncertain = [
    pending(),
    lifecycle(2, 'approval_decided', 'allow'),
    lifecycle(3, 'approval_executed', 'allow', { upstream_status: 503 }),
  ];
  assert.equal(
    foldHistory(uncertain, { ...scope, now: now + 500 * hour }).agg
      .refund_count_1h,
    1,
  );
});

for (const [name, history] of [
  ['unscoped legacy allowance', [row(1, { resolved_ctx: {} })]],
  ['raw rule name', [row(1, { matched_rules: ['limit'] })]],
  ['raw audit agent label', [row(1, { agent_id: 'support' })]],
  ['duplicate rule positions', [row(1, { matched_rules: ['rules.v1:0:0'] })]],
  [
    'noncanonical rule chunks',
    [row(1, { matched_rules: ['rules.v1:0', 'rules.v1:1'] })],
  ],
  [
    'changed lifecycle rule references',
    [
      pending(),
      lifecycle(2, 'approval_decided', 'deny', {
        matched_rules: ['rules.v1:1'],
      }),
    ],
  ],
  ['future timestamp', [row(1, { ts_ms: now + 1 })]],
  ['changed key', [row(1, {}, { key_id: 'a'.repeat(64) })]],
  ['unsafe cents', [row(1, {}, { usd_cents: Number.MAX_SAFE_INTEGER + 1 })]],
  ['orphan lifecycle', [lifecycle(1, 'approval_created', 'require_approval')]],
  [
    'wrong approval binding',
    [
      pending(),
      lifecycle(2, 'approval_decided', 'allow', { approval_id: uuid(101) }),
    ],
  ],
  [
    'changed customer binding',
    [
      pending(),
      lifecycle(2, 'approval_decided', 'allow', {
        resolved_ctx: {
          velocity: metadata(1, { customer_ref: 'a'.repeat(64) }),
        },
      }),
    ],
  ],
  [
    'duplicate initial reservation',
    [row(1), row(2, { resolved_ctx: { velocity: metadata(1) } })],
  ],
  [
    'duplicate terminal transition',
    [
      pending(),
      lifecycle(2, 'approval_decided', 'deny'),
      lifecycle(3, 'approval_decided', 'deny'),
    ],
  ],
]) {
  test(`velocity denies unavailable history: ${name}`, () => {
    assert.throws(() => foldHistory(history, scope), /velocity|history/i);
  });
}

test('legacy denial has no reservation and does not manufacture missing identity', () => {
  assert.equal(
    foldHistory([row(1, { decision: 'deny', resolved_ctx: {} })], scope).agg
      .refund_count_1h,
    0,
  );
});

test('unbound legacy approval denial cannot release a correlated pending reservation', () => {
  assert.equal(
    foldHistory(
      [
        pending(),
        lifecycle(2, 'approval_decided', 'deny', { resolved_ctx: {} }),
      ],
      scope,
    ).agg.refund_count_1h,
    1,
  );
});

test('velocity history budget fails closed rather than using partial history', () => {
  assert.throws(
    () =>
      foldHistory(
        Array.from({ length: 10_001 }, (_, i) => row(i + 1)),
        scope,
      ),
    /velocity|history/i,
  );
});

const auditEvent = {
  agentId: 'support',
  tool: 'create_refund',
  args: {},
  resolvedCtx: {},
  decision: 'allow',
  matchedRules: ['limit'],
  policyVersion: '7'.repeat(64),
  eventKind: 'tool_call',
  latencyMs: 0,
};
test('typed velocity metadata survives audit redaction while raw context cannot inject it', () => {
  const safe = metadata();
  const prepared = prepareEvent({
    ...auditEvent,
    velocity: safe,
    resolvedCtx: { email: 'private@example.invalid', velocity: metadata(2) },
  });
  assert.deepEqual(prepared.resolved_ctx, { velocity: safe });
  assert.deepEqual(
    prepareEvent({ ...auditEvent, resolvedCtx: { velocity: safe } })
      .resolved_ctx,
    {},
  );
});

for (const malformed of [
  { email: 'private@example.invalid' },
  { customer_ref: 'private@example.invalid' },
  { usd_cents: 0.1 },
  { v: 2 },
  { request_id: 'not-a-uuid' },
]) {
  test(`typed velocity metadata rejects malformed fields ${JSON.stringify(malformed)}`, () => {
    assert.throws(
      () => prepareEvent({ ...auditEvent, velocity: metadata(1, malformed) }),
      /velocity|audit/i,
    );
  });
}

test('audit rule references preserve arbitrary names and validate every generated label', () => {
  const rules = Array.from({ length: 129 }, (_, i) => ({
    id: `refund rule ${i} ` + 'long '.repeat(40),
  }));
  const names = rules.map((r) => r.id);
  const refs = encodeRuleReferences(rules, names);
  assert.deepEqual(decodeRuleReferences(rules, refs), names);
  assert.ok(refs.length <= 128);
  assert.deepEqual(
    prepareEvent({ ...auditEvent, matchedRules: refs }).matched_rules,
    refs,
  );
  for (const invalid of [
    ['rules.v1:00'],
    ['rules.v1:0:0'],
    ['rules.v1:1:0'],
    ['rules.v1:zzz'],
    ['rules.v1:!'],
    ['rules.v1:0', 'rules.v1:1'],
  ])
    assert.throws(
      () => decodeRuleReferences(rules, invalid),
      /rule references/i,
    );
});

test('audit reference chunks admit exact capacity and reject one-position overflow', () => {
  const rules = Array.from({ length: 5000 }, (_, i) => ({ id: String(i) }));
  let boundary = 0;
  // Independent packing oracle measures the literal on-disk label contract.
  let chunks = 1,
    width = 'rules.v1'.length;
  for (let i = 0; i < rules.length; i++) {
    const token = ':' + i.toString(36);
    if (width + token.length > 128) {
      chunks++;
      width = 'rules.v1'.length;
    }
    if (chunks > 128) break;
    width += token.length;
    boundary++;
  }
  assert.ok(boundary > 129 && boundary < rules.length);
  const names = rules.slice(0, boundary).map((r) => r.id);
  const refs = encodeRuleReferences(rules, names);
  assert.equal(refs.length, 128);
  assert.ok(refs.every((v) => v.length <= 128));
  assert.deepEqual(decodeRuleReferences(rules, refs), names);
  assert.throws(
    () => encodeRuleReferences(rules, [...names, rules[boundary].id]),
    /rule references/i,
  );
  assert.throws(
    () => encodeRuleReferences(rules, ['unknown']),
    /rule references/i,
  );
});
