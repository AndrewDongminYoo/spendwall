# Initial roadmap review

## Verified requirements

The [official hackathon page](https://paypalaihackathon.devpost.com/) lists the deadline as November 12, 2026 at 12:00 PST, equivalent to November 13 at 05:00 KST.
It requires meaningful PayPal and AI integration, a public licensed repository, a working demo or complete setup instructions, and a video under three minutes.

The [AG Grid sponsor page](https://paypalaihackathon.devpost.com/details/aggrid) offers a 45-day trial and emphasizes AG Studio customization and the Studio Agent Framework.
Starting a trial on October 26 does not cover the entire proposed December 1–15 judging window; confirm an extension with the sponsor before depending on a hosted demo.
The judging window comes from the proposed roadmap and was not independently verified in this review.

## Recommended W0 checks

The [PayPal MCP quickstart](https://developer.paypal.com/ai-tools/mcp-server) documents both `/sse` and `/http` sandbox transports.
Try Streamable HTTP first and retain SSE as a compatibility fallback if the spike requires it.

Dump the actual tool schemas and verify whether the refund tool exposes a caller-controlled `PayPal-Request-Id`.
The [REST request guide](https://developer.paypal.com/api/make-api-requests/) documents idempotency headers, but this does not prove the MCP tool forwards them.
If it cannot, explicitly decide how approved money-moving calls will reach REST with a durable request ID.

Use the token response's `expires_in` to schedule renewal, rather than assuming a fixed nine-hour lifetime.
See [PayPal authentication](https://developer.paypal.com/api/rest/authentication/).

## Recommended core constraints

- Bind approval to normalized arguments, resolved amount and currency, merchant identity, and policy version.
- Use integer minor units and initially require USD rather than silently converting currencies.
- Reserve pending amounts atomically with velocity evaluation; enforce tenant and merchant ownership before reading or executing captures.
- Separate human approval from execution state, including in-flight, succeeded, failed, and unknown outcomes.
- Preserve reservations for unknown upstream results until reconciliation establishes the outcome.
- Verify webhook signatures and deduplicate event IDs before marking unmediated activity.
- Treat local biometric success as an interface control; require authenticated and authorized approval at the server.

These are recommendations for follow-up issues, not features implemented by the scaffold PR.
