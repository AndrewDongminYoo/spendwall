# Live model rehearsal plan

## Ownership and scope

The root owns the existing main workspace and all Git operations.
No worktree, dependency upgrade, external payment operation or device write is planned.
Inspect `apps/agent-demo/src/agent.ts`, `index.ts`, `runner.ts`, fixtures and relevant SDK transport code.
Expected edits are this spec/plan, a dated evidence note and directly affected agent/judge documentation; change runtime code only for an observed defect.

## Sequence and verification

1. Confirm API-key presence without exposing its value and inspect actual SDK environment isolation and limits.
   Verify using installed source and sanitized option/result instrumentation.
2. Run the existing small live scenario, then inspect terminal result, cost estimate, tool events and resource cleanup.
   Continue with approval, injection and velocity only within the recorded limits.
3. If a defect appears, reproduce it with a meaningful failing test before a scoped repair.
   Stop and report external blockers rather than adding permissions, provider integrations or unbounded retries.
4. Write a dated observation note and correct only the affected documentation claims.
   Preserve the distinction between live Claude, synthetic payments, recorded calls and missing coverage.
5. Run relevant tests plus `pnpm lint`, `pnpm typecheck`, `pnpm test`, `trunk check --all --no-fix` and Compose validation.
   Review the final diff, commit by concern, push, and complete hosted CI/code/security review.
6. Request operator merge after readiness; leave the parent issue open for remaining submission criteria.
