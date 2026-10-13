# Refund proxy implementation plan

The operator approved the [contract](../specs/2026-10-13-refund-proxy.md) and issue alignment on 2026-10-13.
Use the current workspace on `feat/issue-5-refund-proxy`; no additional worktree is needed.

## Owned scope

The root owns `apps/firewall`, focused proxy tests and scripts, related documents, package manifests, the regenerated lockfile, and explicit runtime-artifact ignore rules.
Keep the prior SSE snapshot and capture fixture unchanged.
Add only NestJS runtime dependencies, its peers, the existing MCP SDK as an explicit app dependency, and Node type declarations needed by the TypeScript app.
Use Node's existing test runner and native TypeScript support rather than introducing a test or build framework.

## Steps and checks

1. Update #3, #5, #10, and #12 to reflect the approved contract, preserving completed SSE discovery history.
   Verify the resulting issue bodies against their saved before/after text.
2. Write focused failing tests for token expiry and refund execution against a local HTTP fixture.
   Verify with `node --test tests/refund-execution.test.mjs` before implementing the behavior.
3. Implement token renewal and a persisted sandbox refund executor with safe errors, request binding, locking, and recovery.
   Verify the fixture observes durable state and identical upstream IDs/bodies across retries and restarts.
4. Write failing end-to-end proxy tests using a real SDK client, a local SDK upstream, and NestJS.
   Implement Streamable HTTP, explicit SSE mode, catalog/input validation, authentication, deadlines, and refund dispatch.
   Verify with `node --test tests/refund-proxy.test.mjs`.
5. Add bounded command-line checks and a runbook, including an explicit capture and execution ID for the actual refund.
   Verify invalid commands and missing credentials fail safely before network side effects.
6. Run `pnpm check`, `pnpm install --frozen-lockfile`, `trunk check --all --no-fix`, and Compose configuration validation.
   Review the complete diff and run independent contract/security reviews under the large/core-area review rule.
7. Inspect the operator-run authenticated HTTP probe and refund acceptance artifact.
   Verify duplicate calls resolve to the same refund and inspect the stored fixture evidence without reading credential files.
8. Create concern-based commits and a PR, observe current-head CI and hosted review, and request operator merge only after the gates pass.

## Limits

Local synthetic tests prove the adapter's requests and state transitions, not hosted PayPal compatibility or an actual refund.
The final gate requires sandbox evidence.
No refund request may silently fall back to another transport or acquire a new execution ID after an unknown result.
