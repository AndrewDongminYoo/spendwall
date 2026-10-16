import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { InvoicePolicy } from '../apps/firewall/src/invoices/index.ts';
import { AuditLog, verifyAudit } from '../apps/firewall/src/audit/index.ts';
import { checkHostedReader } from '../apps/firewall/src/dashboard/hosted-reader.ts';
import { checkWebhookReceiver } from '../apps/firewall/src/webhooks/reconciliation.ts';
import { loadPolicy } from '../packages/policy/src/index.ts';
import { dashboardFixture } from './helpers/dashboard-fixture.mjs';
import {
  key,
  trusted,
  draft,
  send,
  resolver,
} from './helpers/invoice-fixture.mjs';
const url = process.env.AUDIT_TEST_DATABASE_URL;
const source = await readFile(
  new URL('../apps/agent-demo/invoice-policy.yaml', import.meta.url),
  'utf8',
);
const policy = loadPolicy(source);
const migration = await readFile(
  new URL('../migrations/008-invoice-policy.sql', import.meta.url),
  'utf8',
);

test(
  'invoice policy composition enforces amount, recipient, atomic reservations and immutable retries',
  { skip: !url },
  async (t) => {
    const f = await dashboardFixture(url, undefined, {
      reconciliation: { adapterRef: 'a'.repeat(64) },
    });
    t.after(async () => {
      await f.owner.query('DROP SCHEMA IF EXISTS invoice_policy CASCADE');
      await f.close();
    });
    await f.owner.query(migration);
    const service = new InvoicePolicy(f.app, {
      identityKey: key,
      resolver: resolver(),
    });
    const counts = async () =>
      (
        await f.app.query(
          'SELECT (SELECT count(*)::int FROM invoice_policy.decisions) AS decisions, (SELECT count(*)::int FROM audit.audit_events) AS audits',
        )
      ).rows[0];
    await t.test(
      'valid drafts do not spend send slots; cap and exact domain use verified facts',
      async () => {
        for (const [value, recipient, expected, rule] of [
          ['100.00', 'buyer@example.invalid', 'allow', null],
          ['100.01', 'buyer@example.invalid', 'deny', 'invoice_amount_cap'],
          ['25.00', 'buyer@evil.invalid', 'deny', 'invoice_recipient_domain'],
          [
            '25.00',
            'buyer@sub.example.invalid',
            'deny',
            'invoice_recipient_domain',
          ],
          ['25.00', 'buyer@EXAMPLE.INVALID', 'allow', null],
        ]) {
          const result = await service.evaluateAndReserve(
            policy,
            draft(value, recipient),
            {
              ...trusted(recipient),
              customer: {
                ...trusted(recipient).customer,
                email_domain: 'example.invalid',
              },
              agg: { invoice_send_count_day: -99 },
            },
          );
          assert.equal(result.decision, expected);
          assert.equal(result.dispatchAllowed, expected === 'allow');
          assert.ok(result.receipt?.id);
          if (rule) assert.ok(result.matchedRules.includes(rule));
        }
        const mismatch = await service.evaluateAndReserve(
          policy,
          draft('1.00', 'other@example.invalid'),
          trusted(),
        );
        assert.equal(mismatch.dispatchAllowed, false);
        assert.equal(mismatch.reason, 'invoice_unavailable');
        const unsupported = draft();
        unsupported.args.currency_code = 'EUR';
        unsupported.args.items[0].unit_amount.currency_code = 'EUR';
        assert.equal(
          (await service.evaluateAndReserve(policy, unsupported, trusted()))
            .decision,
          'deny',
        );
        const oversized = new InvoicePolicy(f.app, {
          identityKey: key,
          resolver: resolver({ value: '100.01' }),
        });
        assert.equal(
          (await oversized.evaluateAndReserve(policy, send(), trusted()))
            .decision,
          'deny',
        );
        const wrongDomain = new InvoicePolicy(f.app, {
          identityKey: key,
          resolver: resolver({ email: 'buyer@evil.invalid' }),
        });
        assert.equal(
          (
            await wrongDomain.evaluateAndReserve(
              policy,
              send(),
              trusted('buyer@evil.invalid'),
            )
          ).decision,
          'deny',
        );
        const unknown = trusted();
        unknown.agent.id = 'unknown';
        assert.equal(
          (await service.evaluateAndReserve(policy, draft(), unknown)).decision,
          'deny',
        );
        const approval = loadPolicy(
          source.replace('then: allow', 'then: require_approval'),
        );
        const held = await service.evaluateAndReserve(
          approval,
          draft(),
          trusted(),
        );
        assert.equal(held.reason, 'approval_unsupported');
        assert.equal(held.decision, 'deny');
      },
    );
    await t.test(
      'a queued send resolves changed provider facts after the lock wait',
      async () => {
        let clock = Date.now();
        let value = '25.00';
        const queued = new InvoicePolicy(f.app, {
          identityKey: key,
          resolver: resolver({ value: () => value, now: () => clock }),
        });
        const lock = await f.owner.connect();
        await lock.query('BEGIN');
        await lock.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('spendwall/invoice-policy/v1',0))",
        );
        const pending = queued.evaluateAndReserve(
          policy,
          send(),
          trusted(undefined, 'queued-customer'),
        );
        try {
          let waiters = 0;
          for (let i = 0; i < 100 && waiters < 1; i++) {
            waiters = (
              await f.owner.query(
                "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
              )
            ).rows[0].n;
            if (!waiters)
              await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(
            waiters >= 1,
            'the invoice request must be queued at the database lock',
          );
          value = '100.01';
          clock += 2001;
        } finally {
          await lock.query('ROLLBACK');
          lock.release();
        }
        const result = await pending;
        assert.equal(
          result.dispatchAllowed,
          false,
          'expired pre-lock facts must not authorize an over-cap invoice',
        );
        assert.ok(result.matchedRules.includes('invoice_amount_cap'));
      },
    );
    let allowedInput, allowedResult;
    await t.test(
      'two database clients waiting on the reservation lock share one slot across agents',
      async () => {
        const lock = await f.owner.connect();
        await lock.query('BEGIN');
        await lock.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('spendwall/invoice-policy/v1',0))",
        );
        const inputs = [send(), send()];
        const pending = inputs.map((input, i) =>
          service.evaluateAndReserve(
            policy,
            input,
            trusted(undefined, undefined, i ? 'returns' : 'support'),
          ),
        );
        try {
          let waiters = 0;
          for (let i = 0; i < 100 && waiters < 2; i++) {
            waiters = (
              await f.owner.query(
                "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
              )
            ).rows[0].n;
            if (waiters < 2)
              await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(
            waiters >= 2,
            'both independent clients must reach the locked transaction',
          );
        } finally {
          await lock.query('ROLLBACK');
          lock.release();
        }
        const results = await Promise.all(pending);
        assert.equal(results.filter((r) => r.dispatchAllowed).length, 1);
        assert.equal(results.filter((r) => r.decision === 'deny').length, 1);
        const index = results.findIndex((r) => r.dispatchAllowed);
        allowedInput = inputs[index];
        allowedResult = results[index];
        allowedInput.trusted = trusted(
          undefined,
          undefined,
          index ? 'returns' : 'support',
        );
        assert.ok(
          results[1 - index].matchedRules.includes('invoice_daily_limit'),
        );
        const stored = await f.app.query(
          "SELECT count(*)::int AS n FROM invoice_policy.decisions WHERE tool='send_invoice' AND decision='allow'",
        );
        assert.equal(stored.rows[0].n, 1);
        assert.ok(new Date(allowedResult.expiresAt).getTime() > Date.now());
      },
    );
    await t.test(
      'restart retries keep one receipt and never authorize a second dispatch',
      async () => {
        const { trusted: identity, ...input } = allowedInput;
        const before = await counts();
        const restarted = new InvoicePolicy(f.app, {
          identityKey: key,
          resolver: resolver(),
        });
        const replay = await restarted.evaluateAndReserve(policy, input, {
          ...identity,
          agg: { invoice_send_count_day: -999 },
        });
        assert.equal(replay.decision, 'allow');
        assert.equal(replay.replayed, true);
        assert.equal(replay.dispatchAllowed, false);
        assert.deepEqual(replay.receipt, allowedResult.receipt);
        assert.deepEqual(await counts(), before);
        const changed = {
          ...input,
          args: { ...input.args, note: 'Changed note' },
        };
        assert.equal(
          (await restarted.evaluateAndReserve(policy, changed, identity))
            .reason,
          'request_conflict',
        );
        const changedPolicy = loadPolicy(source.replace('>= 1', '>= 2'));
        assert.equal(
          (await restarted.evaluateAndReserve(changedPolicy, input, identity))
            .reason,
          'request_conflict',
        );
        assert.equal(
          (
            await restarted.evaluateAndReserve(
              changedPolicy,
              { ...input, requestId: randomUUID() },
              identity,
            )
          ).reason,
          'invoice_reserved',
        );
        const rotated = new InvoicePolicy(f.app, {
          identityKey: '8'.repeat(64),
          resolver: resolver(),
        });
        assert.equal(
          (await rotated.evaluateAndReserve(policy, send(), trusted())).reason,
          'invoice_unavailable',
        );
      },
    );
    await t.test(
      'customer and merchant isolation, UTC day rollover and permanent invoice deduplication',
      async () => {
        assert.equal(
          (
            await service.evaluateAndReserve(
              policy,
              send(),
              trusted(undefined, 'customerB'),
            )
          ).dispatchAllowed,
          true,
        );
        const other = new InvoicePolicy(f.app, {
          identityKey: key,
          resolver: resolver({ merchant: 'merchantB' }),
        });
        assert.equal(
          (await other.evaluateAndReserve(policy, send(), trusted()))
            .dispatchAllowed,
          true,
        );
        // Owner-only fixture advances stored reservations to yesterday; runtime exposes no clock override.
        await f.owner.query(
          "UPDATE invoice_policy.decisions SET day=(clock_timestamp() AT TIME ZONE 'UTC')::date-1",
        );
        const { trusted: identity, ...input } = allowedInput;
        assert.equal(
          (
            await service.evaluateAndReserve(
              policy,
              { ...input, requestId: randomUUID() },
              identity,
            )
          ).reason,
          'invoice_reserved',
        );
        assert.equal(
          (await service.evaluateAndReserve(policy, input, identity))
            .dispatchAllowed,
          false,
        );
        assert.equal(
          (await service.evaluateAndReserve(policy, send(), trusted()))
            .dispatchAllowed,
          true,
        );
        assert.equal(
          (await service.evaluateAndReserve(policy, send(), trusted()))
            .decision,
          'deny',
        );
      },
    );
    await t.test(
      'application cannot rewrite or delete history and stored output contains no recipient or provider IDs',
      async () => {
        for (const sql of [
          'DELETE FROM invoice_policy.decisions',
          'UPDATE invoice_policy.decisions SET day=current_date',
          'TRUNCATE invoice_policy.decisions',
          'INSERT INTO invoice_policy.decisions (request_id) VALUES (gen_random_uuid())',
        ])
          await assert.rejects(f.app.query(sql), { code: '42501' });
        const stored = JSON.stringify(
          (await f.app.query('SELECT * FROM invoice_policy.decisions')).rows,
        );
        for (const secret of [
          'buyer@',
          'example.invalid',
          'INV2-',
          'customerA',
        ])
          assert.equal(stored.includes(secret), false);
        assert.equal((await verifyAudit(f.app)).ok, true);
      },
    );
    await t.test(
      'a missing write or failed audit rolls back and cannot return allowance',
      async () => {
        const before = await counts();
        const definition = (
          await f.owner.query(
            "SELECT pg_get_functiondef('invoice_policy.record_decision(jsonb)'::regprocedure) AS sql",
          )
        ).rows[0].sql;
        try {
          await f.owner.query(
            'CREATE OR REPLACE FUNCTION invoice_policy.record_decision(payload jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RETURN; END $$',
          );
          assert.equal(
            (await service.evaluateAndReserve(policy, draft(), trusted()))
              .dispatchAllowed,
            false,
            'a no-op storage function must not permit dispatch',
          );
          assert.deepEqual(await counts(), before);
        } finally {
          await f.owner.query(definition);
        }
        const group = (await f.owner.query('SELECT audit.app_role() AS name'))
          .rows[0].name;
        await f.owner.query(
          `REVOKE EXECUTE ON FUNCTION audit.append_event(jsonb) FROM ${pg.escapeIdentifier(group)}`,
        );
        try {
          assert.equal(
            (await service.evaluateAndReserve(policy, draft(), trusted()))
              .dispatchAllowed,
            false,
          );
          assert.deepEqual(await counts(), before);
        } finally {
          await f.owner.query(
            `GRANT EXECUTE ON FUNCTION audit.append_event(jsonb) TO ${pg.escapeIdentifier(group)}`,
          );
        }
      },
    );
    await t.test(
      'lost commit acknowledgements retain capacity without granting a retry dispatch',
      async () => {
        for (const mode of ['before', 'after']) {
          const input = send();
          const identity = trusted(undefined, `commit-${mode}`);
          const before = await counts();
          const failingPool = {
            connect: async () => {
              const client = await f.app.connect();
              return {
                query: async (text, ...args) => {
                  if (text === 'COMMIT' && mode === 'before')
                    throw new Error('Connection lost before commit');
                  const result = await client.query(text, ...args);
                  if (text === 'COMMIT')
                    throw new Error('Commit acknowledgement lost');
                  return result;
                },
                release: (discard) => client.release(discard),
              };
            },
          };
          const failing = new InvoicePolicy(failingPool, {
            identityKey: key,
            resolver: resolver(),
          });
          const result = await failing.evaluateAndReserve(
            policy,
            input,
            identity,
          );
          assert.equal(result.dispatchAllowed, false);
          const stored = await counts();
          const delta = mode === 'after' ? 1 : 0;
          assert.deepEqual(stored, {
            decisions: before.decisions + delta,
            audits: before.audits + delta,
          });
          const retry = await service.evaluateAndReserve(
            policy,
            input,
            identity,
          );
          assert.equal(retry.decision, 'allow');
          assert.equal(retry.replayed, mode === 'after');
          assert.equal(retry.dispatchAllowed, mode === 'before');
        }
      },
    );
    await t.test(
      'missing schema and future-day history fail closed',
      async () => {
        const before = await counts();
        await f.owner.query(
          'ALTER SCHEMA invoice_policy RENAME TO invoice_policy_hidden',
        );
        try {
          assert.equal(
            (await service.evaluateAndReserve(policy, draft(), trusted()))
              .dispatchAllowed,
            false,
          );
        } finally {
          await f.owner.query(
            'ALTER SCHEMA invoice_policy_hidden RENAME TO invoice_policy',
          );
        }
        assert.deepEqual(await counts(), before);
        const original = (
          await f.app.query(
            'SELECT day::text FROM invoice_policy.decisions WHERE audit_id=$1',
            [allowedResult.receipt.id],
          )
        ).rows[0].day;
        await f.owner.query(
          "UPDATE invoice_policy.decisions SET day=(clock_timestamp() AT TIME ZONE 'UTC')::date+1 WHERE audit_id=$1",
          [allowedResult.receipt.id],
        );
        try {
          assert.equal(
            (await service.evaluateAndReserve(policy, draft(), trusted()))
              .dispatchAllowed,
            false,
            'history dated after the database clock must not authorize a new operation',
          );
          assert.deepEqual(await counts(), before);
        } finally {
          await f.owner.query(
            'UPDATE invoice_policy.decisions SET day=$1 WHERE audit_id=$2',
            [original, allowedResult.receipt.id],
          );
        }
      },
    );
    await t.test(
      'restricted readers reject accidental invoice schema privileges',
      async () => {
        await f.owner.query(
          await readFile(
            new URL('../scripts/hosting-reader.sql', import.meta.url),
            'utf8',
          ),
        );
        await f.owner.query(
          "ALTER ROLE spendwall_dashboard_reader PASSWORD 'hosted-test-only'",
        );
        const receiverGroup = (
          await f.owner.query('SELECT reconciliation.receiver_role() AS name')
        ).rows[0].name;
        await f.owner.query(
          "CREATE ROLE invoice_receiver_test LOGIN PASSWORD 'receiver-test-only'",
        );
        await f.owner.query(
          `GRANT ${pg.escapeIdentifier(receiverGroup)} TO invoice_receiver_test`,
        );
        for (const [login, password, check] of [
          ['spendwall_dashboard_reader', 'hosted-test-only', checkHostedReader],
          ['invoice_receiver_test', 'receiver-test-only', checkWebhookReceiver],
        ]) {
          const target = new URL(url);
          target.username = login;
          target.password = password;
          const pool = new pg.Pool({ connectionString: target.toString() });
          try {
            await check(pool);
            await f.owner.query(
              `GRANT USAGE ON SCHEMA invoice_policy TO ${pg.escapeIdentifier(login)}`,
            );
            await f.owner.query(
              `GRANT SELECT (request_id) ON invoice_policy.decisions TO ${pg.escapeIdentifier(login)}`,
            );
            await assert.rejects(
              check(pool),
              /unavailable/,
              'restricted principal must reject invoice metadata access',
            );
          } finally {
            await pool.end();
            await f.owner.query(`DROP OWNED BY ${pg.escapeIdentifier(login)}`);
            await f.owner.query(`DROP ROLE ${pg.escapeIdentifier(login)}`);
          }
        }
      },
    );
    await t.test(
      'changed audit linkage and orphan allowances fail closed',
      async () => {
        const before = await counts();
        await f.owner.query(
          "UPDATE invoice_policy.decisions SET audit_hash=repeat('0',64) WHERE audit_id=$1",
          [allowedResult.receipt.id],
        );
        assert.equal(
          (await service.evaluateAndReserve(policy, draft(), trusted()))
            .dispatchAllowed,
          false,
        );
        assert.deepEqual(await counts(), before);
        await f.owner.query(
          'UPDATE invoice_policy.decisions SET audit_hash=$1 WHERE audit_id=$2',
          [allowedResult.receipt.row_hash, allowedResult.receipt.id],
        );
        await new AuditLog(f.app).append({
          agentId: 'support',
          tool: 'send_invoice',
          args: {},
          resolvedCtx: {},
          decision: 'allow',
          matchedRules: [],
          policyVersion: policy.policyVersion,
          eventKind: 'tool_call',
          latencyMs: 0,
        });
        assert.equal(
          (await service.evaluateAndReserve(policy, draft(), trusted()))
            .dispatchAllowed,
          false,
        );
      },
    );
  },
);
