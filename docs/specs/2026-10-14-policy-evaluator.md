# Deterministic policy evaluator

## Contract

Implement [issue #7](https://github.com/AndrewDongminYoo/spendwall/issues/7) on top of the [issue #6 loader](2026-10-14-policy-loader.md).
The operator authorized implementation, verification, and the PR workflow on 2026-10-14.
Reuse `LoadedPolicy` and the exact `@marcbachmann/cel-js@8.0.0` dependency.
No LLM, network request, clock, randomness, payment execution, or new dependency belongs in this evaluator.

Export `evaluatePolicy(policy, context)` and `normalizeAmount(amount)` from the existing package entry point.
Return an immutable `{decision, matchedRules, policyVersion}` result.
`matchedRules` contains the IDs of every successfully evaluated true condition in policy order.
An evaluation error can force denial even when other rules match.
The returned version is the loaded policy's content hash; it does not identify the FX table or evaluator deployment.

## Trusted context and tool permissions

The caller supplies a server-resolved context with `tool`, `args`, `amount`, `agent`, `customer`, `merchant`, and `agg`.
`agent`, `customer`, and `merchant` are objects with nonblank string `id` fields.
`args` and `agg` are objects, and empty objects are valid when no rule needs additional fields.
Additional JSON fields within these objects may be used by rules.
The evaluator does not authenticate these identities or obtain aggregation/payment facts; those remain the caller's responsibility in issues #8 and #9.
Passing untrusted agent claims as this context is outside the API contract.

Snapshot plain JSON data before evaluation.
Reject missing required fields, undefined values, nonfinite numbers, functions, accessors, cycles, sparse arrays, non-plain objects, and prototype-sensitive keys.
Bound the snapshot to depth 16 and 4,096 values, with a 64 KiB text budget.
Reject a caller-supplied `amount.usd`; compute it from the validated original amount instead.
Do not mutate the caller's objects.

Resolve the policy agent using `context.agent.id` and require an own entry.
Apply exact tool-name membership before evaluating any condition: an unknown agent, an explicit deny entry, or absence from the allow list returns `deny` with no matched rules.
A tool in both lists is denied.
Allow-list membership permits rule evaluation; it does not itself grant an `allow` decision.
There is no wildcard syntax.

## Rule evaluation and errors

Evaluate each eligible rule with the loader's prepared function and accept only primitive boolean results.
Combine true rules as `deny` > `require_approval` > `allow`, independent of rule order.
If no rule matches, return the deny-only policy default.
Any thrown error, nonboolean result, attempted missing-field access, nonfinite arithmetic result, or exhausted evaluation budget forces denial.
Observed logical operands must also be boolean; CEL can otherwise mask an invalid dynamic operand in `customer.vip || true` without throwing an error.

CEL can mask an evaluated error in a logical expression or quantifier.
The pinned library was directly observed returning true for `(1 / 0 > 0) || true` and `customer.missing == true || true`.
Extend loader preparation with a library macro that observes the existing runtime rather than interpreting expressions separately.
Use a fresh per-call observer, preserve the parsed AST privately, and retain the existing `condition(context)` behavior.
An optional fail-closed condition mode makes the policy evaluator reject observed errors even if CEL later produces true.
Prepare once while loading and reuse the prepared function for every call.
Do not modify a shared runtime object or replace the parser.

Preserve CEL short-circuiting: `true || (1 / 0 > 0)` does not attempt division and is valid.
`has(customer.optional)` is a presence check, so a missing final optional property produces false rather than an access error.
Missing required envelope fields are always rejected before CEL, including when a condition is simply true.
Limit each rule evaluation to 10,000 runtime node visits; this is a deterministic operation bound, not a wall-clock timeout.
Reject policy calls to the private `spendwall_observe` macro anywhere in the user AST, including unreachable branches and quantifier bodies, so policy text cannot create another evaluation budget.
Retain the original source-text, user-AST depth, and AST-size limits from #6, excluding the private observation wrapper.

## Demo amount normalization

Accept an amount object containing only `value` and `currency`.
`value` is a nonnegative canonical decimal string, without whitespace, signs, exponent notation, or redundant leading zeros.
USD and EUR accept up to two decimal places; KRW accepts integers.
Zero is valid for policy boundary tests; payment-specific positive-amount checks remain outside this pure evaluator.

Use these explicitly fictional demo rates, not market rates:

| Currency | USD per source unit |
| -------- | ------------------- |
| USD      | 1                   |
| EUR      | 1.10                |
| KRW      | 1 / 1,400           |

Parse source minor units as integers, use rational integer conversion, and round any fractional USD cent upward.
Expose the resulting USD number as `amount.usd` for existing CEL expressions.
Reject unsupported currencies, invalid precision, and values above the demo ceiling of USD 10,000,000 after conversion.
The ceiling bounds numeric representation and demo scope; it is not an authorization threshold.
For example, EUR 90.91 becomes USD 100.01 and KRW 140,001 becomes USD 100.01.
Any normalization failure produces an evaluator denial.

The explicit non-USD requirement in #7 takes precedence over the earlier USD-only recommendation in the initial roadmap review.
No production currency-conversion claim or live payment integration follows from this demo table.

## Acceptance and scope

1. At least 30 table-driven cases cover tool permissions, all decisions, precedence, rule order, no matches, amount boundaries, unknown currencies, and missing context.
2. Regression tests exercise masked logical/quantifier errors, unreachable error branches, presence checks, nonboolean results, repeated mixed contexts, operation-budget exhaustion, and unchanged caller data.
3. The existing loader suite remains green, including exact hash behavior, source paths, and 64/65 unary depth boundaries.
4. `pnpm check`, `pnpm install --frozen-lockfile`, `trunk check --all --no-fix`, and Compose configuration validation pass.
5. Local adversarial reviews and current-head hosted review/CI complete before the operator merge request.

Do not integrate the firewall, implement aggregation/context resolvers, edit issues, change unrelated README/AGENTS drift, contact PayPal, or change dependency versions.
This library change needs no visual approval.

## Precedent and design checkpoint

Oracle searches for CEL evaluation and currency normalization returned `[no precedent found]` at source commit `c1681868ac634e4b2414874716bb75a7864113c4`; source freshness remains `UNVERIFIED`.
The issue #6 loader's independent AST-depth guard remains necessary because its boundary tests and pinned-library behavior directly support it.
An Advisor checkpoint recommended observing only runtime paths actually evaluated by CEL and using a per-call error collector, while preserving short-circuiting and the existing condition API.
