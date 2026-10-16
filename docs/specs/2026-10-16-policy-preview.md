# Policy proposals and historical preview

## Status and evidence

Approved contract for [issue 21](https://github.com/AndrewDongminYoo/spendwall/issues/21), inspected against main `6fffc6a2a6d56686346023cd2c17157e1e5d5db0`.
The operator approved encrypted retention and exact historical reevaluation on 2026-10-16.
No AG Studio trial, hosted deployment, paid model call or live payment is authorized by this plan.

The existing policy loader validates YAML and prepares CEL expressions in `packages/policy/src/index.ts`.
The evaluator consumes `tool`, `args`, `amount`, `agent`, `customer`, `merchant` and `agg`, including arbitrary nested identity attributes.
`VelocityPolicy.evaluateAndReserve` replaces caller aggregates with database history before evaluation.
`apps/firewall/src/audit/event.ts` intentionally redacts arbitrary context and identity values.
Existing audit rows therefore cannot reproduce arbitrary policy decisions accurately.
Approval snapshots alone cannot cover all allowed and denied calls.

## Scope

Add an optional policy-proposal surface to the local dashboard using the existing Claude Messages integration pattern.
Send only the explicitly configured current policy and the operator's bounded instruction to the model.
Do not send historical payment inputs, enrollment credentials, provider tokens or database contents to the model.
Use synthetic model responses in automated and browser tests.

The model returns a YAML candidate bounded to 64 KiB and 2,000 lines for review.
Use the existing loader for schema, CEL and default-deny validation before presenting a usable proposal.
Show the current and proposed policy, their content versions and a deterministic diff.
Model text is untrusted input, not approval or a policy decision.
Malformed, refused, truncated and timed-out output cannot enable confirmation.

Human confirmation permits downloading the exact validated proposal, bound to the displayed base version and candidate version.
It does not update a running firewall or the repository's policy file.
Label this action as exporting a reviewed draft, not applying a live policy.
Changing the base policy invalidates the draft and requires another review.
Actual policy activation and production deployment remain separate operator actions.

## Approved replay data retention

Introduce an opt-in, encrypted replay store for future evaluations.
Capture the exact inert JSON context used by the evaluator, including the authoritative aggregates, inside the same transaction as the initial audit event.
Store a versioned envelope bound to its merchant reference, audit event ID/hash, policy version and original decision.
Use a separate operator-provided encryption key and authenticated encryption.
Do not reuse payment credentials, dashboard bearer tokens or the existing identity key as the encryption key.
The existing redacted, append-only audit schema and its hash history remain unchanged.

The recorder uses narrowly scoped insert permissions; the preview reader cannot modify audit, approvals or policy state.
The dashboard launcher purges expired replay payloads at startup and once per minute while running, using a narrow database function that cannot delete unexpired data or audit rows.
Recording also purges expired payloads in its transaction.
No system scheduler is installed; after downtime physical deletion resumes at the next launcher start or recorded evaluation.
Seven days bounds replay availability; physical cleanup can lag by the worker interval, expired-record backlog or downtime.
Each cleanup uses an expiry index and deletes at most 1,000 expired rows, skipping records locked by another cleanup.
Read paths also exclude expired payloads, even if maintenance has not run.
This store retains sensitive policy input that the ordinary audit log omits; the operator explicitly approved this extension.

## Reviewer authorization

All policy routes require both the dashboard bearer and an independent policy reviewer credential.
Verify both before reading policy/history or invoking the model.
Exact predicate counts can disclose retained attributes, so this credential grants sensitive replay access and must not be shared with read-only dashboard users.
The UI retains it only in component memory and clears it on lock, refresh or disconnect.

## Historical preview semantics

Read one merchant-scoped, bounded snapshot of original tool-call events in `(now - 7 days, now]`.
Reevaluate each available exact historical input with the validated candidate through `evaluatePolicy`.
Keep historical aggregates fixed: this is a comparison at recorded inputs, not a simulation of a new sequence of payments or reservations.
Do not execute payments, create reservations, modify approvals or append decision events during preview.

Return `total`, `replayed`, `changed`, `unchanged` and `unavailable` counts.
Require `replayed = changed + unchanged` and `total = replayed + unavailable`.
Missing snapshots, legacy rows, undecryptable payloads or unsupported snapshot versions contribute to unavailable, never to unchanged or a fabricated decision.
Mark coverage as partial whenever unavailable is nonzero.
A merchant-scoped 10,000-call or 8 MiB ciphertext budget overflow, database, authentication or history-bound failures make the whole preview unavailable rather than returning a misleading truncated count.
Return only decision counts and safe event references to the browser; do not return decrypted identity or payment context.

## Acceptance checks

1. Proposal validity → invalid YAML, schema violations, CEL failures and untrusted model output cannot enable export; the existing loader accepts every exported candidate.
2. Human confirmation → no policy file, running policy, audit event, reservation or payment changes before or after draft export; stale-base confirmation fails.
3. Replay fidelity → exact stored contexts reproduce their original decisions before comparing a candidate; controlled changes produce independently checked changed/unchanged counts.
4. Coverage → legacy, expired, missing and corrupt snapshots remain visibly unavailable; no plaintext reconstruction is attempted.
5. Privacy and scope → actual PostgreSQL tests inspect ciphertext and permissions, merchant isolation, transaction rollback and seven-day retention boundaries.
6. Runtime bounds → authentication, bounded input/model output, cancellation, concurrency limits and database errors fail safely.
7. Presentation → desktop and narrow-screen browser checks cover valid, invalid, partial, empty, disconnected and stale states; operator visual approval is required before merge.
8. Delivery → pinned Node/pnpm checks, Trunk, Compose, local core-area review and current-head hosted review/CI must pass.

Oracle retrieval for approval app and policy replay returned `[no precedent found]`.
Advisor recommended issue 21 over issue 15 because the mobile end-to-end path lacks provisioned Firebase/APNs, app identity and a reachable API.
Advisor also required explicit unavailable coverage instead of inferred historical inputs.
