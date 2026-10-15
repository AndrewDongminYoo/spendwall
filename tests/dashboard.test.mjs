import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { dashboardData } from '../apps/firewall/src/dashboard/data.ts';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';
import { encodeRuleReferences } from '../apps/firewall/src/velocity/references.ts';

const now = 1_800_000_000_000;
const merchantRef = 'a'.repeat(64),
  keyId = 'b'.repeat(64);
const agent = `agent:${'c'.repeat(64)}`;
function row(id, decision = 'allow', overrides = {}) {
  return {
    id: String(id),
    row_hash: 'd'.repeat(64),
    ts_ms: now - 1000,
    agent_id: agent,
    tool: 'create_refund',
    args_hash: 'e'.repeat(64),
    decision,
    event_kind: 'tool_call',
    approval_id: decision === 'require_approval' ? randomUUID() : null,
    upstream_status: null,
    upstream_result_ref: null,
    policy_version: 'f'.repeat(64),
    matched_rules: [],
    resolved_ctx: {
      velocity: {
        v: 1,
        key_id: keyId,
        merchant_ref: merchantRef,
        customer_ref: '1'.repeat(64),
        request_id: randomUUID(),
        binding_hash: '2'.repeat(64),
        usd_cents: 6000,
      },
    },
    ...overrides,
  };
}
const options = () => ({
  now,
  merchantRef,
  keyId,
  agents: [{ ref: agent, name: 'Support', budgetCents: 10000 }],
  approvals: [],
});

test('dashboard counts each compact rule position separately within its policy version', () => {
  const rules = Array.from({ length: 200 }, (_, i) => ({ id: `rule-${i}` }));
  const refs = encodeRuleReferences(
    rules,
    rules.map((r) => r.id),
  );
  assert.ok(refs.length > 1);
  const data = dashboardData(
    [
      row(1, 'deny', { matched_rules: refs }),
      row(2, 'deny', { matched_rules: ['rules.v1:0:1'] }),
      row(3, 'deny', {
        matched_rules: ['rules.v1:0'],
        policy_version: '4'.repeat(64),
      }),
    ],
    options(),
  );
  assert.equal(data.rules.length, 201);
  assert.equal(
    data.rules.find(
      (r) => r.rule === 'rules.v1:0' && r.policy_version === 'f'.repeat(64),
    ).count,
    2,
  );
  assert.equal(data.rules.find((r) => r.rule === 'rules.v1:1').count, 2);
  assert.equal(
    data.rules.find(
      (r) => r.rule === 'rules.v1:0' && r.policy_version === '4'.repeat(64),
    ).count,
    1,
  );
  assert.equal(
    data.rules.find((r) => r.rule === `rules.v1:${(199).toString(36)}`).count,
    1,
  );
});

test('dashboard does not infer the reason for a denial without rule references', () => {
  const data = dashboardData([row(1, 'deny')], options());
  assert.deepEqual(data.rules, [
    { rule: 'unreferenced-denial', policy_version: 'f'.repeat(64), count: 1 },
  ]);
});

test('dashboard totals fractional-dollar executions in cents for each hourly bucket', () => {
  const cfg = options();
  const rows = [10, 20].flatMap((cents, i) => {
    const initial = row(i * 4 + 1, 'require_approval');
    initial.resolved_ctx.velocity.usd_cents = cents;
    const execution = randomUUID();
    cfg.approvals.push({
      approval_id: initial.approval_id,
      reservation_id: initial.id,
      approval_state: 'approved',
      execution_state: 'succeeded',
      execution_id: execution,
      expires_ms: now + 1000,
    });
    return [
      initial,
      { ...initial, id: String(i * 4 + 2), event_kind: 'approval_created' },
      {
        ...initial,
        id: String(i * 4 + 3),
        event_kind: 'approval_decided',
        decision: 'allow',
      },
      {
        ...initial,
        id: String(i * 4 + 4),
        event_kind: 'approval_executed',
        decision: 'allow',
        upstream_status: 201,
        upstream_result_ref: execution,
      },
    ];
  });
  const value = dashboardData(rows, cfg);
  assert.equal(value.confirmed_usd, 0.3);
  assert.equal(value.hourly.find((r) => r.usd > 0).usd, 0.3);
});

test('dashboard counts original decisions, keeps pending reservation and never calls allow money paid', () => {
  const allowed = row(1);
  const pending = row(2, 'require_approval', { ts_ms: now - 25 * 3600000 });
  const created = { ...pending, id: '3', event_kind: 'approval_created' };
  const denied = row(4, 'deny');
  const cfg = options();
  cfg.approvals = [
    {
      approval_id: pending.approval_id,
      reservation_id: pending.id,
      approval_state: 'pending',
      execution_state: null,
      execution_id: null,
      expires_ms: now - 1000,
    },
  ];
  const value = dashboardData([allowed, pending, created, denied], cfg);
  assert.deepEqual(value.decisions, [
    { decision: 'allow', count: 1 },
    { decision: 'require_approval', count: 0 },
    { decision: 'deny', count: 1 },
  ]);
  assert.equal(value.agents[0].reserved_usd, 120);
  assert.equal(value.agents[0].utilization, 1.2);
  assert.equal(value.confirmed_usd, 0);
  assert.equal(value.audit.length, 3);
});

test('dashboard only counts successful bound approval executions as confirmed money-out', () => {
  const initial = row(1, 'require_approval');
  const created = { ...initial, id: '2', event_kind: 'approval_created' };
  const decided = {
    ...initial,
    id: '3',
    event_kind: 'approval_decided',
    decision: 'allow',
  };
  const executed = {
    ...initial,
    id: '4',
    event_kind: 'approval_executed',
    decision: 'allow',
    upstream_status: 201,
    upstream_result_ref: randomUUID(),
  };
  const cfg = options();
  cfg.approvals = [
    {
      approval_id: initial.approval_id,
      reservation_id: '1',
      approval_state: 'approved',
      execution_state: 'succeeded',
      execution_id: executed.upstream_result_ref,
      expires_ms: now + 10000,
    },
  ];
  const data = dashboardData([initial, created, decided, executed], cfg);
  assert.equal(data.confirmed_usd, 60);
  assert.equal(
    data.hourly.reduce((sum, r) => sum + r.usd, 0),
    60,
  );
  assert.equal(data.pending.length, 0);
  assert.equal(data.audit.length, 1);
  cfg.approvals[0].execution_id = randomUUID();
  assert.throws(
    () => dashboardData([initial, created, decided, executed], cfg),
    /unavailable/,
  );
  cfg.approvals[0].execution_id = executed.upstream_result_ref;
  cfg.approvals[0].execution_state = 'unknown';
  assert.throws(
    () => dashboardData([initial, created, decided, executed], cfg),
    /unavailable/,
  );
});

test('dashboard excludes foreign merchant data and expired/processed approvals', () => {
  const pending = row(1, 'require_approval');
  const created = { ...pending, id: '3', event_kind: 'approval_created' };
  const foreign = row(2, 'deny');
  foreign.resolved_ctx.velocity.merchant_ref = '3'.repeat(64);
  const cfg = options();
  cfg.approvals = [
    {
      approval_id: pending.approval_id,
      reservation_id: '1',
      approval_state: 'pending',
      execution_state: null,
      execution_id: null,
      expires_ms: now + 1,
    },
  ];
  assert.equal(
    dashboardData([pending, foreign, created], cfg).pending.length,
    1,
  );
  assert.equal(dashboardData([pending, foreign, created], cfg).audit.length, 1);
  cfg.approvals[0].expires_ms = now;
  assert.equal(
    dashboardData([pending, foreign, created], cfg).pending.length,
    0,
  );
  cfg.approvals[0].expires_ms = now + 1;
  cfg.approvals[0].approval_state = 'denied';
  assert.equal(
    dashboardData(
      [
        pending,
        foreign,
        created,
        {
          ...pending,
          id: '4',
          event_kind: 'approval_decided',
          decision: 'deny',
        },
      ],
      cfg,
    ).pending.length,
    0,
  );
});

test('dashboard reconciles stored approval states with their audit transitions', () => {
  const initial = row(1, 'require_approval');
  const created = { ...initial, id: '2', event_kind: 'approval_created' };
  const allow = {
    ...initial,
    id: '3',
    event_kind: 'approval_decided',
    decision: 'allow',
  };
  const deny = { ...allow, decision: 'deny' };
  const unconfirmed = {
    ...initial,
    id: '4',
    event_kind: 'approval_executed',
    decision: 'deny',
  };
  const execution = randomUUID();
  const cfg = options();
  const record = {
    approval_id: initial.approval_id,
    reservation_id: initial.id,
    approval_state: 'pending',
    execution_state: null,
    execution_id: null,
    expires_ms: now + 1000,
  };
  // A reservation can commit before the approval row is created.
  assert.equal(dashboardData([initial], cfg).agents[0].reserved_usd, 60);
  assert.throws(() => dashboardData([initial, created], cfg), /unavailable/);
  for (const state of ['pending', 'denied', 'expired', 'approved']) {
    record.approval_state = state;
    record.execution_state = state === 'approved' ? 'in_flight' : null;
    record.execution_id = state === 'approved' ? execution : null;
    cfg.approvals = [record];
    for (const [event, expected] of [
      [undefined, 'pending'],
      [deny, 'denied'],
      [allow, 'approved'],
    ]) {
      const rows = [initial, created, ...(event ? [event] : [])];
      const matches =
        state === expected || (state === 'expired' && expected === 'denied');
      if (matches) {
        const value = dashboardData(rows, cfg);
        assert.equal(
          value.agents[0].reserved_usd,
          state === 'denied' || state === 'expired' ? 0 : 60,
        );
      } else
        assert.throws(
          () => dashboardData(rows, cfg),
          /unavailable/,
          `${state} / ${expected}`,
        );
    }
  }
  for (const state of ['in_flight', 'unknown', 'failed']) {
    record.execution_state = state;
    const value = dashboardData([initial, created, allow, unconfirmed], cfg);
    assert.equal(value.confirmed_usd, 0);
    assert.equal(value.agents[0].reserved_usd, 60);
    if (state !== 'in_flight')
      assert.throws(
        () => dashboardData([initial, created, allow], cfg),
        /unavailable/,
      );
  }
});

test('dashboard rejects approval records without a matching creation event', () => {
  const initial = row(1, 'require_approval');
  const cfg = options();
  cfg.approvals = [
    {
      approval_id: initial.approval_id,
      reservation_id: '1',
      approval_state: 'pending',
      execution_state: null,
      execution_id: null,
      expires_ms: now + 1000,
    },
  ];
  assert.throws(() => dashboardData([initial], cfg), /unavailable/);
  cfg.approvals[0].approval_state = 'approved';
  cfg.approvals[0].execution_state = 'succeeded';
  assert.throws(
    () =>
      dashboardData(
        [
          initial,
          {
            ...initial,
            id: '2',
            event_kind: 'approval_decided',
            decision: 'allow',
          },
          {
            ...initial,
            id: '3',
            event_kind: 'approval_executed',
            decision: 'allow',
            upstream_status: 201,
            upstream_result_ref: randomUUID(),
          },
        ],
        cfg,
      ),
    /unavailable/,
  );
});

test('dashboard rejects duplicate approval identities across distinct reservations', () => {
  const first = row(1, 'require_approval');
  const second = row(2, 'require_approval', { approval_id: first.approval_id });
  assert.throws(() => dashboardData([first, second], options()), /unavailable/);
});

test('dashboard rejects the identity key reused as a differently cased token', async () => {
  let server;
  try {
    await assert.rejects(async () => {
      server = await startDashboardServer({
        pool: {
          connect: async () => {
            throw new Error('must not connect');
          },
        },
        merchantId: 'merchantA',
        identityKey: 'ab'.repeat(32),
        token: 'AB'.repeat(32),
      });
    }, /Invalid dashboard configuration/);
  } finally {
    await server?.close();
  }
});

test('dashboard fails on invalid or excessive history and discloses no raw metadata', () => {
  const bad = row(1);
  bad.resolved_ctx.velocity.usd_cents = -1;
  assert.throws(() => dashboardData([bad], options()));
  assert.throws(() =>
    dashboardData(
      Array.from({ length: 10001 }, (_, i) => row(i + 1)),
      options(),
    ),
  );
  const data = JSON.stringify(dashboardData([row(1)], options()));
  for (const secret of [
    'binding_hash',
    'customer_ref',
    'args_hash',
    'resolved_ctx',
    'key_id',
  ])
    assert.ok(!data.includes(secret));
});

test('dashboard projects the supported 100-agent and 10000-row limit within the refresh budget', () => {
  const cfg = options();
  cfg.agents = Array.from({ length: 100 }, (_, i) => ({
    ref: `agent:${i.toString(16).padStart(64, '0')}`,
    name: `Agent ${i}`,
  }));
  const rows = Array.from({ length: 10000 }, (_, i) =>
    row(i + 1, 'allow', { agent_id: cfg.agents[i % 100].ref }),
  );
  const started = performance.now();
  const data = dashboardData(rows, cfg);
  const elapsed = performance.now() - started;
  assert.equal(data.agents.length, 100);
  for (const agent of data.agents) {
    assert.equal(agent.reserved_usd, 6000);
    assert.equal(agent.attempts, 100);
  }
  assert.ok(
    elapsed < 2000,
    `Projection took ${elapsed.toFixed(0)}ms; two endpoint reads must fit the 10s refresh timeout`,
  );
});

test('dashboard rejects unauthorized requests before opening a database connection', async (t) => {
  let connects = 0;
  const server = await startDashboardServer({
    pool: {
      connect: async () => {
        connects++;
        throw new Error('private SQL secret');
      },
    },
    identityKey: '7'.repeat(64),
    merchantId: 'merchantA',
    token: '8'.repeat(64),
  });
  t.after(() => server.close());
  for (const headers of [
    {},
    { authorization: 'Bearer wrong' },
    { authorization: `Bearer ${'9'.repeat(64)}` },
  ])
    assert.equal((await fetch(server.url + '/stats', { headers })).status, 401);
  assert.equal(connects, 0);
  const response = await fetch(server.url + '/stats', {
    headers: { authorization: `Bearer ${'8'.repeat(64)}` },
  });
  assert.equal(response.status, 503);
  assert.equal(connects, 1);
  assert.deepEqual(await response.json(), {
    error: 'Dashboard data unavailable.',
  });
});
