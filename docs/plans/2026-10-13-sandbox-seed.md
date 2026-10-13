# Sandbox capture seed implementation

## Approved direction

Implement issue #4 in the existing main workspace on `feat/issue-4-sandbox-seed`.
The operator requested the PR Loop for this issue after merging PR #32.
The root owns all edits, staging, commits, and verification.
Use the existing Node runtime, fetch, test runner, OAuth helper, and JSON formatter; add no dependency.

## Steps and checks

1. Add `scripts/seed.mjs` as an importable CLI and `tests/paypal-seed.test.mjs` with a local HTTP server representing OAuth and Orders v2.
   Observe behavioral failures against the stub, then implement fixed sandbox requests, capture validation, and the 20-payment amount distribution.
2. Add durable request IDs, a single atomic fixture ledger, client binding, transient retry limits, interrupted-run recovery, and a per-fixture lock.
   Verify stable payloads after ambiguous failure, preservation of previous batches, rejection of old/invalid state, concurrent denial, and response redaction.
3. Add `pnpm seed`, regenerate `pnpm-lock.yaml` with pnpm, and exclude temporary lock/write files in `.gitignore`.
   Document use and recovery in `docs/seed.md`; use `fixtures/captures.json` only for actual validated sandbox output.
4. Run focused tests, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `trunk check --all --no-fix`, and `docker compose --env-file .env.example config --quiet`.
5. Obtain two live seed runs with privately loaded sandbox credentials.
   Inspect captured amounts, unique IDs, completed batches, client binding, and preservation of the first run's records.
   If card eligibility blocks the run, diagnose that response before selecting the issue's approved browser fallback.
6. Review the complete diff with independent read-only coverage calibrated to its actual size and payment-related risk.
   Repair confirmed findings, create scoped commits and a PR, then follow current-head hosted review and CI to the operator merge boundary.

## Authority and terminal conditions

Implementation, commits, pushes, PR updates, and review replies are authorized by the explicit PR Loop request.
New-PR merge and memory recording are not delegated.
Previous `clean-gone` authority covers eligible merged local branches.
Keep live-payment verification gaps explicit and do not close issue #4 without its real acceptance evidence.
