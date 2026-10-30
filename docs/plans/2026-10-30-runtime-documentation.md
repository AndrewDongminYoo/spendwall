# Runtime documentation implementation

## Ownership and constraints

Use the main workspace on `docs/22-runtime-drift`.
The root owns edits, verification, staging, commits and PR actions.
Read-only auditors inspect runtime/configuration claims and behavior/evidence claims independently.
Current documents in scope are AGENTS.md, README.md, apps/approver/README.md, docs/judge-guide.md, docs/proxy.md, docs/submission-draft.md and docs/threat-model.md, plus this plan and its [spec](../specs/2026-10-30-runtime-documentation.md).
No runtime or dependency changes are planned.

## Steps and verification

1. Inventory current claims and compare them with checked-in configuration, source and dated evidence.
   Before edits, confirm the stale Node/Flutter/Dart instructions, missing-scheduler claim, pending-iPhone claim and W0 resolver wording.
2. Correct those claims and review directly affected linked documents, including the submission draft.
   Preserve historical records and distinguish repository text from externally saved content.
3. Run a fresh public clone of the current runtime revision in a new Node 24.22.2 container with an independent Docker daemon.
   Verify frozen install, five expected PASS lines, payment counts, elapsed time, a clean clone and removal of demo containers.
4. Append the bounded observation to the judge guide.
   Verify changed-document local links with a negative control, explicit-path formatting and scoped Trunk checks.
5. Review the entire candidate and its documentation audit table.
   Fix confirmed omissions in the same PR and rerun affected checks.
6. Make one cohesive documentation commit, push and open a PR using `Refs #22`.
   Verify empty closing references, current-head CI and hosted review, then finish the body and assign the operator before the authorized gated merge.
7. Verify the merge and issue 22's open state.
   Preserve a visible receipt and retire only this run's owned control state.
   Branch cleanup and memory recording were not requested.

## Review boundary

Existing media, layout and diagrams remain unchanged, so operator visual approval is not applicable.
Native checks and synthetic tests do not establish new physical-device acceptance.
