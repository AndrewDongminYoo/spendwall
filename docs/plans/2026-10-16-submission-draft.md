# Submission draft implementation plan

## Owned paths

- `docs/submission-draft.md`
- `docs/specs/2026-10-16-submission-draft.md`
- `docs/plans/2026-10-16-submission-draft.md`
- `README.md`, limited to the development AI disclosure

## Steps and verification

1. Inspect the issue, README/judge guide, runtime manifests and relevant source/tests, then confirm AI development tools with the operator.
   Verify: retain the source map, operator reply and official-rules URL in the draft/review evidence.
2. Write the English draft and correct the README disclosure.
   Verify: compare synthetic payment, approval, sandbox, dashboard and model claims with their readers and tests; do not infer runtime acceptance from dependency presence.
3. Check the four owned documents and internal file links.
   Verify: first make the ad-hoc link checker reject a missing target, then run it on the candidate; format only the owned paths.
4. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `trunk check --all --no-fix` and `docker compose --env-file .env.example config --quiet` with the pinned Node/pnpm versions.
   Verify: inspect exit codes and actual summaries; these checks do not establish Devpost save or final eligibility.
5. Review the complete documentation diff, commit one coherent documentation change, push and open a PR referencing #24 without closing it.
   Verify: current-head CI, hosted code/security reviews and the applicable CodeRabbit result; leave merge to the operator.

## Remaining external acceptance

After reviewing the text, save it through the operator's verified Devpost account and confirm the saved state separately.
The current form fields, character limits, prize selection, video URL and final submission remain unverified by this repository-only task.
