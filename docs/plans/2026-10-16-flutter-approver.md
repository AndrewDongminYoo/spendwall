# Flutter approver implementation plan

## Direction

Execute the operator-requested [issue 15 contract](../specs/2026-10-16-flutter-approver.md) in the main workspace on `codex/issue-15-flutter-approver`.
No worktree is needed.
Keep actual deployment and trial issuance deferred.
The root owns all edits, staging, commits and final gates.

## Owned scope

- `apps/approver/**`: generated iOS/Android projects, Dart client, native adapters, UI, tests, package lockfile and app guide.
- `apps/firewall/src/approvals/index.ts`, `apps/firewall/src/approver/server.ts`, `apps/firewall/src/approver/fcm.ts`: stored matched-rule projection and generic tappable notification payload only.
- `tests/approval-api.test.mjs`, `tests/approval-api-postgres.test.mjs`: contract regressions for those additions.
- `.github/workflows/ci.yml`, `.prettierignore`, root `AGENTS.md`, `README.md`, `docs/approval-api.md` and the new app spec/plan: scoped checks and accurate integration instructions.

## Steps and checks

1. Confirm the account, issue, API and installed Flutter version; retrieve narrowly scoped Oracle precedent.
   Record missing Firebase/APNs and physical connection evidence separately.
2. Add failing regressions for stored rule projection and non-sensitive visible notifications.
   Implement the minimal server additions and run `pnpm test:approval-api` plus the direct FCM tests.
3. Generate only iOS/Android platforms using the installed Flutter SDK.
   Add native dependencies and run `flutter pub get` to produce the lockfile.
   Preserve the independent app's pnpm exclusion.
4. Develop the strict response model, HTTP client and approval controller through failing tests.
   Use actual local HTTP requests to test transport boundaries and controlled native adapters for biometric and credential-storage branches.
5. Implement enrollment, queue, detail and outcomes with the required hierarchy.
   Add widget tests for real state transitions, long content, expiry, double taps, cancellation and ambiguous decisions.
   Connect native biometric, secure-storage and FCM adapters without adding test bypasses to the normal entrypoint.
6. Configure native capabilities and debug-only local connection behavior from current plugin documentation.
   Run mobile builds one at a time after machine-load checks.
   Keep personal Firebase files, signing credentials and device writes outside automatic scaffolding.
7. Update existing docs and CI in this PR.
   Run `dart format` on explicit app Dart paths, `flutter analyze`, `flutter test`, repository `pnpm check`, `trunk check --all --no-fix` and Compose parsing.
   Run native build and rendered interaction checks within available toolchain and configuration.
8. Review security/session behavior and UI/native behavior independently when the resulting core-area diff requires parallel review.
   Repair sequentially and repeat only affected checks.
9. Commit by concern, push, open the PR without closing issue 15 until physical acceptance is established, and observe current-head hosted review and CI within the recorded budget.
   Preserve screenshots and review notes in the surviving visible review directory.
10. Request operator visual approval and merge only after technical gates and accurately scoped acceptance are satisfied.
    Keep any unavailable physical-device criterion and its concrete resume action explicit.

## Full-device prerequisites

The physical path needs the exact personal Firebase project and app IDs, APNs configuration, provisioned device enrollment, a private reachable approval API and an approved sandbox fixture.
Do not enable public network access to bypass a missing prerequisite.
Before every physical-device install, uninstall or launch that terminates another process, state the exact operation and obtain any missing operation-specific authority.
No real payment or FCM send occurs under synthetic verification.
