import type { HistoryRow } from '../velocity/aggregate.ts';
import { foldHistory } from '../velocity/aggregate.ts';
import { dashboardData } from './data.ts';
import type { AuditResult } from './query-contract.ts';
import { auditFields } from './query-contract.ts';

const hour = 3_600_000,
  day = 24 * hour;
const column = (id: string) => auditFields.find((field) => field.id === id)!;

export function auditQuery(
  intent: string,
  rows: HistoryRow[],
  options: Parameters<typeof dashboardData>[1] & { supportRef?: string },
): AuditResult {
  if (!['weekly_refunds', 'denial_reasons', 'support_budget'].includes(intent))
    throw new Error('Unsupported query.');
  // Keep the same lifecycle, approval binding and amount validation as /stats.
  const data = dashboardData(rows, options);
  const base = { as_of: data.as_of };
  if (intent === 'weekly_refunds') {
    const start = new Date(options.now);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    return {
      ...base,
      intent,
      title: 'Refund attempts above $100 · this week',
      note: `Tracked original attempts from ${start.toISOString()} through ${data.as_of}. USD > 100; attempts are not proof of payment.`,
      columns: [
        column('id'),
        column('at'),
        column('agent'),
        column('decision'),
        column('usd'),
      ],
      rows: data.audit
        .filter((r) => Date.parse(r.at) >= start.getTime() && r.usd > 100)
        .map(({ id, at, agent, decision, usd }) => ({
          id,
          at,
          agent,
          decision,
          usd,
        })),
    };
  }
  if (intent === 'denial_reasons')
    return {
      ...base,
      intent,
      title: 'Blocked attempts by rule · last 24 hours',
      note: 'Canonical rule positions within each policy version, not human-readable reasons. An attempt can match multiple rules; unreferenced denials are kept separate.',
      columns: [column('rule'), column('policy_version'), column('count')],
      rows: data.rules,
    };
  const candidates = options.agents.filter((a) =>
    options.supportRef
      ? a.ref === options.supportRef
      : a.name.toLowerCase().replace(/[ -]/g, '') === 'supportbot',
  );
  const support = candidates.length === 1 ? candidates[0] : undefined;
  if (!support?.budgetCents) throw new Error('Support budget unavailable.');
  const { requests } = foldHistory(rows, {
    ...options,
    customerRef: '0'.repeat(64),
    agentId: support.ref,
  });
  // Every reservation contributes one interval; unknown executions stay reserved.
  const ends = new Map<string, number>();
  const last = new Map<string, number>();
  for (const row of rows) {
    if (row.agent_id !== support.ref || row.tool !== 'create_refund') continue;
    const metadata = row.resolved_ctx.velocity as
      { request_id?: string } | undefined;
    const id = metadata?.request_id;
    if (!id || !requests.has(id)) continue;
    if (row.ts_ms < (last.get(id) ?? 0)) throw new Error('Trend unavailable.');
    last.set(id, row.ts_ms);
    if (row.event_kind === 'approval_decided' && row.decision === 'deny')
      ends.set(id, row.ts_ms);
  }
  const events: { at: number; cents: bigint }[] = [];
  for (const [id, request] of requests) {
    if (
      request.initial.agent_id !== support.ref ||
      request.initial.decision === 'deny'
    )
      continue;
    const cents = BigInt(request.metadata.usd_cents);
    events.push({ at: request.initial.ts_ms, cents });
    const end =
      ends.get(id) ??
      (request.acceptedAt === null ? undefined : request.acceptedAt + day);
    if (end !== undefined) events.push({ at: end, cents: -cents });
  }
  events.sort((a, b) => a.at - b.at);
  let cursor = 0,
    balance = 0n;
  const trend = Array.from({ length: 25 }, (_, i) => {
    const at = options.now - (24 - i) * hour;
    while (cursor < events.length && events[cursor]!.at <= at)
      balance += events[cursor++]!.cents;
    if (balance < 0n || balance > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Trend unavailable.');
    return {
      hour: new Date(at).toISOString(),
      reserved_usd: Number(balance) / 100,
      budget_usd: support.budgetCents! / 100,
      utilization: Number(balance) / support.budgetCents!,
    };
  });
  return {
    ...base,
    intent: 'support_budget',
    title: `${support.name} reservation trend · USD`,
    note: 'Hourly samples over 24 hours. Older pending approvals remain reserved; denied approvals release funds. Current monitoring budget is a reference, not a historical policy limit or confirmed payment.',
    columns: [
      column('hour'),
      column('reserved_usd'),
      column('budget_usd'),
      column('utilization'),
    ],
    rows: trend,
  };
}
