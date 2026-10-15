import type { HistoryRow } from '../velocity/aggregate.ts';
import { foldHistory } from '../velocity/aggregate.ts';
import { parseRuleReferences } from '../velocity/references.ts';

export type DashboardAgent = {
  ref: string;
  name: string;
  budgetCents?: number;
};
export type ApprovalRow = {
  approval_id: string;
  reservation_id: string;
  approval_state: string;
  execution_state: string | null;
  execution_id: string | null;
  expires_ms: number;
};
type Options = {
  now: number;
  merchantRef: string;
  keyId: string;
  agents: readonly DashboardAgent[];
  approvals: readonly ApprovalRow[];
};
const day = 86_400_000;

export function dashboardData(rows: HistoryRow[], options: Options) {
  const scope = {
    now: options.now,
    merchantRef: options.merchantRef,
    keyId: options.keyId,
    customerRef: '0'.repeat(64),
    agentId: '',
  };
  const { requests } = foldHistory(rows, scope);
  const name = (ref: string) =>
    options.agents.find((a) => a.ref === ref)?.name ?? ref;
  const approvals = new Map(options.approvals.map((a) => [a.approval_id, a]));
  const calls = [...requests.values()];
  const approvalCalls = calls.filter((r) => r.initial.approval_id !== null);
  const byApproval = new Map(
    approvalCalls.map((r) => [r.initial.approval_id, r]),
  );
  if (
    byApproval.size !== approvalCalls.length ||
    approvals.size !== options.approvals.length
  )
    throw new Error('Dashboard unavailable.');
  for (const r of approvalCalls) {
    if ((r.created || r.decided) && !approvals.has(r.initial.approval_id!))
      throw new Error('Dashboard unavailable.');
  }
  const executions = new Map(
    rows
      .filter(
        (r) =>
          r.event_kind === 'approval_executed' &&
          (r.resolved_ctx.velocity as { merchant_ref?: unknown } | undefined)
            ?.merchant_ref === options.merchantRef,
      )
      .map((r) => [r.approval_id, r]),
  );
  for (const approval of options.approvals) {
    const request = byApproval.get(approval.approval_id);
    if (!request?.created || request.initial.id !== approval.reservation_id)
      throw new Error('Dashboard unavailable.');
    const stateMatches =
      approval.approval_state === 'pending'
        ? !request.decided &&
          !request.approved &&
          request.pending &&
          !request.released
        : approval.approval_state === 'denied' ||
            approval.approval_state === 'expired'
          ? request.decided &&
            !request.approved &&
            !request.pending &&
            request.released
          : approval.approval_state === 'approved' &&
            request.decided &&
            request.approved &&
            !request.released &&
            request.pending === (approval.execution_state !== 'succeeded');
    const execution = executions.get(approval.approval_id);
    if (
      !stateMatches ||
      (approval.approval_state !== 'approved'
        ? approval.execution_state !== null || approval.execution_id !== null
        : !approval.execution_id ||
          !['in_flight', 'unknown', 'failed', 'succeeded'].includes(
            approval.execution_state ?? '',
          ) ||
          (['unknown', 'failed'].includes(approval.execution_state!) &&
            execution?.decision !== 'deny'))
    )
      throw new Error('Dashboard unavailable.');
    if (
      approval.execution_state === 'succeeded' &&
      (!approval.execution_id ||
        execution?.upstream_result_ref !== approval.execution_id)
    )
      throw new Error('Dashboard unavailable.');
  }
  const recent = calls.filter((r) => r.initial.ts_ms > options.now - day);
  const decisions = (['allow', 'require_approval', 'deny'] as const).map(
    (decision) => ({
      decision,
      count: recent.filter((r) => r.initial.decision === decision).length,
    }),
  );
  const refs = new Set([
    ...options.agents.map((a) => a.ref),
    ...calls.map((r) => r.initial.agent_id),
  ]);
  if (refs.size > 100) throw new Error('Dashboard unavailable.');
  const reservations = new Map<string, bigint>();
  for (const r of calls) {
    if (
      r.released ||
      (!r.pending &&
        (r.acceptedAt === null || r.acceptedAt <= options.now - day))
    )
      continue;
    const cents =
      (reservations.get(r.initial.agent_id) ?? 0n) +
      BigInt(r.metadata.usd_cents);
    if (cents > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Dashboard unavailable.');
    reservations.set(r.initial.agent_id, cents);
  }
  const agents = [...refs].map((ref) => {
    const own = recent.filter((r) => r.initial.agent_id === ref);
    const denied = own.filter((r) => r.initial.decision === 'deny').length;
    const reserved = Number(reservations.get(ref) ?? 0n) / 100;
    const budget = options.agents.find((a) => a.ref === ref)?.budgetCents;
    return {
      agent: name(ref),
      reserved_usd: reserved,
      budget_usd: budget === undefined ? null : budget / 100,
      utilization: budget === undefined ? null : (reserved * 100) / budget,
      attempts: own.length,
      denied,
      denial_rate: own.length === 0 ? 0 : denied / own.length,
    };
  });
  const pending = calls.flatMap((r) => {
    const a = r.initial.approval_id
      ? approvals.get(r.initial.approval_id)
      : undefined;
    return a &&
      a.reservation_id === r.initial.id &&
      a.approval_state === 'pending' &&
      a.expires_ms > options.now
      ? [
          {
            approval_id: a.approval_id,
            agent: name(r.initial.agent_id),
            usd: r.metadata.usd_cents / 100,
            expires_at: new Date(a.expires_ms).toISOString(),
          },
        ]
      : [];
  });
  const hourly = Array.from({ length: 25 }, (_, i) => ({
    hour: new Date(
      Math.floor(options.now / 3_600_000) * 3_600_000 - (24 - i) * 3_600_000,
    ).toISOString(),
    cents: 0,
  }));
  let confirmedCents = 0;
  for (const r of calls) {
    const a = r.initial.approval_id
      ? approvals.get(r.initial.approval_id)
      : undefined;
    if (
      !a ||
      a.reservation_id !== r.initial.id ||
      a.approval_state !== 'approved' ||
      a.execution_state !== 'succeeded' ||
      r.pending ||
      r.acceptedAt === null ||
      r.acceptedAt <= options.now - day
    )
      continue;
    confirmedCents += r.metadata.usd_cents;
    if (!Number.isSafeInteger(confirmedCents))
      throw new Error('Dashboard unavailable.');
    const hour = new Date(
      Math.floor(r.acceptedAt / 3_600_000) * 3_600_000,
    ).toISOString();
    const bucket = hourly.find((b) => b.hour === hour);
    if (bucket) bucket.cents += r.metadata.usd_cents;
  }
  const rules = new Map<
    string,
    { rule: string; policy_version: string; count: number }
  >();
  const ruleChunks = new Map<
    string,
    { policyVersion: string; reference: string | null; count: number }
  >();
  for (const r of recent) {
    if (r.initial.decision !== 'deny') continue;
    for (const reference of r.initial.matched_rules.length
      ? r.initial.matched_rules
      : [null]) {
      const key = JSON.stringify([r.initial.policy_version, reference]);
      const entry = ruleChunks.get(key) ?? {
        policyVersion: r.initial.policy_version,
        reference,
        count: 0,
      };
      entry.count++;
      ruleChunks.set(key, entry);
    }
  }
  for (const set of ruleChunks.values()) {
    const refs = parseRuleReferences(set.reference ? [set.reference] : []).map(
      (position) => `rules.v1:${position.toString(36)}`,
    );
    for (const ref of refs.length ? refs : ['unreferenced-denial']) {
      const key = `${set.policyVersion}/${ref}`;
      const entry = rules.get(key) ?? {
        rule: ref,
        policy_version: set.policyVersion,
        count: 0,
      };
      entry.count += set.count;
      rules.set(key, entry);
    }
  }
  return {
    as_of: new Date(options.now).toISOString(),
    coverage:
      'Tracked refunds only; last 24 hours unless noted. Reservations include older pending requests.',
    confirmed_usd: confirmedCents / 100,
    decisions,
    agents,
    hourly: hourly.map(({ hour, cents }) => ({ hour, usd: cents / 100 })),
    rules: [...rules.values()],
    pending,
    audit: calls
      .map((r) => ({
        id: r.initial.id,
        at: new Date(r.initial.ts_ms).toISOString(),
        agent: name(r.initial.agent_id),
        decision: r.initial.decision,
        usd: r.metadata.usd_cents / 100,
        policy_version: r.initial.policy_version,
        rules: [...r.initial.matched_rules],
      }))
      .reverse(),
  };
}
export type DashboardData = ReturnType<typeof dashboardData>;
