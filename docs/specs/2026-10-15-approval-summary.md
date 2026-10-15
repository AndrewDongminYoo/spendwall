# Display-only approval summaries

## Contract

Implement [issue 16](https://github.com/AndrewDongminYoo/spendwall/issues/16) without adding generated text to policy evaluation or approval binding.
The authenticated human approval API exposes `POST /approvals/:id/summary` with an empty JSON object.
Only the owning agent's authenticated approver can request it.
Existing detail, pending-list, and decision routes do not call or wait for a model.

The server loads the original sealed approval facts and an application-supplied redacted support-text excerpt for that approval.
Send only capture, amount/currency, and safe identity IDs as trusted context.
Keep agent reason and ticket excerpt in a separately named, JSON-encoded untrusted data object, outside system instructions.
Do not forward raw context attributes, credentials, hashes, provider responses, or whole tickets.

## Output and limits

Return two or three short sentence strings and a bounded list of advisory risk flags.
Every result includes `advisory: true`; successful output is labeled `AI-generated reference only; not authorization` and must be rendered as plain text below original facts in future clients.
The available flags describe instruction-like content, conflicting payment claims, and pressure to approve.
They are model observations, not verified facts or authorization.
Schema validation does not enforce semantic truth or prompt compliance; even model prose that claims authorization cannot change stored facts, hashes, or decisions.
Unknown fields, malformed content, refused/truncated output, loader/provider failures, and timeouts return a generic unavailable result without leaking errors.

Generation is opt-in through server composition.
The Claude Messages HTTP adapter requires an explicit API key and model, uses no tools, performs no automatic retries, and bounds its response body.
A per-server bounded cache coalesces repeated requests and retains failures until restart, limiting one attempt per approval per process.
At most four generations can run concurrently; a full cache or occupied capacity returns unavailable.
This is a prototype cost bound, not a distributed quota.
Only pending approvals can start generation.

## Acceptance

- An injection-ticket fixture produces advisory risk flags through the real authenticated HTTP boundary with a synthetic model response.
- Altered support text cannot replace stored capture/amount or change the approval hash.
- Missing/foreign authentication performs no loader or model calls.
- Concurrent repeats perform one model call; malformed output and timeout are unavailable.
- A pending or failed summary cannot block a valid approval decision or execute a payment by itself.
- No paid model, real payment, device, or production migration is required for tests.

## Sources and scope

The [Messages API](https://platform.claude.com/docs/en/api/messages/create) supplies a separate system field and user messages.
The [structured-output contract](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) supplies JSON schema output; local validation remains required.
Oracle found no direct Spendwall precedent.
Its account-neutral `wiki/concepts/source-verified-output.md` confirms that generated claims must remain distinct from trusted facts.
The prior demo approval fix is preserved: original payment details and their bound hash remain the source for a human decision.
Flutter rendering, background summary queues, persistent summary storage, production deployment, and live model quality evaluation are outside this issue.
