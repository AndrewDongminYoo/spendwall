# Live audit query rehearsal

## Scope and revision

On October 27, 2026, between 06:37 and 06:45 UTC, the three fixed audit questions of [#18](https://github.com/AndrewDongminYoo/spendwall/issues/18) were sent repeatedly to the dashboard with a real Claude classifier.
The runtime was `main` at `6f672b3699ab8481a36e5ba227160c47930a414d` under Node 24.22.1; no runtime file changed for the run, and this evidence PR changes documentation only.
Payments, ledgers and audit history were synthetic.
The run does not cover paraphrased questions, other model versions or the demo video of #23.

## Method

An uncommitted harness started a disposable `postgres:17-alpine` container and the `dashboardFixture` from `tests/helpers/dashboard-fixture.mjs`.
It configured the server with `queryMode: 'claude'` and `classify: claudeQuery({ apiKey, model })`, the same adapter that `pnpm dashboard` builds from a `claude` configuration.
It seeded the same refund history as `pnpm dashboard:preview`, without the reconciliation and policy-preview data.
The API key came from the process environment and was not recorded.

For each fixed question, the harness sent `POST /query` the given number of times in a row and recorded the HTTP status, the intent and a digest of the returned widget data.
The digest covered `intent`, `title`, `columns` and `rows`.
It left out `as_of`, `note` and `rows[].hour`, because they contain the snapshot time or hourly sample instants that move with the clock.
Each run used a new database, so digests are compared only within one run.
After the fixed questions, each run sent one unsupported control question, `오늘 날씨 알려줘`.

## Results

| Model               | Runs per question | `이번 주 $100 넘는 환불 시도 보여줘` | `차단 사유별로 묶어줘`              | `support-bot 한도 소진 추이`        | Control |
| ------------------- | ----------------- | ------------------------------------ | ----------------------------------- | ----------------------------------- | ------- |
| `claude-sonnet-5-5` | 10                | 10 × 200 `weekly_refunds`, 1 digest  | 10 × 200 `denial_reasons`, 1 digest | 10 × 200 `support_budget`, 1 digest | 422     |
| `claude-haiku-5-5`  | 5                 | 5 × 200 `weekly_refunds`, 1 digest   | 5 × 422 unsupported                 | 5 × 200 `support_budget`, 1 digest  | 422     |

The `claude-sonnet-5-5` run lasted from 06:40:18 to 06:41:15 UTC, and each request took 1,024 to 4,782 ms.
An earlier three-run pass with the same model gave the same result.
The `claude-haiku-5-5` run lasted from 06:42:32 to 06:42:54 UTC.
Two earlier `claude-haiku-5-5` passes (one and five runs) also classified `차단 사유별로 묶어줘` as unsupported every time, 11 of 11 in total.
Those passes used a digest that still included the time fields, so only their intents are cited here.

## Browser check

The same harness then served the dashboard with `claude-sonnet-5-5`, and the assistant badge read `Claude · read-only`.
Each of the three prompt buttons was clicked twice.
Both weekly answers showed `Refund attempts above $100 · this week` with one row, both denial answers showed one row, and both support answers showed 25 hourly samples in the `Support bot reservation trend · USD` chart.
Each answer replaced the single result area.
The screenshot was reviewed but not committed.

## Interpretation

With `claude-sonnet-5-5`, the three fixed questions produced the same intent and the same widget data on every repeated run.
With `claude-haiku-5-5`, the denial question was refused every time, so that model cannot run the three-question demo as configured.
The classifier prompt was not changed.
The project still has no default paid model; a demo configuration must name its model explicitly.

## Cost and teardown

The paid requests were 47 to `claude-sonnet-5-5` (10, 31 and 6 for the browser check) and 36 to `claude-haiku-5-5` (4, 16 and 16).
No PayPal request was made.
After the run, no `spendwall-live-query-` container remained.
