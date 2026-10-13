# MCP discovery plan

## Ownership and approved direction

The root agent owns `scripts/check-paypal-sandbox.mjs`, `scripts/dump-paypal-mcp-tools.mjs`, `tests/paypal-mcp-discovery.test.mjs`, the root package manifest and lockfile, this plan, the discovery spec, and the requested snapshot and risk document.
Use the main checkout on the issue #3 branch.
The operator approved milestone execution through PR Loop.
No visual approval is needed for this CLI and technical documentation.

## Execution and verification

1. Pin the issue's SDK dependency and regenerate the lockfile with pnpm.
2. Write a local SSE fixture and observe the discovery contract fail against a stub.
3. Share the OAuth request, implement bounded discovery, and atomically save complete results.
4. Verify authentication on both SSE and POST requests, cursor traversal, duplicate rejection, timeout cleanup, and credential-safe errors with `node --test tests/paypal-mcp-discovery.test.mjs tests/paypal-sandbox.test.mjs`.
5. Obtain a real snapshot by running the command in the operator's credential-enabled shell.
6. Read each tool schema, classify all tools, and check one-to-one coverage with the snapshot.
7. Run `pnpm install --frozen-lockfile`, repository checks, and a local adversarial review before commit and PR creation.
8. Observe hosted CI and review, repair supported findings, and request operator merge.

## Boundaries

Synthetic-server tests establish local client behavior only.
The actual snapshot is required to satisfy discovery acceptance.
Do not write credentials into the snapshot, docs, logs, or Git-local state.
Missing runtime credentials require the operator to execute the prepared command locally.
