# Judge guide and threat model

Issue: https://github.com/AndrewDongminYoo/spendwall/issues/22.
The operator approved this documentation baseline with `pr-loop #22`; trial issuance remains deferred.

## Problem and scope

The README describes implemented modules as a scaffold and lacks a complete first-run path.
The issue's proposed `pnpm seed && pnpm demo` sequence implies integration that does not exist: seed writes PayPal sandbox captures, while demo owns synthetic payment responses and a disposable PostgreSQL database.
Document the actual local evaluation path and keep sandbox operations separate.

Provide an English introduction, architecture diagram, recorded dashboard GIF, judge guide, source-linked threat model, AI disclosure and accurate repository structure.
Reconcile only stale scope and structure descriptions in AGENTS.md.
Record project origin using repository history and official rules.

## Non-goals and constraints

No runtime or dependency changes, payment requests, model calls, trial activation, mobile setup, public hosting or issue closure.
Do not attribute the demo's policy/approval composition to the W0 proxy.
Do not claim synthetic tests establish live reliability or universal prompt-injection resistance.
The hosted URL and integrated live-sandbox judge flow remain unavailable; reference rather than close #22.

## Acceptance

1. A fresh clone in a new validation container runs frozen install and all four default demo scenarios within ten minutes after the documented toolchain prerequisites are ready.
2. Record timer boundaries, image/cache conditions, versions, decisions and payment counts; one measurement is not a guarantee.
3. A separately started dashboard preview displays real SQL results from synthetic fixtures; its GIF is an actual browser recording with a synthetic caption and static alternative.
4. Security claims identify source boundaries and verification references, including exclusions for compromised hosts/devices, upstream errors and direct provider bypass.
5. AI disclosure distinguishes optional Claude integrations from planned policy compilation and development assistance.
6. Local links, formatting, declared checks and hosted review pass; operator approval covers the final diagram and GIF before merge.

## Precedent

Oracle queried personal `spendwall` for `quickstart` and `threat model` at source commit `c1681868ac634e4b2414874716bb75a7864113c4`.
No relevant precedent was found; current-source freshness was unverified.
Current code and issue evidence determine this scope.
