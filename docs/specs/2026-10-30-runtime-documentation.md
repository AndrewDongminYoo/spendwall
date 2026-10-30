# Runtime documentation reconciliation

## Problem and approved scope

The operator invoked `pr-loop #22` after upgrading runtime and dependency versions, with a requirement to settle affected documentation in this PR.
Current setup instructions and acceptance summaries disagree with the checked-in pins and later recorded evidence.
This extends the [judge guide baseline](2026-10-16-judge-guide.md) without changing its historical observations.

## Contract

Reconcile current Node, Flutter and Dart instructions with their checked-in pins.
Correct current descriptions of iPhone acceptance, dispute scheduling, synthetic customer lookup and the separate W0 execution path.
Refresh the repository submission narrative and preparation notes without claiming that saved Devpost fields were updated.
Preserve dated rehearsal versions and append a current clean-clone measurement.
Keep issue 22 open for the hosted URL and preserve Android, dispute delivery, public licensing, hosting and 48-hour operation gaps.

## Non-goals

No runtime, dependency, media or layout changes.
No live payment-provider or model calls, device writes, trial issuance, deployment or final submission.
The Flutter SDK upgrade is not itself evidence that real-device behavior was reverified.

## Acceptance

1. Current instructions agree with `.node-version`, `apps/approver/.flutter-version`, `apps/approver/pubspec.yaml`, CI and package scripts.
2. Current behavior claims agree with implementation and the linked dated acceptance records.
3. A new container runs frozen install and all five default demo scenarios within ten minutes after prerequisite preparation, with empty package and inner image stores immediately before the timer starts.
4. Document the measured revision, versions, cache state, duration, expected payment counts and cleanup without generalizing the result to live payments or mobile acceptance.
5. Changed-document local links and formatting pass, the candidate receives structured review, and required hosted checks pass before merge.

## Precedent and limits

Oracle's `wiki/concepts/exact-trigger-verification.md` and `wiki/concepts/deployment-interpreter-verification.md` support testing the actual documented trigger and environment.
Retrieved artifact `9670d54de3076c5239713f54900c7a855bd18478` differs from the inspected local wiki revision, so current-source freshness is unverified.
The project-specific query returned no applicable indexed precedent.
The local issue-closure memory and PR 62 require reading remaining criteria rather than inferring completion from a checkbox or old test title.
