# Git-history secret scan plan

## Owned scope

Use the main workspace on a task branch.
Change this spec, this plan, one dated evidence note and the directly affected judge-guide section.
Keep temporary scanner inputs, mirror and redacted reports outside the repository.
No runtime or dependency changes are planned.

## Sequence and verification

1. Resolve the existing scanner and explicit configuration.
   Record binary hash and actual version output, and inspect Git-mode flags.
2. Build a temporary synthetic Git history whose current tree no longer contains the marker.
   Verify the history scan detects it and a current-tree scan does not.
   Use an additional merge-only fixture if needed to verify the chosen merge-diff behavior.
3. Fetch a fresh bare mirror, enumerate its exact refs and verify it is non-shallow.
   Run the same redacted history scan and inspect the complete result without exposing match text.
4. Write observations with the exact snapshot, method, limits and any unresolved findings.
   Correct the judge guide only where the evidence changes its claims.
5. Run scoped formatting, claim/link review, declared gates and hosted review.
   Commit documentation by concern and request operator merge.
6. Remove only task-owned temporary repositories after preserving sanitized evidence.
   Retain the visible review receipt and reports through post-merge cleanup.
