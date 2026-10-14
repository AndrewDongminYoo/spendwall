# Agent Authentication Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline with TDD and one independent final review.

**Goal:** Authenticate agent keys without persisting plaintext and enforce tool visibility and dispatch allowlists.

**Architecture:** A small auth module validates immutable principals from hash-only storage. A parameterized SQL adapter supports persistent agents/keys. Existing stateless MCP request handlers enforce access and a fail-closed approval lookup.

**Tech Stack:** Node 24.21.0, pnpm 11.24.0, strict TypeScript, built-in crypto/test runner, existing MCP SDK/NestJS.

**Spec:** `docs/specs/2026-10-14-agent-auth.md`.

## Global constraints

- No policy/resolver duplication, audit/velocity/PR37 changes, external keys, real API calls, production DB changes, deployment or merge.
- Preserve token `expires_in`/start-time margin/coalescing and refund ID/body retry semantics.
- No new dependencies; frozen install and lint/types/tests/Trunk/Compose checks.

## Review focus

- Store errors and malformed rows must deny without leaking secrets.
- Key/allowlist rotation must affect the next HTTP request; client metadata cannot impersonate another agent.
- Listing concealment must also block forged calls, including refund and approval dispatch.
- Approval lookup output cannot expose foreign ownership, custom payloads or credentials.
- Textual and nested Authorization headers and expired-token errors must not reach downstream/logs.

### Task 1: Hash-only authentication boundary

Files: `apps/firewall/src/auth.ts`, `apps/firewall/src/agent-key-store.ts`,
`apps/firewall/src/agent-auth-schema.sql`, `tests/agent-auth.test.mjs`.

Interfaces: `AgentKeyStore.findByHash(hash): Promise<unknown>`,
`insertKey({agentId,keyHash}): Promise<void>`; `authenticateAgent(store, header)`
returns immutable `AgentPrincipal | null`; `issueAgentKey(store, agentId)`
returns the raw key only after hash insertion succeeds.

- [ ] Write tests for hash-only issuance/SQL parameters, invalid/revoked/disabled keys, immutable principal, DB failures and safe errors.
- [ ] Run tests and observe missing auth implementation failure.
- [ ] Implement key format/validation, constant failure semantics and parameterized SQL adapter/schema.
- [ ] Run auth tests and strict typecheck; commit the boundary.

### Task 2: Tool access and approval contract

Files: minimally modify `apps/firewall/src/server.ts`; create
`apps/firewall/src/approval-tool.ts`; extend `tests/refund-proxy.test.mjs`.

Interfaces: `startProxy({agentKeys?, approvalLookup?})`; lookup receives
`{agentId, approvalId}` and returns matching identity plus bounded status.

- [ ] Add failing real SDK tests for two agents' visibility, forged calls, metadata impersonation, rotation, no legacy fallback and safe approval output.
- [ ] Observe failures before implementation.
- [ ] Enforce immutable authenticated principal, allowlist-before-dispatch and local approval handling.
- [ ] Run proxy/auth/refund suites; verify legacy single-agent compatibility and stable refund retries.

### Task 3: Sensitive results and delivery

Files: `apps/firewall/src/token.ts`, optional focused scanner helper,
tests in `tests/refund-proxy.test.mjs` and `tests/refund-execution.test.mjs`,
`docs/agent-auth.md` and authentication notes in `docs/proxy.md`.

- [ ] Add failing nested/textual Authorization and log-capture tests.
- [ ] Implement minimal sensitive-result guard; preserve timing/retry behavior.
- [ ] Document hash-only DB port, legacy mode, trusted identity integration and deferred #12/audit wiring.
- [ ] Run full checks and independent read-only review; fix substantive findings with RED→GREEN tests.
- [ ] Commit/push, publish normal PR, inspect exact-head CI and bounded automatic review; stop after #10.
