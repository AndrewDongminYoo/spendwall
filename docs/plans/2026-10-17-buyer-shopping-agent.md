# Buyer-side shopping agent implementation plan

## Ownership and sequence

The PR loop builds in the `spendwall-buyer-shopping-agent` worktree on branch `feat/buyer-shopping-agent` from `origin/main`.
No new dependency is required.

1. Add `apps/firewall/src/context/order.ts` and register `create_order` and `pay_order` in `ContextResolver`, recomputing totals per `docs/tool-risk.md`.
2. Add `migrations/009-orders.sql` and `apps/firewall/src/orders/index.ts` with creation, approve-link ledger, approval-bound capture, execution-id idempotency and unknown-outcome preservation.
3. Add the `orders` schema to hosted-reader and webhook-receiver restriction checks.
4. Add the synthetic Orders v2 adapter, catalog fixture, `shopping` ticket, `shopping-policy.yaml` and the `shopping` demo scenario with recorded replay and optional live run.
5. Add `tests/orders.test.mjs`, `tests/orders-postgres.test.mjs`, the order fixture helper, extend `tests/agent-demo.test.mjs` and include the database suite in `scripts/test-audit-postgres.mjs`.
6. Document in `docs/shopping.md`, the demo README, the resolver contract, root `README.md` and contributor claims; the PR body carries `Closes #26`.
7. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `trunk check --all --no-fix` and `docker compose --env-file .env.example config --quiet`; a live Claude rehearsal runs at most twice outside the gates.
8. Review at the Large tier because the diff touches money-moving core areas, then push, open the PR and finish hosted review under the parent loop.
