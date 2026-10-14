import { parseVelocityMetadata } from '../audit/velocity.ts';
import type { VelocityMetadata } from '../audit/velocity.ts';
import type { PolicyDecision } from '../../../../packages/policy/src/index.ts';
import { parseRuleReferences } from './references.ts';

export type HistoryRow = {
  id: string;
  row_hash: string;
  ts_ms: number;
  agent_id: string;
  tool: string;
  args_hash: string;
  decision: PolicyDecision['decision'];
  event_kind: string;
  approval_id: string | null;
  upstream_status: number | null;
  upstream_result_ref: string | null;
  policy_version: string;
  matched_rules: string[];
  resolved_ctx: { velocity?: unknown };
};
export type VelocityScope = {
  now: number;
  merchantRef: string;
  customerRef: string;
  agentId: string;
  keyId: string;
};
type Reservation = {
  metadata: VelocityMetadata;
  initial: HistoryRow;
  pending: boolean;
  acceptedAt: number | null;
  created: boolean;
  decided: boolean;
  approved: boolean;
  released: boolean;
};
export type Aggregates = {
  refund_usd_24h: number;
  refund_count_1h: number;
  customer_refund_count_7d: number;
};
const hour = 3_600_000;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function foldHistory(rows: readonly HistoryRow[], scope: VelocityScope) {
  const invalid = (): never => {
    throw new Error('Invalid velocity history.');
  };
  try {
    if (
      rows.length > 10_000 ||
      !Number.isSafeInteger(scope.now) ||
      scope.now < 0
    )
      invalid();
    const requests = new Map<string, Reservation>();
    let previousId = 0n;
    for (const row of rows) {
      const id = BigInt(row.id);
      if (id <= previousId) invalid();
      previousId = id;
      if (row.tool !== 'create_refund') continue;
      if (row.decision === 'deny' && row.resolved_ctx.velocity === undefined)
        continue;
      const metadata = parseVelocityMetadata(row.resolved_ctx.velocity);
      parseRuleReferences(row.matched_rules);
      if (
        !/^agent:[a-f0-9]{64}$/.test(row.agent_id) ||
        metadata.key_id !== scope.keyId ||
        !Number.isSafeInteger(row.ts_ms) ||
        row.ts_ms < 0 ||
        row.ts_ms > scope.now
      )
        invalid();
      if (metadata.merchant_ref !== scope.merchantRef) continue;
      if (
        !['allow', 'deny', 'require_approval'].includes(row.decision) ||
        !/^[a-f0-9]{64}$/.test(row.policy_version) ||
        !/^[a-f0-9]{64}$/.test(row.args_hash) ||
        !/^[a-f0-9]{64}$/.test(row.row_hash) ||
        !Array.isArray(row.matched_rules) ||
        row.matched_rules.some((rule) => typeof rule !== 'string')
      )
        invalid();
      const existing = requests.get(metadata.request_id);
      if (row.event_kind === 'tool_call') {
        if (
          existing ||
          (row.decision === 'require_approval' &&
            (typeof row.approval_id !== 'string' ||
              !uuid.test(row.approval_id)))
        )
          invalid();
        requests.set(metadata.request_id, {
          metadata,
          initial: row,
          pending: row.decision === 'require_approval',
          acceptedAt: row.decision === 'allow' ? row.ts_ms : null,
          created: false,
          decided: false,
          approved: false,
          released: row.decision === 'deny',
        });
        continue;
      }
      if (
        !existing ||
        existing.released ||
        !existing.pending ||
        row.approval_id !== existing.initial.approval_id ||
        row.ts_ms < existing.initial.ts_ms ||
        row.agent_id !== existing.initial.agent_id ||
        row.args_hash !== existing.initial.args_hash ||
        row.policy_version !== existing.initial.policy_version ||
        row.matched_rules.length !== existing.initial.matched_rules.length ||
        row.matched_rules.some(
          (rule, index) => rule !== existing.initial.matched_rules[index],
        ) ||
        Object.keys(metadata).some(
          (key) =>
            metadata[key as keyof VelocityMetadata] !==
            existing.metadata[key as keyof VelocityMetadata],
        )
      )
        invalid();
      const request = existing as Reservation;
      if (row.event_kind === 'approval_created') {
        if (
          request.created ||
          request.decided ||
          row.decision !== 'require_approval'
        )
          invalid();
        request.created = true;
      } else if (row.event_kind === 'approval_decided') {
        if (request.decided || row.decision === 'require_approval') invalid();
        request.decided = true;
        request.approved = row.decision === 'allow';
        if (!request.approved) {
          request.pending = false;
          request.released = true;
        }
      } else if (row.event_kind === 'approval_executed') {
        if (!request.approved || row.decision === 'require_approval') invalid();
        const confirmed =
          row.upstream_status !== null &&
          row.upstream_status >= 200 &&
          row.upstream_status < 300 &&
          typeof row.upstream_result_ref === 'string' &&
          uuid.test(row.upstream_result_ref);
        if (confirmed) {
          if (row.decision !== 'allow') invalid();
          request.pending = false;
          request.acceptedAt = row.ts_ms;
        }
      } else invalid();
    }
    let cents = 0n;
    const agg: Aggregates = {
      refund_usd_24h: 0,
      refund_count_1h: 0,
      customer_refund_count_7d: 0,
    };
    for (const request of requests.values()) {
      if (request.released) continue;
      const within = (duration: number) =>
        request.pending ||
        (request.acceptedAt !== null &&
          request.acceptedAt > scope.now - duration);
      if (request.initial.agent_id === scope.agentId) {
        if (within(24 * hour)) cents += BigInt(request.metadata.usd_cents);
        if (within(hour)) agg.refund_count_1h++;
      }
      if (
        request.metadata.customer_ref === scope.customerRef &&
        within(168 * hour)
      )
        agg.customer_refund_count_7d++;
    }
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    agg.refund_usd_24h = Number(cents) / 100;
    return { agg: Object.freeze(agg), requests };
  } catch {
    return invalid();
  }
}
