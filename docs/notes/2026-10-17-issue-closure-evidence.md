# Issue closure evidence (2026-10-17)

This note maps every unchecked completion criterion of the open roadmap issues to the assertion that proves it, or to the reason the issue stays open.
All file and line references are at `483bb49`, whose `main` CI run 39011321186 passed.
A test title is treated as a claim: each reference points at the line where the assertion was read.
An issue is closed only when every one of its checkboxes is met.
The check marks in roadmap issue #29 are not evidence; it marks several issues done whose criteria are still open below.

## Closed: every criterion met

### #8 velocity aggregation

- Window boundary under a fixed clock: `tests/velocity.test.mjs:13` fixes `now`, and `tests/velocity.test.mjs:65` asserts that each window excludes its exact lower boundary; `tests/velocity-postgres.test.mjs:494` repeats the boundary against stored timestamps with an injected clock.
- Two concurrent calls cannot exceed the limit: `tests/velocity-postgres.test.mjs:207` (same agent, one `allow` and one `deny`) and `tests/velocity-postgres.test.mjs:230` (two agents at one customer limit).

### #9 context resolver

- Exact `amount.usd` for partial and full refunds: `tests/context-resolver.test.mjs:176` asserts 25 for a partial and 80 for the remaining full amount, with the original, prior and remaining minor units.
- A nonexistent capture denies: `tests/context-resolver.test.mjs:213`.

### #10 agent authentication, tool filtering and token manager

- A key sees only its own tools: `tests/refund-proxy.test.mjs:463` (listed and callable tools follow the grant) and `tests/refund-proxy.test.mjs:590` (two keys list different tools).
- The PayPal token never reaches downstream output: responses at `tests/refund-proxy.test.mjs:347`, persisted audit fields at `tests/audit.test.mjs:34`, CLI and startup output at `tests/refund-proxy.test.mjs:358`, `tests/refund-proxy.test.mjs:386` and `tests/paypal-sandbox.test.mjs:73`.
  The proxy entrypoint logs only its URL, transport and tool count (`apps/firewall/src/index.ts:8`).
- Short `expires_in` renewal and merged concurrent refresh: `tests/refund-execution.test.mjs:183`.
- A refund's 401 retry keeps the same `PayPal-Request-Id` and body: `tests/refund-execution.test.mjs:270`.

### #11 append-only audit log

- A modified row is reported at its exact position by `audit:verify`: `tests/audit-postgres.test.mjs:365` asserts both `verifyAudit` and the CLI output `row <id> (position <n>): row_hash` for the first, middle and last row.
- All three decisions are recorded: `tests/audit-postgres.test.mjs:103`.

### #12 approval state machine

- Approving twice executes once: `tests/approvals-postgres.test.mjs:734` (two independent callers, one POST).
- An expired approval does not execute: `tests/approvals-postgres.test.mjs:230` and `tests/approvals-postgres.test.mjs:794`.
- Illegal transitions are refused: `tests/approvals-postgres.test.mjs:429` and `tests/approvals-postgres.test.mjs:443`.
- Concurrent requests and requests after a restart keep one execution ID: `tests/approvals-postgres.test.mjs:734` and `tests/approvals-postgres.test.mjs:848`.
- A lost response stays `unknown` and keeps its reservation: `tests/approvals-postgres.test.mjs:848`.
- A changed merchant, customer, capture, amount, currency, argument or policy refuses execution: `tests/approvals-postgres.test.mjs:823` and `tests/approvals.test.mjs:38`.
- The REST request carries the real `PayPal-Request-Id` and reuses the same body: the fixture at `tests/approvals-postgres.test.mjs:122` asserts the header equals the stored execution ID, and `tests/approvals-postgres.test.mjs:848` asserts both POSTs are identical.
  A sandbox run with a duplicate call returning the same refund ID is recorded in `fixtures/proxy-refund.json`.

### #14 approval REST API

- The approval flow runs end to end with curl alone: `tests/approval-api-postgres.test.mjs:239` drives actual `curl` subprocesses for registration, listing, detail and decision.
- A hash mismatch returns 409 before any refresh or payment: `tests/approval-api-postgres.test.mjs:1045`.

### #24 Devpost draft

- The operator reported on 2026-10-17 that the Devpost draft was saved, before the 11/6 deadline.
  The verified draft text is `docs/submission-draft.md` (#58).

### #27 invoice policy

The issue has no checkboxes; its three listed rules are tested.

- Amount cap and recipient domain allowlist: `tests/invoice-policy-postgres.test.mjs:56`.
- At most one send per customer per day across agents: `tests/invoice-policy-postgres.test.mjs:190` races two agents for one customer and asserts that the denied call matched `invoice_daily_limit`; `docs/invoice-policy.md:32` scopes the count to the merchant and stable customer ID.

## Closed with a stated limit

### #17 AG Studio dashboard

- Rendering with live data: the dashboard reads the audit PostgreSQL database (`tests/dashboard-postgres.test.mjs:16`), and the #45 PR body records browser verification of populated and empty states, refresh, the custom widget fill and a 390 px layout.
- Custom widget and theme: `apps/dashboard/src/studio.tsx:77` defines the theme, and `docs/dashboard.md:111` describes the registered custom widget; `docs/assets/dashboard-demo.png` shows the rendered page.

Limit: the browser verification is a recorded session, not a repeatable test.
The page runs under AG Studio's unlicensed local evaluation (`docs/dashboard.md:116`); the license is a #25 item.

### #21 natural-language policy preview

- Output that fails validation never enables the apply action: the server refuses invalid model output (`tests/policy-preview-http.test.mjs:106`, `tests/policy-preview.test.mjs:28`).
  In the UI, a draft is stored only after a successful proposal (`apps/dashboard/src/policy-preview.tsx:100`), the draft section renders only when one exists (`apps/dashboard/src/policy-preview.tsx:243`), and its download button stays disabled until the reviewer confirms (`apps/dashboard/src/policy-preview.tsx:329`).
  The action downloads a reviewed draft and never applies it to the running policy.
- The dry-run matches the re-evaluation of stored inputs: `tests/policy-preview-postgres.test.mjs:313` replays actual encrypted records and asserts the changed, unchanged and unavailable counts; `tests/policy-preview-postgres.test.mjs:68` asserts that the replay uses the exact original inputs.

Limit: the UI conditions are read from source; no component test renders them.

## Left open

- #15 Flutter approver: push, biometric approval and a sandbox refund on a physical device remain pending (`README.md:96`).
  The second criterion, disabled buttons for expired or processed items, was not assessed in this note.
- #18 Studio audit queries: the server chooses one of three deterministic projections (`docs/dashboard.md:83`) and a repeated synthetic run replaces one widget (`tests/dashboard-runner.test.mjs:24`).
  Repeatability with a configured live model is not verified (`docs/dashboard.md:105`).
- #19 webhook reconciliation: forged signatures are refused (`tests/webhooks.test.mjs:120`), but a refund made directly in the PayPal dashboard has not been observed as unmediated (`README.md:60`).
- #22 README, judge guide and threat model: the documents exist (`README.md`, `docs/judge-guide.md`, `docs/threat-model.md`), and `docs/judge-guide.md:102` records a fresh-container clone running the then four default scenarios in 47 seconds at `652ee1f`.
  The default demo now also runs `shopping` (`apps/agent-demo/src/firewall.ts:22`), so the ten-minute fresh-container check has to be repeated for the current five scenarios.
- #23 demo video: no recording, captions or upload are in the repository.
- #25 final rehearsal and submission: the history secret scan (`docs/notes/2026-10-16-history-secret-scan.md`) and a bounded live rehearsal (`docs/notes/2026-10-16-live-rehearsal.md`) are recorded; the hosted demo URL (`README.md:55`), the AG Studio license, the video and the final submission remain.
- #28 dispute policy: acceptance is forced to `require_approval` and the response deadline is classified (`docs/dispute-policy.md:6`, `docs/dispute-policy.md:52`), but no deadline notification is sent (`docs/dispute-policy.md:8`).
