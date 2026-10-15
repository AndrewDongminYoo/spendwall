# Read-only payment oversight dashboard

## Contract

Implement [issue 17](https://github.com/AndrewDongminYoo/spendwall/issues/17) as a local, authenticated AG Studio dashboard over persisted firewall audit data.
Follow the provider/data/report/theme integration demonstrated by the [PayPal boilerplate](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate/tree/5de114eb4306e844396022f9ca0558a4937761e2).
Do not copy its PayPal credential access or optional AI proxy.
The existing empty React package needs React, AG Studio, and a bundler; Vite supplies a static build without adding a second application server framework.

Expose read-only `GET /audit` and `GET /stats` through a dedicated loopback server.
An explicit operator bearer token authenticates access to one configured merchant; it is distinct from agent keys and never grants payment or approval rights.
Reject foreign Host/Origin, query parameters, methods, and missing/incorrect credentials before database reads.
The browser holds the supplied token only in memory and clears all loaded data on disconnect or failed refresh.
Serve the built dashboard and API from the same origin, with no cross-origin grants.

Read one bounded, repeatable, read-only PostgreSQL snapshot per request using the existing audit metadata and approval tables.
Preserve the existing 10,000-row history limit and fail explicitly on overflow or malformed lifecycle data.
Use existing velocity folding for reservation amounts, including pending reservations older than 24 hours.
Never expose sealed approval payloads, payment credentials, raw arguments, customer identifiers, or context objects.
Show decision counts from original tool calls, rule blocks from deny calls, and execution amounts only from confirmed succeeded approval executions.
An allowed/reserved amount is not evidence of a completed payment.
Pending approvals must exclude expired and processed requests.

## Widgets and meaning

Show confirmed money-out by hour, allow/approval/deny distribution, blocked rule references, agent denial rates, and pending approvals.
Historical rules retain their policy version and canonical positional reference; do not guess the original rule name.
A registered custom AG Studio widget shows agent reservation utilization against an explicitly configured monitoring budget.
Label this budget as a monitoring reference, not an inferred CEL policy limit or an enforcement control.
Unknown agent names use safe pseudonymous audit labels.
No policy, approval, payment, or report persistence mutation is exposed.

## Design contract

Audience: a merchant operator checking payment activity and approval backlog.
Use a light, quiet operational canvas with dark ink, green confirmed activity, amber pending activity, and red denials.
Use shared CSS tokens for the shell and Studio theme, locally available sans-serif typography, tabular monetary figures, a 24-column desktop report, and a single-column narrow report.
Prioritize pending approval count, confirmed amount, and data freshness above the analytical report.
Provide labeled connection fields, keyboard focus, loading, empty, and unavailable states.
Refresh is explicit; no motion is necessary.
Original API data remains authoritative and no generated prose appears here.

## Verification and limits

HTTP and actual PostgreSQL tests must establish authorization, merchant separation, read-only behavior, deduplication, expiry, uncertainty, and bounded failure.
Browser checks must render the actual AG Studio widgets and custom theme over a disposable database populated through existing services, including refresh, error, empty, and narrow states.
Synthetic seeded payment outcomes are not live PayPal verification.
Operator visual approval is required for the final candidate.
The operator confirmed no trial license has been issued.
[AG Studio installation guidance](https://www.ag-grid.com/studio/react/installation/) permits local evaluation without a license; deployment, license acquisition, and judging-period validity remain unverified and are not claimed complete.
The [license guidance](https://www.ag-grid.com/studio/react/enterprise-licence/) requires a license for deployment.
No external AI or payment request is part of this task.
