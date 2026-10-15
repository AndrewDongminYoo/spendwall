# Natural-language audit queries

Issue: https://github.com/AndrewDongminYoo/spendwall/issues/18

## Contract

Add an AG Studio Agent Framework custom runner to the authenticated dashboard.
Reuse the existing server-side Claude Messages integration pattern without adding a dependency.
Claude receives only the current question and the supported intent descriptions, never audit records, credentials, prior conversation, or payment tools.
Validate its structured answer against three fixed intents or an unsupported result.
The server owns SQL, time boundaries, amounts, agent selection, and result schemas.

- `이번 주 $100 넘는 환불 시도 보여줘`: original tracked attempts strictly above USD 100, from Monday 00:00 UTC through the database snapshot.
- `차단 사유별로 묶어줘`: original denials over the last 24 hours, grouped by policy version and canonical rule position; missing references stay explicitly unreferenced.
- `support-bot 한도 소진 추이`: hourly reservation balances over the last 24 hours, including older pending reservations and actual releases, compared with the current configured monitoring budget.
  Resolve the configured agent ID `support-bot` first, otherwise the unique display name whose case-insensitive letters equal `supportbot` after removing spaces and hyphens.
  Missing or ambiguous identity or missing budget returns unavailable, not a fabricated zero.

Reservations are not confirmed payments, and monitoring budgets do not enforce policy.
The trend uses the current budget as a reference, not a claim about historic policy limits.
Unsupported periods, thresholds, agents, write requests, and follow-ups without a complete question are declined.
Repeated queries replace one result widget with a stable ID; results and conversation remain tab-local and clear on refresh or disconnect.

## Boundaries

Keep the existing loopback host/origin, bearer authentication, key continuity, merchant scope, lifecycle validation, bounded rows, and read-only transaction boundaries.
Bound POST bodies, provider duration and response size, and concurrent requests.
Do not keep a database connection while waiting for Claude.
No arbitrary SQL, model-generated widgets, payment APIs, model tools, retries, persistent chat, license issuance, or deployment.
Claude is explicitly configured in the private dashboard configuration; absent configuration disables query execution.
Synthetic preview uses an explicitly labelled deterministic provider substitute and makes no model requests.

## Acceptance

1. All three queries produce deterministic typed data and stable widget definitions on repeated runs.
2. Tests cover week and USD boundaries, policy-version grouping, reservation release and expiry windows, missing configuration, invalid model output, auth, origin, and data continuity failures.
3. Actual Studio harness execution updates the rendered result on desktop and mobile without duplicate widgets or stale results after failure/cancellation.
4. Declared repository checks and frontend build pass; mocked-provider evidence is distinguished from live Claude verification.
5. Operator approves the final rendered candidate before merge.

## Evidence and precedent

The installed AG Studio 3.0.0 API and https://www.ag-grid.com/studio/react/ai-custom-runner/ support an application-owned runner with explicit run events.
Oracle returned account-neutral verification guidance from `wiki/concepts/plan-audit-verify-against-code.md`: compare model conclusions against actual data and stable identity.
This confirms deterministic server aggregation and widget replacement.
Oracle retrieval was partial and freshness unverified; no direct Spendwall agent-framework precedent was found.
