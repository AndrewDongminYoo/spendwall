import type { HistoryRow } from '../velocity/aggregate.ts';
import { foldHistory } from '../velocity/aggregate.ts';

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
  for (const approval of options.approvals) {
    const request = calls.find(
      (r) => r.initial.approval_id === approval.approval_id,
    );
    if (!request?.created || request.initial.id !== approval.reservation_id)
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
  const agents = [...refs].map((ref) => {
    const own = recent.filter((r) => r.initial.agent_id === ref);
    const denied = own.filter((r) => r.initial.decision === 'deny').length;
    const reserved = foldHistory(rows, { ...scope, agentId: ref }).agg
      .refund_usd_24h;
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
    usd: 0,
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
    if (bucket) bucket.usd += r.metadata.usd_cents / 100;
  }
  const rules = new Map<
    string,
    { rule: string; policy_version: string; count: number }
  >();
  for (const r of recent.filter((r) => r.initial.decision === 'deny')) {
    for (const ref of r.initial.matched_rules.length
      ? r.initial.matched_rules
      : ['default-deny']) {
      const key = `${r.initial.policy_version}/${ref}`;
      const entry = rules.get(key) ?? {
        rule: ref,
        policy_version: r.initial.policy_version,
        count: 0,
      };
      entry.count++;
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
    hourly,
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
