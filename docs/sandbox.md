# PayPal sandbox setup

## Accounts and app

Use the personal project account in the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/).
Keep work-account credentials separate.
Select Sandbox for all steps.

1. Open Sandbox > Accounts and create or verify a Business account for the merchant and a Personal account for the buyer.
2. Select United States for both accounts, as required by [issue #2](https://github.com/AndrewDongminYoo/spendwall/issues/2).
3. Open Apps & Credentials > Sandbox and create a REST app associated with that merchant.
4. Store its client ID and secret locally as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
5. Keep buyer credentials separate from REST app credentials; buyer login is used for checkout approval.

PayPal documents the two account roles and account creation in its [sandbox account guide](https://developer.paypal.com/sandbox-testing/accounts).
The US selection is this project's test configuration, not a claim that every other country is unsupported.

## App feature checks

For the card-based seed path in issue #4, check Apps & Credentials > Sandbox > the app > Features > Accept payments > Advanced Credit and Debit Card Payments.
PayPal describes this feature and sandbox onboarding in its [advanced card integration guide](https://developer.paypal.com/platforms/checkout/advanced/integrate).
Confirm the actual app setting before using that seed path.
If unavailable, issue #4's fallback uses sandbox buyer approval.
OAuth success does not prove card-payment eligibility, successful captures, refunds, or MCP tool access.

## Verify token issuance

From the repository root, with the two variables already exported, run:

```sh
node scripts/check-paypal-sandbox.mjs
```

Load credentials privately in your local shell or secret manager before running the command.
Do not paste credentials into shell command arguments, issue comments, PRs, fixtures, or agent prompts.
Do not print credential files or enable HTTP debug output.
Commit only blank examples.

The command sends a single `client_credentials` request with HTTP Basic authentication to the fixed sandbox endpoint.
It rejects redirects and aborts the request after 15 seconds.
The access token stays in process memory and is discarded on exit.
Only safe metadata is printed, for example:

```json
{ "environment": "sandbox", "token_type": "Bearer", "expires_in": 120 }
```

This example is illustrative, not a recorded live result.
Use the returned `expires_in`; do not assume a fixed token lifetime.
PayPal specifies the endpoint, authentication, and expiry behavior in its [authentication guide](https://developer.paypal.com/api/rest/authentication/).

## Failure and completion checks

- Missing variables: set both credentials locally, then rerun the command.
- HTTP 401: verify that the ID and secret belong to the same Sandbox app.
- Network failure or timeout: check connectivity and rerun deliberately; the command does not retry automatically.
- Invalid response: keep the issue open and investigate without publishing response bodies.

Before closing issue #2, record the date and safe command result in the PR and confirm the account configuration in Dashboard.
Unit tests use synthetic responses and cannot establish real token issuance.
Issue #3 must separately verify live MCP discovery with the app's token.
