# Context resolver implementation plan

**Goal:** Implement #9's isolated read-only resolver and demonstrate exact
partial/full refund USD exposure and fail-closed missing captures.

**Spec:** `docs/specs/2026-10-14-context-resolver.md`.

**Constraints:** Node >=24.21.0 <25, pnpm 11.24.0, strict TypeScript, frozen
install and repository checks; no changes to policy, audit PR #37, current
executor, API credentials, real PayPal calls, production databases, deployment
or merging. Reuse `normalizeAmount` through its existing exported source entry.
No new runtime dependency or manifest changes are required.

## Safe transport and cache

- Write failing synthetic REST tests for missing/failed reads, overall timeout,
  redirection, response bounds, TTL, same-key sharing, stale failure and invalidation.
- Implement `apps/firewall/src/context/rest.ts`: read-only authenticated GET,
  validated fixed paths, bounded transport and per-merchant cached remote facts.
- Verify each caller sees independently validated immutable context, and an old
  in-flight response cannot survive invalidation or extend freshness.

## Context registry and resolvers

- Write `tests/context-resolver.test.mjs` with local HTTP fixtures, all currencies,
  full/partial/prior refunds, tampered identity/money/history and invoice cases.
- Observe failures before implementing `apps/firewall/src/context/index.ts`,
  `json.ts`, `money.ts`, `refund.ts`, and `invoice.ts`.
- Produce exact policy envelopes, normalized amounts and audit context; return
  explicit deny reasons for resolution errors. Validate the #3 tool schemas.
- Re-run focused tests, including a real `evaluatePolicy` test showing that the
  resulting original amount is accepted while a caller-provided USD field is denied.

## Review and delivery

- Document supported subsets, explicit history requirement, identity contract,
  cache invalidation, fake FX and deferred audit/auth/execution integration in
  `docs/context-resolver.md`.
- Run frozen install, lint/typecheck/full tests/Trunk/Compose; report local tool
  egress limits explicitly and inspect exact-head CI.
- Perform an independent local review, fix actionable findings with regressions,
  publish a normal PR and observe a bounded hosted review loop without manual
  paid-service requests. Use an additional local review if needed for convergence.
- Keep #37 and policy/executor code unchanged; report final result and stop.

Review focus: history completeness and linkage, integer/rational money handling,
caller identity vs cache scope, invalidation races, stale/oversized/partial reads,
invoice pricing modifiers and policy-envelope compatibility.
