# Policy YAML schema and loader

## Contract

Issue [#6](https://github.com/AndrewDongminYoo/spendwall/issues/6) introduces the policy input boundary in `packages/policy`.
The operator authorized implementation, verification, and the PR workflow on 2026-10-14.
The loader accepts YAML text without reading files, contacting payment services, or changing the running firewall.

Require `agents`, `rules`, and an explicit `default: deny`.
Each agent has `tools.allow` and `tools.deny` string arrays.
Each rule has a unique nonempty `id`, a nonempty CEL `when` string, and `then: allow | deny | require_approval`.
Empty agent maps, rule lists, and tool lists are valid deny-by-default starting points.
Reject unknown object fields, invalid field types, blank names, duplicate rule IDs, and prototype-sensitive agent IDs.
Do not coerce values or fill in missing authorization fields.

Accept a single YAML 1.2 document, at most 64 KiB of UTF-8 text.
Reject duplicate mapping keys, aliases, YAML warnings, and unsupported YAML versions.
Report YAML syntax/conversion failures at `$`, with line and column when available.
Report schema and CEL failures with a precise path such as `$.rules[0].when`.
Never return a partially loaded policy after an error.

## Shared CEL choice for issue 7

Use the exact `@marcbachmann/cel-js` version `8.0.0` for both preparsing and the future evaluator in [#7](https://github.com/AndrewDongminYoo/spendwall/issues/7).
The original [ChromeGG/cel-js](https://github.com/ChromeGG/cel-js) repository is archived and its README points to [this alternative](https://github.com/marcbachmann/cel-js).
The installed alternative exposes `Environment.parse`, which returns a reusable expression function and rejects lexical errors or trailing input.
Its actual API is checked with the issue #7 context names `tool`, `args`, `amount`, `agent`, `customer`, `merchant`, and `agg`.
Dynamic values remain allowed because the trusted context resolver and evaluator are separate issues.

Preparse every condition with one private CEL environment and no application-provided functions.
Limit each expression to 4,096 characters, parser depth to 64, and AST nodes to 4,096.
Independently limit AST depth to 64 edges because the parser's depth counter does not cover unary chains.
Traverse AST operands iteratively so the validation itself cannot exhaust the call stack.
Return a condition function beside each rule so #7 can evaluate the already parsed expression with its own trusted context.
Hide the parser's mutable AST and environment behind that function.
This is syntax validation, not proof that an expression returns a boolean or that required runtime fields exist.
The future evaluator must accept only boolean results, treat evaluation errors as denial, and implement the issue #7 combination and tool-list rules.
JavaScript numbers are CEL doubles and CEL integer literals are bigint values; compatibility tests cover comparisons used by the intended context.

## Output and policy version

Export `policySchema`, its inferred `Policy` type, `LoadedPolicy`, and `loadPolicy(source)` from the policy package entry point.
Return the validated fields, compiled rule conditions, and a lowercase hexadecimal SHA-256 `policyVersion`.
Freeze the returned policy data, nested objects, arrays, and rule records so their behavior cannot change under a saved version.
Hash canonical JSON of the validated policy before adding compiled functions.
Sort object keys recursively and preserve array order and exact string contents.
YAML comments, formatting, quoting style, and mapping order do not change the version.
Rule/list order, condition text, identities, permissions, decisions, and default values are part of the hash.
The version identifies policy content, not a full evaluator deployment or an approval signature.

## Dependencies and scope

Use Zod `4.6.6`, already present elsewhere in the workspace, as an explicit policy dependency.
Use `yaml` `2.9.1` for the document parser and diagnostics because Node has no YAML parser.
The CEL dependency avoids inventing an expression language.
Use Node's built-in SHA-256 implementation and test runner.
Declare the existing Node type package version for strict type checking.

No policy evaluation/combination, money normalization, aggregation, live reload, approval binding, storage, or firewall integration is included.
Do not update unrelated README or roadmap drift as part of this issue.

## Acceptance

1. Valid policies load and each returned condition can evaluate representative #7 contexts through the selected CEL implementation.
2. Invalid YAML, schemas, aliases, duplicate IDs, unsafe defaults, and malformed CEL fail with the affected path.
3. Hashes are identical for equivalent YAML representations and change for policy-content changes.
4. Mutating returned policy data cannot invalidate its saved version or alter the compiled condition.
5. `node --test tests/policy-loader.test.mjs`, `pnpm check`, a frozen install, Trunk, and Compose configuration validation pass.

## Precedent

Oracle found no direct project precedent for CEL or policy loaders: `[no precedent found]`.
The global `wiki/concepts/plan-audit-verify-against-code.md`, backed by `.claude/skills/plan-audit/SKILL.md`, supports checking the named library against actual parser/evaluator behavior.
That precedent confirms the compatibility-test approach, not the dependency choice.
Provider source commit: `c1681868ac634e4b2414874716bb75a7864113c4`; current-source freshness: `UNVERIFIED`.
