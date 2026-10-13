# PayPal MCP discovery

## Problem

Issue #3 needs the actual sandbox tool names and input schemas before policy rules and contextual amount resolution can be implemented.
A public catalog or a mock response cannot establish the deployed server's contract.

## Scope

Use the issue's `@modelcontextprotocol/sdk` SSE client to authenticate against the fixed PayPal sandbox endpoint and collect every `tools/list` page.
Reuse the sandbox OAuth request without printing credentials or access tokens.
Save a complete snapshot to `docs/paypal-mcp-tools.json` only after discovery succeeds.
Document every returned tool in `docs/tool-risk.md` with its risk category, amount inputs, and required authoritative context.

## Constraints

- Never call payment tools; only initialize the session and list tools.
- Restrict authenticated requests to the fixed sandbox REST and MCP origins, with redirects rejected.
- Bound discovery to 60 seconds and at most 100 pages.
- Reject empty catalogs, duplicate tool names, and repeated pagination cursors.
- Close the transport after success or failure and preserve the previous snapshot on failure.
- Treat descriptions and annotations as evidence for manual review, not an enforcement policy.
- Preserve the existing token check's API and safe output.

## Acceptance

1. A real authenticated SSE snapshot is committed with acquisition time and page count.
2. Every snapshot tool has exactly one reviewed classification row.
3. Amount and currency paths distinguish direct inputs, optional inputs, and IDs requiring context lookup.
4. Tests exercise the real SDK transport against a local synthetic server, pagination failure cases, bounded waiting, and safe errors.
5. The repository checks pass with a regenerated, frozen-installable lockfile.

## Non-goals

Tool execution, seed payments, the proxy service, policy enforcement, and token caching belong to later issues.
