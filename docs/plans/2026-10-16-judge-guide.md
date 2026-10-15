# Judge guide implementation

## Direction and ownership

The root owns README.md, the scope/structure descriptions in AGENTS.md, docs/judge-guide.md, docs/threat-model.md, docs/assets/dashboard-demo.gif, docs/assets/dashboard-demo.png and this spec/plan pair.
Use the current workspace and `codex/issue-22-judge-guide`.
Do not change runtime code or dependencies.

## Steps and checks

1. Reconcile README, demo, seed, proxy and dashboard boundaries.
   Before editing, README's unimplemented-interface claim conflicts with merged code, and the fixed synthetic adapter disproves a seed-to-demo flow.
   These are content failures; tests that repeat prose would not verify them.
2. Write the guide, source-linked threat model, architecture and AI disclosure.
   Verify claims against implementation and existing tests; make a local-link check fail on a missing target before trusting its pass.
3. Rehearse a fresh clone in a new container with pinned Node/pnpm, a fresh dependency store and actual disposable PostgreSQL execution.
   Record output, elapsed time, candidate revision and cache conditions.
4. Record the synthetic dashboard in a named isolated browser session, export a GIF/static frame, inspect the artifacts and close owned resources.
5. Run explicit-path formatting, declared checks, a structured local adversarial review and the advisory Codex diagnostic for the contributor-instruction edit.
6. Commit the cohesive documentation change, push, open a PR referencing #22, observe hosted review/CI, then request operator visual approval and merge.

## Boundaries

No credentials are required for the selected Quickstart.
Do not run seed, live Claude, payment smoke commands, deployment or trial issuance.
Disposable validation tooling is not a product deployment or repository dependency.
Retain hosted URL and live-sandbox acceptance gaps explicitly.
