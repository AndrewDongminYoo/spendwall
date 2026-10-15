# Audit agent implementation

Direction approved by the operator through issue #18 and Claude reuse; AG Studio trial issuance remains deferred.
Use the existing workspace and a scoped branch.

## Steps and ownership

1. Root: add bounded query contracts and deterministic projections under `apps/firewall/src/dashboard/`, with failing behavior tests in `tests/dashboard-query.test.mjs`.
   Verify week, USD, grouping, and reservation history boundaries with Node tests.
2. Root: add the Claude adapter, authenticated POST endpoint, optional private configuration, and labelled synthetic preview wiring.
   Verify malformed requests, provider output, authentication before provider/database access, timeout/cancellation, merchant continuity, and actual PostgreSQL read-only execution.
3. Root: add the custom Studio runner, query input, and deterministic widget replacement in `apps/dashboard/src/`.
   Verify runner events and cancellation through tests, then three repeated queries in a named browser session at desktop and mobile widths.
4. Root: update `docs/dashboard.md`; run frozen install, lint, typecheck, complete tests, frontend build, Trunk, and compose validation.
5. Independent read-only reviews: inspect the server data/provider boundary and the client runner/widget lifecycle; root resolves findings sequentially, at most two local repair rounds.
6. Root: create concern-based commits, push, open the PR, observe current-head CI and hosted reviews within the recorded budget, and request final visual approval and operator merge.

## Constraints

No new dependency, live credential lookup, paid provider call, trial activation, or payment mutation is needed for local implementation and synthetic verification.
Live Claude behavior remains an explicit verification gap until configured and authorized.
Use actual lifecycle fixtures for reservation trend assertions; a zero-only fixture cannot prove the trend.
Do not alter payment policy evaluation or the shared velocity reducer.
