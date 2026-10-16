import { createHash } from 'node:crypto';
import { evaluatePolicy } from '../../../../packages/policy/src/index.ts';
import type { LoadedPolicy } from '../../../../packages/policy/src/index.ts';
import type { ContextResolver, PolicyContext } from '../context/index.ts';
import { disputeDeadline } from '../context/dispute.ts';
import { fail, freeze, object, snapshot } from '../context/json.ts';
import type { JsonObject } from '../context/json.ts';
import { canonical } from '../refunds.ts';

type Deadline = Readonly<{
  status: 'not_provided' | 'overdue' | 'due_soon' | 'scheduled';
  dueAt?: string;
  remainingMs?: number;
}>;
export type DisputeResult = Readonly<{
  decision: 'deny' | 'require_approval';
  dispatchAllowed: false;
  reason:
    | 'dispute_unavailable'
    | 'policy_denied'
    | 'dispute_acceptance_requires_approval';
  policyVersion: string;
  matchedRules: readonly string[];
  review?: Readonly<{
    context: PolicyContext;
    resolvedCtx: JsonObject;
    bindingHash: string;
    deadline: Deadline;
  }>;
}>;

function deadline(value: unknown, now: number): Deadline {
  if (!Number.isSafeInteger(now) || now < 0) fail();
  if (value === undefined) return { status: 'not_provided' };
  const dueAt = disputeDeadline(value);
  const remainingMs = Math.max(0, Date.parse(dueAt) - now);
  return {
    status:
      remainingMs === 0
        ? 'overdue'
        : remainingMs <= 86_400_000
          ? 'due_soon'
          : 'scheduled',
    dueAt,
    remainingMs,
  };
}

// A trusted local review boundary, never an approval store or provider executor.
export class DisputePolicy {
  private readonly resolver: ContextResolver;
  private readonly now: () => number;
  constructor(options: { resolver: ContextResolver; now?: () => number }) {
    this.resolver = options.resolver;
    this.now = options.now ?? Date.now;
  }

  async evaluate(
    policy: LoadedPolicy,
    input: unknown,
    trustedContext: unknown,
  ): Promise<DisputeResult> {
    const deny = (
      reason: 'dispute_unavailable' | 'policy_denied',
      matchedRules: readonly string[] = [],
    ): DisputeResult =>
      freeze({
        decision: 'deny',
        dispatchAllowed: false,
        reason,
        policyVersion: policy.policyVersion,
        matchedRules,
      });
    try {
      const request = object(snapshot(input));
      if (request.tool !== 'accept_dispute_claim')
        return deny('dispute_unavailable');
      const trusted = object(snapshot(trustedContext));
      // There is no dispute exposure ledger in this baseline. Never trust caller aggregates.
      const resolution = await this.resolver.resolve(request, {
        ...trusted,
        agg: {},
      });
      if (!resolution.ok) return deny('dispute_unavailable');
      const evaluated = evaluatePolicy(policy, resolution.context);
      if (evaluated.decision === 'deny')
        return deny('policy_denied', evaluated.matchedRules);
      const { context, resolvedCtx } = resolution;
      const urgency = deadline(
        object(resolvedCtx.dispute).seller_response_due_date,
        this.now(),
      );
      const bindingHash = createHash('sha256')
        .update(
          canonical({
            boundary: 'spendwall/dispute-review/v1',
            policyVersion: evaluated.policyVersion,
            context,
            resolvedCtx,
          }),
        )
        .digest('hex');
      return freeze({
        decision: 'require_approval',
        dispatchAllowed: false,
        reason: 'dispute_acceptance_requires_approval',
        policyVersion: evaluated.policyVersion,
        matchedRules: evaluated.matchedRules,
        review: { context, resolvedCtx, bindingHash, deadline: urgency },
      });
    } catch {
      return deny('dispute_unavailable');
    }
  }
}
