# Dispute policy implementation plan

## Ownership and sequence

The root owns implementation and Git operations in the main workspace.
No worktree, dependency change or database migration is required.

1. Add `tests/dispute-policy.test.mjs` and a synthetic fixture helper.
   Observe supported dispute resolution failing through the existing resolver's explicit unsupported-tool denial.
2. Add `apps/firewall/src/context/dispute.ts` and update only dispute routing/invalidation in `context/index.ts` and the fixed GET allowlist in `context/rest.ts`.
   Verify ownership, transaction mapping, money, response capability, cache behavior and failure paths.
3. Add `apps/firewall/src/disputes/index.ts` with a deny-first scaffold; observe a valid acceptance review test fail, then implement loaded-policy evaluation, the mandatory approval floor, immutable fingerprint and deadline classification.
4. Add `scripts/dispute-demo.mjs` and a sample policy, then update `docs/dispute-policy.md`, relevant resolver documentation, README and AGENTS claims.
5. Run the focused tests and example, followed by the declared repository gates.
   These checks establish local decisions and GET-only synthetic traffic, not real approvals or provider execution.
6. Complete independent read-only reviews of trusted-context integrity and approval/deadline policy behavior, then root adversarial assessment and bounded repairs.
7. Commit by concern, push, open the PR and complete hosted code/security review and CI.
   Leave merge to the operator.
