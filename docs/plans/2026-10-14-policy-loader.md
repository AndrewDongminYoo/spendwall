# Policy loader implementation plan

Implement the [approved issue contract](../specs/2026-10-14-policy-loader.md) in the existing workspace on `feat/issue-6-policy-loader`.
The root owns all edits, staging, commits, and final verification.

## Steps and checks

1. Verify the selected CEL package supports preparsing, representative #7 contexts, and rejection of malformed input.
   Add exact policy dependencies and regenerate the pnpm lockfile.
2. Add loader acceptance tests before implementation and observe the expected behavioral failures.
   Verify with `node --test tests/policy-loader.test.mjs`.
3. Implement the strict schema, single-document YAML loader, CEL preparation, immutable output, and canonical content hash.
   Verify denial cases, YAML error paths, hash stability, and a real downstream-style condition consumer.
4. Run `pnpm install --frozen-lockfile`, `pnpm check`, `trunk check --all --no-fix`, and `docker compose --env-file .env.example config --quiet`.
   These checks inspect dependencies, formatting, types, executable tests, repository gates, and Compose configuration respectively.
5. Review the policy boundary and #7 integration contract independently under the core-area review rule.
   Repair supported findings and repeat only the affected checks.
6. Commit the contract and implementation by concern, push, open the PR, and observe current-head CI and hosted review.
   Request operator merge only after all required signals and the complete review-thread gate pass.

## Owned files and limits

Limit product changes to `packages/policy/package.json`, `packages/policy/tsconfig.json`, `packages/policy/src/index.ts`, `tests/policy-loader.test.mjs`, and the regenerated `pnpm-lock.yaml`.
Keep durable task documentation in this plan and its specification.
No payment API requests, issue edits, unrelated documentation fixes, evaluator feature expansion, or new worktrees are needed.
