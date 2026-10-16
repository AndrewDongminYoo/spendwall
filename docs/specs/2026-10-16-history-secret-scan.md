# Git-history secret scan

## Goal and scope

Complete a bounded repository-history scan for the secret-exposure checklist in issue #25.
Reuse installed Gitleaks without dependencies, runtime changes, new hooks or a deployment.
The evidence covers one recorded snapshot of advertised Git refs, not the complete submission checklist.

## Contract

- Use a fresh bare mirror of the verified personal repository to avoid untracked local credentials and stale local refs.
- Record all fetched ref names and object IDs, the default-branch revision, shallow status, scanner identity/hash, effective configuration and exit status.
- Scan reachable Git history with explicit full-history and merge-diff options.
  Use built-in rules through an explicit configuration, no baseline or additional fingerprint exclusions, and ignore inline allow comments.
- First prove the same command detects a synthetic credential committed and later deleted in an independent temporary repository.
  Confirm a clean tip alone is insufficient and retain only redacted control evidence.
- Never print credential values or publish raw findings.
  If findings appear, preserve only sanitized rule, commit and location evidence and report the scan as failed until each item has a supported disposition.
- Do not rotate credentials, rewrite history, mutate another PR or alter issue state within this task.
- Report scanner coverage limits, including unsupported formats, built-in allowlists, binary/media content, inaccessible or unreachable objects and ref movement after the snapshot.
  Do not claim that zero findings prove that no secret exists.

## Acceptance checks

1. Scanner identity and ref snapshot → verify installed version/configuration/hash, fresh mirror refs, non-shallow Git metadata and reachable history count.
2. Detection mechanism → verify the synthetic deleted-credential fixture exits with the configured finding status, while its current clean tree does not produce that finding.
3. Actual history → verify process completion, report parseability and sanitized findings for the recorded refs without omitted scanner errors.
4. Publication → verify exact documentation claims and local links, declared project gates, and current-head CI/code/security review.

## Exclusions

Video, screenshots, external uploads, hosted token renewal, AG Studio licensing and Devpost submission remain unverified.
This task does not close #25.
