# Policy evaluator implementation plan

Implement the [approved issue contract](../specs/2026-10-14-policy-evaluator.md) in the current workspace on `codex/issue-7-policy-evaluator`.
The root owns edits, staging, commits, and final checks.

## Steps and checks

1. Add table-driven evaluator and normalization tests with API stubs, then observe behavioral failures.
   Verify with `node --test tests/policy-evaluator.test.mjs`.
2. Implement integer demo normalization and bounded JSON context validation, then tool precedence and deterministic rule combination.
3. Reuse the pinned CEL parser through a loader-owned per-call observation macro.
   Prove masked errors deny while unreachable errors and valid presence checks retain their CEL behavior.
   Keep existing loader regressions green.
4. Run the frozen install, `pnpm check`, Trunk, and Compose checks.
   These inspect dependency reproducibility, formatting, strict types, executable behavior, repository gates, and Compose configuration respectively.
5. Run independent read-only reviews of evaluator/amount safety and loader/API compatibility, followed by root adversarial reconciliation.
   Repair supported findings sequentially with failing regressions.
6. Commit by concern, push, create the PR, and observe current-head CI and hosted review.
   Require the complete review-thread gate before requesting operator merge.

## Owned paths and limits

Own `packages/policy/src/index.ts`, `packages/policy/src/cel.ts`, `packages/policy/src/evaluator.ts`, `packages/policy/src/money.ts`, `packages/policy/tsconfig.json`, `tests/policy-evaluator.test.mjs`, this plan, and its specification.
Enable TypeScript extension imports in the policy package, matching the existing direct-Node firewall convention without relaxing strict checking.
Do not add dependencies, alter payment behavior, edit issues, or create a worktree.
No merge authority is implied by this plan.
