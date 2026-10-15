import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { auditQuery } from '../apps/firewall/src/dashboard/query.ts';

const hour = 3600000,
  day = 24 * hour;
const now = Date.parse('2026-10-16T12:30:00Z');
const monday = Date.parse('2026-10-12T00:00:00Z');
const agent = `agent:${'c'.repeat(64)}`;
const options = () => ({
  now,
  merchantRef: 'a'.repeat(64),
  keyId: 'b'.repeat(64),
  agents: [{ ref: agent, name: 'Support bot', budgetCents: 20000 }],
  approvals: [],
});
function row(id, cents = 10001, at = now, decision = 'allow') {
  return {
    id: String(id),
    row_hash: 'd'.repeat(64),
    ts_ms: at,
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
        key_id: 'b'.repeat(64),
        merchant_ref: 'a'.repeat(64),
        customer_ref: '1'.repeat(64),
        request_id: randomUUID(),
        binding_hash: '2'.repeat(64),
        usd_cents: cents,
      },
    },
  };
}

test('weekly attempts use Monday UTC inclusively and strictly more than USD 100', () => {
  const rows = [
    row(1, 10001, monday - 1),
    row(2, 10000, monday),
    row(3, 10001, monday),
    row(4, 20000, now, 'deny'),
  ];
  const result = auditQuery('weekly_refunds', rows, options());
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ['4', '3'],
  );
  assert.deepEqual(
    result.rows.map((r) => r.usd),
    [200, 100.01],
  );
  assert.deepEqual(auditQuery('weekly_refunds', rows, options()), result);
});
test('denial groups preserve policy versions and do not interpret references as rule names', () => {
  const rows = [
    row(1, 500, now, 'deny'),
    row(2, 500, now, 'deny'),
    row(3, 500, now - day, 'deny'),
  ];
  rows[0].matched_rules = ['rules.v1:0:1'];
  rows[1].matched_rules = ['rules.v1:0'];
  rows[1].policy_version = '9'.repeat(64);
  const result = auditQuery('denial_reasons', rows, options());
  assert.equal(result.rows.length, 3);
  assert.deepEqual(
    result.rows.map((r) => r.count),
    [1, 1, 1],
  );
  assert.equal(new Set(result.rows.map((r) => r.policy_version)).size, 2);
});
test('reservation trend includes old pending balances, releases and rolling-window expiry', () => {
  const pending = row(1, 6000, now - 2 * day, 'require_approval');
  const released = row(2, 3500, now - 2 * day, 'require_approval');
  const created = { ...released, id: '3', event_kind: 'approval_created' };
  const release = {
    ...released,
    id: '4',
    event_kind: 'approval_decided',
    decision: 'deny',
    ts_ms: now - 2 * hour,
  };
  const allowed = row(5, 2500, now - 25 * hour);
  const result = auditQuery(
    'support_budget',
    [pending, released, created, release, allowed],
    {
      ...options(),
      approvals: [
        {
          approval_id: released.approval_id,
          reservation_id: '2',
          approval_state: 'denied',
          execution_state: null,
          execution_id: null,
          expires_ms: now,
        },
      ],
    },
  );
  assert.equal(result.rows.length, 25);
  assert.equal(result.rows[0].reserved_usd, 120);
  assert.equal(result.rows[22].reserved_usd, 85);
  assert.equal(result.rows[23].reserved_usd, 60);
  assert.equal(result.rows[24].utilization, 0.3);
});
test('missing support budget and unsupported intent never return fabricated results', () => {
  assert.throws(
    () => auditQuery('support_budget', [], { ...options(), agents: [] }),
    /unavailable/i,
  );
  assert.throws(() => auditQuery('sql', [], options()), /unsupported/i);
});

test('successful approval retains pending history then expires 24 hours after execution', () => {
  const pending = row(1, 8000, now - 3 * day, 'require_approval');
  const created = { ...pending, id: '2', event_kind: 'approval_created' };
  const decided = {
    ...pending,
    id: '3',
    event_kind: 'approval_decided',
    decision: 'allow',
    ts_ms: now - 26 * hour,
  };
  const executionId = randomUUID();
  const executed = {
    ...decided,
    id: '4',
    event_kind: 'approval_executed',
    ts_ms: now - 25 * hour,
    upstream_status: 201,
    upstream_result_ref: executionId,
  };
  const result = auditQuery(
    'support_budget',
    [pending, created, decided, executed],
    {
      ...options(),
      approvals: [
        {
          approval_id: pending.approval_id,
          reservation_id: '1',
          approval_state: 'approved',
          execution_state: 'succeeded',
          execution_id: executionId,
          expires_ms: now,
        },
      ],
    },
  );
  assert.equal(result.rows[0].reserved_usd, 80);
  assert.equal(result.rows[22].reserved_usd, 80);
  assert.equal(result.rows[23].reserved_usd, 0);
  assert.equal(result.rows[24].reserved_usd, 0);
});
test('budget lookup refuses ambiguous names and honors an explicit configured support reference', () => {
  const duplicate = {
    ref: `agent:${'8'.repeat(64)}`,
    name: 'support-bot',
    budgetCents: 10000,
  };
  const config = { ...options(), agents: [...options().agents, duplicate] };
  assert.throws(() => auditQuery('support_budget', [], config), /unavailable/i);
  const result = auditQuery('support_budget', [], {
    ...config,
    supportRef: duplicate.ref,
  });
  assert.equal(result.rows[0].budget_usd, 100);
});
