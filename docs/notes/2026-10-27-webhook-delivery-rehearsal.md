# Sandbox webhook delivery rehearsal

## Scope and revision

On October 27, 2026, between 05:13 and 05:35 UTC, one real PayPal sandbox webhook delivery reached the local reconciliation receiver for [#19](https://github.com/AndrewDongminYoo/spendwall/issues/19).
The runtime was `main` at `34ded1ce5ce65c34f404c126d847a82029ad1e93` under Node 24.22.1; no runtime file changed for the run, and this evidence PR changes documentation only.
The public ingress was a temporary Tailscale Funnel on this Mac mini, not the hosting work of #20 and not a deployment configuration.
The run covers one refund event from one sandbox app; it does not prove that every bypass or every PayPal event type is detected.

## Setup

A disposable `postgres:17-alpine` container received migrations `001`, `002`, `003`, `011` and `007` as the owner.
The receiver logged in as a separate role that held only the group from `reconciliation.receiver_role()`, and the startup role check accepted it.
The local dashboard logged in as a role that held the application group, as the dashboard test fixture does; a deployment should use the dedicated reader that the [webhook guide](../webhooks.md#read-the-dashboard) describes.
Both private configurations used one random identity key, the sandbox business account's merchant ID, and an adapter reference computed from the sandbox client ID; they were stored outside Git with mode 0600 and deleted after the run.
`node scripts/webhooks.mjs` listened on `127.0.0.1:4402` and `node scripts/dashboard.mjs` on `127.0.0.1:4400`.
A sandbox webhook subscription, `23D43099GD331152S`, was created for `PAYMENT.CAPTURE.REFUNDED` only.

## Ingress Host requirement

The receiver accepts only its own loopback `Host` (`apps/firewall/src/webhooks/server.ts`), and Tailscale Funnel forwards the public host name.
Through Funnel pointed directly at port 4402, a request without PayPal headers returned 403.
Sent locally, the same request returned 403 with the public `Host` and 400 with `Host: 127.0.0.1:4402`, so the 403 came from the Host check, before signature verification.
A real delivery through that route would therefore also have been refused.

For the rest of the run, Funnel pointed at a rehearsal-only shim on `127.0.0.1:4403`.
The shim accepted exactly one `Host` header equal to the Funnel host name, replaced it with `127.0.0.1:4402`, removed hop-by-hop headers and forwarded the request unchanged otherwise.
The shim was not committed; it is test infrastructure, like the harness in the [judge guide](../judge-guide.md#rehearsal-evidence).

## Forged signature

At 05:17:34 UTC a refund event with a PayPal-host certificate URL and a fabricated transmission signature was sent to the public URL.
The receiver forwarded it to the sandbox verification endpoint and answered 401, which the code returns only when the verification status is `FAILURE` (`apps/firewall/src/webhooks/paypal.ts`).
Afterwards the database held zero refund observations and zero execution receipts.
The focused tests already covered this path with a stubbed provider; this run adds one observation against the real sandbox verification endpoint.

## Direct-dashboard refund

The operator signed in to the sandbox business account and refunded seeded capture `4YM00645KJ797323T` (USD 5.00) from the PayPal dashboard.
The dashboard showed refund transaction `0VK69001115561627` at 1:24:49 AM EDT (05:24:49 UTC).
PayPal's event list showed `PAYMENT.CAPTURE.REFUNDED` event `WH-857686969R399190P-68N071919S8595535`, created at 05:24:53 UTC for that refund.
The delivery reached the receiver at 05:25:08 UTC and was answered with 200 after signature postback and capture lookup.
The database then held one observation of 500 cents, received at 05:25:08.738 UTC, and no execution receipt; a later capture read returned `REFUNDED`.

The dashboard `/stats` report listed the observation as `pending` at 05:25:38 UTC and as `unmediated`, with no linked audit event, at 05:30:23 UTC.
The browser panel then showed `1 observations need review` and one `Unmediated · review needed` row for USD 5.00.
The screenshot was reviewed but not committed.
As the [webhook guide](../webhooks.md) states, `unmediated` is an evidence gap: here it is expected, because the refund was made outside the firewall.
The `matched` path was not exercised with a live delivery in this run.

## Teardown

Funnel was turned off, and `tailscale funnel status` reported no serve configuration.
The subscription was deleted (HTTP 204), and a later list returned no subscriptions for the app.
The receiver, dashboard and shim were stopped, nothing listened on ports 4400 to 4403, and the database container and private configurations were removed.
