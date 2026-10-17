import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { OrderOutcomeUnknownError } from '../apps/firewall/src/orders/index.ts';
import { prepareEvent } from '../apps/firewall/src/audit/event.ts';
import { verifyAudit } from '../apps/firewall/src/audit/index.ts';
import { checkHostedReader } from '../apps/firewall/src/dashboard/hosted-reader.ts';
import { checkWebhookReceiver } from '../apps/firewall/src/webhooks/reconciliation.ts';
import { loadPolicy } from '../packages/policy/src/index.ts';
import { dashboardFixture } from './helpers/dashboard-fixture.mjs';
import {
  captureInput,
  createInput,
  fixture,
  orderArgs,
  policy,
  trusted,
} from './helpers/order-fixture.mjs';

const url = process.env.AUDIT_TEST_DATABASE_URL;
const migration = await readFile(
  new URL('../migrations/009-orders.sql', import.meta.url),
  'utf8',
);
const lockSql =
  "SELECT pg_advisory_xact_lock(hashtextextended('spendwall/orders/v1',0))";

async function waitForWaiters(owner, count) {
  let waiters = 0;
  for (let i = 0; i < 200 && waiters < count; i++) {
    waiters = (
      await owner.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
      )
    ).rows[0].n;
    if (waiters < count)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return waiters;
}

test(
  'order ledger binds Orders v2 creation, buyer approval and single capture',
  { skip: !url },
  async (t) => {
    const f = await dashboardFixture(url, undefined, {
      reconciliation: { adapterRef: 'a'.repeat(64) },
    });
    t.after(async () => {
      await f.owner.query('DROP SCHEMA IF EXISTS orders CASCADE');
      await f.close();
    });
    await f.owner.query('DROP SCHEMA IF EXISTS orders CASCADE');
    await f.owner.query(migration);
    const counts = async () =>
      (
        await f.app.query(
          `SELECT (SELECT count(*)::int FROM orders.orders) AS orders,
            (SELECT count(*)::int FROM orders.captures) AS captures,
            (SELECT count(*)::int FROM audit.audit_events) AS audits`,
        )
      ).rows[0];
    const ledger = async (requestId) =>
      (
        await f.app.query(
          'SELECT status, order_id, approve_url, amount_value FROM orders.orders WHERE request_id=$1::uuid',
          [requestId],
        )
      ).rows[0];
    const trail = async (auditId) =>
      (
        await f.owner.query(
          `SELECT upstream_result_ref::text, resolved_ctx->'order' AS "order" FROM audit.audit_events WHERE id=$1::bigint`,
          [auditId],
        )
      ).rows[0];
    const captureRow = async (executionId) =>
      (
        await f.app.query(
          'SELECT status, capture_id FROM orders.captures WHERE execution_id=$1::uuid',
          [executionId],
        )
      ).rows[0];
    let failNext;
    let beforePost;
    let interceptPost;
    const x = fixture({
      fetchImpl: async (input, init, real) => {
        if (interceptPost && init?.method === 'POST')
          return interceptPost(input, init, real);
        if (beforePost && init?.method === 'POST') await beforePost();
        if (failNext && init?.method === 'POST') {
          const response = failNext;
          failNext = undefined;
          if (typeof response === 'function') return response();
          throw new Error('Injected provider failure');
        }
        return real(input, init);
      },
    });
    const service = x.service(f.app);
    let allowed;
    await t.test(
      'policy and recomputed totals decide creation; an allowed order returns only its approve link',
      async () => {
        const before = await counts();
        const input = createInput();
        allowed = await service.create(policy, input, trusted());
        assert.equal(allowed.decision, 'allow', JSON.stringify(allowed));
        assert.deepEqual(allowed.matchedRules, ['order_within_budget']);
        assert.equal(allowed.replayed, false);
        assert.match(allowed.result.id, /^[A-Z0-9]{17,32}$/);
        assert.equal(allowed.result.status, 'CREATED');
        assert.deepEqual(allowed.result.amount, {
          value: '19.99',
          currency_code: 'USD',
        });
        assert.match(
          allowed.result.approveUrl,
          /^https:\/\/www\.sandbox\.paypal\.com\//,
        );
        assert.doesNotMatch(JSON.stringify(allowed), /synthetic-token/);
        assert.ok(allowed.receipt?.id);
        assert.deepEqual(await ledger(input.requestId), {
          status: 'created',
          order_id: allowed.result.id,
          approve_url: allowed.result.approveUrl,
          amount_value: '19.99',
        });
        assert.equal(x.posts().length, 1);
        assert.deepEqual(await counts(), {
          orders: before.orders + 1,
          captures: 0,
          audits: before.audits + 2,
        });
        // The append-only chain itself names the created order and its approve link.
        assert.deepEqual(await trail(allowed.receipt.id), {
          upstream_result_ref: input.requestId,
          order: {
            amount: { value: '19.99', currency_code: 'USD' },
            status: 'CREATED',
            order_id: allowed.result.id,
            approve_url: allowed.result.approveUrl,
          },
        });
        const replayed = await service.create(policy, input, trusted());
        assert.equal(replayed.replayed, true);
        assert.equal(replayed.result.id, allowed.result.id);
        assert.deepEqual(
          replayed.matchedRules,
          allowed.matchedRules,
          'a replay carries the matched rules of the first attempt',
        );
        assert.deepEqual(
          replayed.receipt,
          allowed.receipt,
          'a replay returns the receipt of the outcome event',
        );
        assert.equal(
          x.posts().length,
          1,
          'replay must not create another order',
        );
        const conflict = await service.create(
          policy,
          { ...input, args: orderArgs(24.5) },
          trusted(),
        );
        assert.equal(conflict.reason, 'request_conflict');
        const otherPolicy = loadPolicy(
          (
            await readFile(
              new URL(
                '../apps/agent-demo/shopping-policy.yaml',
                import.meta.url,
              ),
              'utf8',
            )
          ).replace('amount.usd <= 50', 'amount.usd <= 60'),
        );
        assert.equal(
          (await service.create(otherPolicy, input, trusted())).reason,
          'request_conflict',
        );
        const mid = await counts();
        const over = await service.create(
          policy,
          createInput(orderArgs(289)),
          trusted(),
        );
        assert.equal(over.decision, 'deny');
        assert.ok(over.matchedRules.includes('order_over_budget'));
        assert.ok(over.receipt?.id, 'policy denials are audited');
        const forged = await service.create(
          policy,
          createInput(
            orderArgs(19.99, {
              items: [{ name: 'Cable', itemCost: 19.99, itemTotal: 1 }],
            }),
          ),
          trusted(),
        );
        assert.equal(forged.decision, 'deny');
        assert.equal(forged.reason, 'unresolved_context');
        const unknownAgent = await service.create(
          policy,
          createInput(),
          trusted('intruder'),
        );
        assert.equal(unknownAgent.decision, 'deny');
        assert.deepEqual(unknownAgent.matchedRules, []);
        const held = await service.create(
          loadPolicy(
            (
              await readFile(
                new URL(
                  '../apps/agent-demo/shopping-policy.yaml',
                  import.meta.url,
                ),
                'utf8',
              )
            ).replace('then: allow', 'then: require_approval'),
          ),
          createInput(),
          trusted(),
        );
        assert.equal(held.reason, 'approval_unsupported');
        assert.equal(x.posts().length, 1, 'denials never reach the provider');
        assert.deepEqual(await counts(), {
          orders: mid.orders,
          captures: 0,
          audits: mid.audits + 3,
        });
      },
    );
    await t.test(
      'capture is denied until the provider reports buyer approval and the ledger binding matches',
      async () => {
        const before = await counts();
        const early = await service.capture(
          policy,
          captureInput(allowed.result.id),
          trusted(),
        );
        assert.equal(early.decision, 'deny');
        assert.equal(early.reason, 'order_not_approved');
        assert.ok(early.receipt?.id);
        assert.equal(x.posts().length, 1);
        const externalRequest = randomUUID();
        const external = await x.provider.fetchImpl(
          'https://api-m.sandbox.paypal.com/v2/checkout/orders',
          {
            method: 'POST',
            headers: { 'PayPal-Request-Id': externalRequest },
            body: JSON.stringify({
              purchase_units: [
                {
                  custom_id: externalRequest,
                  amount: { value: '19.99', currency_code: 'USD' },
                },
              ],
            }),
          },
        );
        const foreign = (await external.json()).id;
        x.provider.approve(foreign);
        const unbound = await service.capture(
          policy,
          captureInput(foreign),
          trusted(),
        );
        assert.equal(unbound.reason, 'order_unknown');
        const missing = await service.capture(
          policy,
          captureInput('MISSING0000000000'),
          trusted(),
        );
        assert.equal(missing.reason, 'unresolved_context');
        const unlisted = await service.capture(
          policy,
          captureInput(allowed.result.id),
          trusted('intruder'),
        );
        assert.equal(unlisted.decision, 'deny');
        assert.equal(x.provider.writes.length, 0);
        assert.equal((await counts()).captures, 0);
        assert.equal((await counts()).audits, before.audits + 3);
      },
    );
    let completed;
    await t.test(
      'two concurrent captures of one approved order execute once; retries replay the receipt',
      async () => {
        x.provider.approve(allowed.result.id);
        x.resolver.invalidateOrder(allowed.result.id);
        const lock = await f.owner.connect();
        await lock.query('BEGIN');
        await lock.query(lockSql);
        const inputs = [
          captureInput(allowed.result.id),
          captureInput(allowed.result.id),
        ];
        const pending = inputs.map((input) =>
          service.capture(policy, input, trusted()),
        );
        try {
          assert.equal(await waitForWaiters(f.owner, 2), 2);
        } finally {
          await lock.query('ROLLBACK');
          lock.release();
        }
        const results = await Promise.all(pending);
        assert.deepEqual(results.map((result) => result.decision).sort(), [
          'allow',
          'deny',
        ]);
        completed = results.find((result) => result.decision === 'allow');
        const refused = results.find((result) => result.decision === 'deny');
        assert.equal(refused.reason, 'order_capture_reserved');
        assert.equal(completed.result.status, 'COMPLETED');
        assert.equal(completed.result.orderId, allowed.result.id);
        assert.deepEqual(completed.result.amount, {
          value: '19.99',
          currency_code: 'USD',
        });
        assert.equal(x.provider.writes.length, 1);
        assert.deepEqual(await captureRow(completed.result.executionId), {
          status: 'completed',
          capture_id: completed.result.id,
        });
        assert.deepEqual(await trail(completed.receipt.id), {
          upstream_result_ref: completed.result.executionId,
          order: {
            amount: { value: '19.99', currency_code: 'USD' },
            order_id: allowed.result.id,
            status: 'COMPLETED',
          },
        });
        const same = inputs.find(
          (input) => input.executionId === completed.result.executionId,
        );
        const replay = await service.capture(policy, same, trusted());
        assert.equal(replay.replayed, true);
        assert.equal(replay.result.id, completed.result.id);
        assert.deepEqual(replay.receipt, completed.receipt);
        const fresh = await service.capture(
          policy,
          captureInput(allowed.result.id),
          trusted(),
        );
        assert.equal(fresh.reason, 'order_capture_reserved');
        assert.equal(x.provider.writes.length, 1);
        x.resolver.invalidateOrder(allowed.result.id);
        const done = await service.capture(
          policy,
          captureInput(allowed.result.id),
          trusted(),
        );
        assert.equal(done.reason, 'order_capture_reserved');
      },
    );
    await t.test(
      'unknown provider outcomes are preserved and recovered under the same identifier',
      async () => {
        const input = createInput(orderArgs(24.5));
        failNext = 'throw';
        await assert.rejects(
          service.create(policy, input, trusted()),
          (error) =>
            error instanceof OrderOutcomeUnknownError &&
            error.id === input.requestId,
        );
        assert.equal((await ledger(input.requestId)).status, 'unknown');
        // A changed server URL configuration would resend a different body
        // under the same PayPal-Request-Id, so it is refused as a conflict.
        const writesBefore = x.provider.writes.length;
        const reconfigured = x.service(f.app, {
          returnUrl: 'https://example.com/changed-return',
        });
        const conflict = await reconfigured.create(policy, input, trusted());
        assert.equal(conflict.decision, 'deny');
        assert.equal(conflict.reason, 'request_conflict');
        assert.equal((await ledger(input.requestId)).status, 'unknown');
        assert.equal(x.provider.writes.length, writesBefore);
        const recovered = await service.create(policy, input, trusted());
        assert.equal(recovered.decision, 'allow');
        assert.equal(recovered.replayed, true);
        assert.deepEqual(
          recovered.matchedRules,
          ['order_within_budget'],
          'a retry of an unknown attempt carries the matched rules',
        );
        assert.equal((await ledger(input.requestId)).status, 'created');
        assert.equal(
          (await service.create(policy, input, trusted())).result.id,
          recovered.result.id,
        );
        x.provider.approve(recovered.result.id);
        x.resolver.invalidateOrder(recovered.result.id);
        const capture = captureInput(recovered.result.id);
        failNext = 'throw';
        await assert.rejects(
          service.capture(policy, capture, trusted()),
          (error) =>
            error instanceof OrderOutcomeUnknownError &&
            error.id === capture.executionId,
        );
        assert.equal((await captureRow(capture.executionId)).status, 'unknown');
        assert.equal(x.provider.writes.length, 1);
        const other = await service.capture(
          policy,
          captureInput(recovered.result.id),
          trusted(),
        );
        assert.equal(other.reason, 'order_capture_reserved');
        const recoveredCapture = await service.capture(
          policy,
          capture,
          trusted('demo-shopper', 'someone-else'),
        );
        assert.equal(
          recoveredCapture.decision,
          'allow',
          'customer identity is not part of the capture binding',
        );
        assert.equal(recoveredCapture.replayed, true);
        assert.equal(x.provider.writes.length, 2);
        assert.equal(
          (await captureRow(capture.executionId)).status,
          'completed',
        );
        assert.equal(
          (await service.capture(policy, capture, trusted())).result.id,
          recoveredCapture.result.id,
        );
        assert.equal(x.provider.writes.length, 2);
      },
    );
    await t.test(
      'a definitive provider rejection frees the capture slot without a payment',
      async () => {
        const input = createInput(orderArgs(10));
        const created = await service.create(policy, input, trusted());
        x.provider.approve(created.result.id);
        x.resolver.invalidateOrder(created.result.id);
        const first = captureInput(created.result.id);
        failNext = () =>
          Response.json({ name: 'UNPROCESSABLE_ENTITY' }, { status: 422 });
        const rejected = await service.capture(policy, first, trusted());
        assert.equal(rejected.decision, 'deny');
        assert.equal(rejected.reason, 'provider_rejected');
        assert.equal((await captureRow(first.executionId)).status, 'failed');
        const rejectedAgain = await service.capture(policy, first, trusted());
        assert.equal(rejectedAgain.reason, 'provider_rejected');
        assert.deepEqual(rejectedAgain.receipt, rejected.receipt);
        const second = await service.capture(
          policy,
          captureInput(created.result.id),
          trusted(),
        );
        assert.equal(second.decision, 'allow');
        assert.equal(x.provider.writes.length, 3);
        const creation = createInput(orderArgs(5));
        failNext = () =>
          Response.json({ name: 'INVALID_REQUEST' }, { status: 400 });
        const refused = await service.create(policy, creation, trusted());
        assert.equal(refused.reason, 'provider_rejected');
        assert.equal((await ledger(creation.requestId)).status, 'failed');
        const refusedAgain = await service.create(policy, creation, trusted());
        assert.equal(refusedAgain.reason, 'provider_rejected');
        assert.deepEqual(refusedAgain.receipt, refused.receipt);
      },
    );
    await t.test(
      'a rejected retry of an unknown outcome keeps the row unknown and the capture slot reserved',
      async () => {
        const input = createInput(orderArgs(7));
        failNext = 'throw';
        await assert.rejects(
          service.create(policy, input, trusted()),
          OrderOutcomeUnknownError,
        );
        failNext = () =>
          Response.json({ name: 'INVALID_REQUEST' }, { status: 400 });
        await assert.rejects(
          service.create(policy, input, trusted()),
          (error) =>
            error instanceof OrderOutcomeUnknownError &&
            error.id === input.requestId &&
            /attempt rejected \(HTTP 400\) while another attempt exists/.test(
              error.message,
            ),
        );
        assert.equal((await ledger(input.requestId)).status, 'unknown');
        const created = await service.create(policy, input, trusted());
        assert.equal(created.decision, 'allow');
        assert.equal(created.replayed, true);
        assert.equal((await ledger(input.requestId)).status, 'created');
        x.provider.approve(created.result.id);
        x.resolver.invalidateOrder(created.result.id);
        const capture = captureInput(created.result.id);
        const writes = x.provider.writes.length;
        failNext = 'throw';
        await assert.rejects(
          service.capture(policy, capture, trusted()),
          OrderOutcomeUnknownError,
        );
        failNext = () =>
          Response.json(
            {
              name: 'UNPROCESSABLE_ENTITY',
              details: [{ issue: 'ORDER_ALREADY_CAPTURED' }],
            },
            { status: 422 },
          );
        await assert.rejects(
          service.capture(policy, capture, trusted()),
          (error) =>
            error instanceof OrderOutcomeUnknownError &&
            error.id === capture.executionId &&
            /attempt rejected \(HTTP 422\) while another attempt exists/.test(
              error.message,
            ),
        );
        assert.equal((await captureRow(capture.executionId)).status, 'unknown');
        assert.equal(
          (
            await service.capture(
              policy,
              captureInput(created.result.id),
              trusted(),
            )
          ).reason,
          'order_capture_reserved',
          'a rejected retry must not free the capture slot',
        );
        assert.equal(x.provider.writes.length, writes);
        const done = await service.capture(policy, capture, trusted());
        assert.equal(done.decision, 'allow');
        assert.equal(done.replayed, true);
        assert.equal(
          (await captureRow(capture.executionId)).status,
          'completed',
        );
        assert.equal(x.provider.writes.length, writes + 1);
      },
    );
    await t.test(
      'overlapping calls with one identifier reach the provider twice, settle once and share the receipt',
      async () => {
        // The first POST waits until the second call has passed its ledger phase and posted too.
        const overlap = async (start) => {
          let release;
          const second = new Promise((resolve) => (release = resolve));
          let posts = 0;
          beforePost = async () => {
            posts++;
            if (posts === 1) await second;
            else release();
          };
          try {
            const results = await Promise.all([start(), start()]);
            assert.equal(posts, 2);
            return results;
          } finally {
            beforePost = undefined;
          }
        };
        const input = createInput(orderArgs(8));
        const creations = await overlap(() =>
          service.create(policy, input, trusted()),
        );
        for (const result of creations) {
          assert.equal(result.decision, 'allow', JSON.stringify(result));
          assert.equal(result.result.id, creations[0].result.id);
          assert.deepEqual(result.receipt, creations[0].receipt);
        }
        assert.deepEqual(await ledger(input.requestId), {
          status: 'created',
          order_id: creations[0].result.id,
          approve_url: creations[0].result.approveUrl,
          amount_value: '8.00',
        });
        assert.equal(
          (await trail(creations[0].receipt.id)).order.order_id,
          creations[0].result.id,
        );
        x.provider.approve(creations[0].result.id);
        x.resolver.invalidateOrder(creations[0].result.id);
        const capture = captureInput(creations[0].result.id);
        const writes = x.provider.writes.length;
        const captures = await overlap(() =>
          service.capture(policy, capture, trusted()),
        );
        for (const result of captures) {
          assert.equal(result.decision, 'allow', JSON.stringify(result));
          assert.equal(result.result.id, captures[0].result.id);
          assert.deepEqual(result.receipt, captures[0].receipt);
        }
        assert.equal(x.provider.writes.length, writes + 1);
        assert.deepEqual(await captureRow(capture.executionId), {
          status: 'completed',
          capture_id: captures[0].result.id,
        });
        assert.equal(
          (await trail(captures[0].receipt.id)).order.status,
          'COMPLETED',
        );
      },
    );
    await t.test(
      'a duplicate-request rejection of an overlapping first attempt keeps the row unknown until the other attempt settles',
      async () => {
        // Call A posts first and receives a definitive 4xx while call B, started
        // after A's ledger phase, has already posted the same identifier.
        const race = async (start, row, expectStatus) => {
          let posts = 0;
          let second;
          let enteredSecond;
          const secondEntered = new Promise(
            (resolve) => (enteredSecond = resolve),
          );
          let releaseSecond;
          const secondGate = new Promise(
            (resolve) => (releaseSecond = resolve),
          );
          interceptPost = async (input, init, real) => {
            posts++;
            if (posts === 1) {
              second = start();
              await secondEntered;
              return new Response('{"name":"DUPLICATE_REQUEST"}', {
                status: 422,
                headers: { 'content-type': 'application/json' },
              });
            }
            enteredSecond();
            await secondGate;
            return real(input, init);
          };
          try {
            await assert.rejects(
              start(),
              (error) => error instanceof OrderOutcomeUnknownError,
            );
            assert.equal((await row()).status, 'unknown');
            releaseSecond();
            const settled = await second;
            assert.equal(settled.decision, 'allow', JSON.stringify(settled));
            assert.equal((await row()).status, expectStatus);
            assert.equal(posts, 2);
            const replay = await start();
            assert.equal(replay.decision, 'allow');
            assert.equal(replay.replayed, true);
            assert.deepEqual(replay.receipt, settled.receipt);
          } finally {
            interceptPost = undefined;
          }
        };
        const input = createInput(orderArgs(12));
        await race(
          () => service.create(policy, input, trusted()),
          () => ledger(input.requestId),
          'created',
        );
        const order = (await ledger(input.requestId)).order_id;
        x.provider.approve(order);
        x.resolver.invalidateOrder(order);
        const capture = captureInput(order);
        const writes = x.provider.writes.length;
        await race(
          () => service.capture(policy, capture, trusted()),
          () => captureRow(capture.executionId),
          'completed',
        );
        assert.equal(x.provider.writes.length, writes + 1);
      },
    );
    await t.test(
      'an unknown outcome older than the five-hour replay window is not resent',
      async () => {
        const age = async (table, column, id) =>
          f.owner.query(
            `UPDATE orders.${table} SET created_at=created_at-interval '5 hours 1 minute' WHERE ${column}=$1::uuid`,
            [id],
          );
        const input = createInput(orderArgs(9));
        failNext = 'throw';
        await assert.rejects(
          service.create(policy, input, trusted()),
          OrderOutcomeUnknownError,
        );
        const writes = x.provider.writes.length;
        const posts = x.posts().length;
        await age('orders', 'request_id', input.requestId);
        await assert.rejects(
          service.create(policy, input, trusted()),
          (error) =>
            error instanceof OrderOutcomeUnknownError &&
            error.id === input.requestId &&
            /replay expired/.test(error.message),
        );
        assert.equal((await ledger(input.requestId)).status, 'unknown');
        assert.equal(x.posts().length, posts);
        const fresh = createInput(orderArgs(9));
        const created = await service.create(policy, fresh, trusted());
        assert.equal(created.decision, 'allow');
        x.provider.approve(created.result.id);
        x.resolver.invalidateOrder(created.result.id);
        const capture = captureInput(created.result.id);
        failNext = 'throw';
        await assert.rejects(
          service.capture(policy, capture, trusted()),
          OrderOutcomeUnknownError,
        );
        await age('captures', 'execution_id', capture.executionId);
        const before = x.posts().length;
        await assert.rejects(
          service.capture(policy, capture, trusted()),
          (error) =>
            error instanceof OrderOutcomeUnknownError &&
            error.id === capture.executionId &&
            /replay expired/.test(error.message),
        );
        assert.equal((await captureRow(capture.executionId)).status, 'unknown');
        assert.equal(x.posts().length, before);
        assert.equal(
          (
            await service.capture(
              policy,
              captureInput(created.result.id),
              trusted(),
            )
          ).reason,
          'order_capture_reserved',
        );
        assert.equal(
          x.provider.writes.length,
          writes,
          'no capture completed, so no payment write',
        );
      },
    );
    await t.test(
      'DB redaction retains order ids and sandbox approve links only in their validated shapes',
      async () => {
        const link =
          'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T';
        const input = {
          order: {
            order_id: '5O190127TN364715T',
            approve_url: link,
            status: 'CREATED',
            token: 'private-order',
          },
          order_id: 'private-order',
          approve_url: 'https://www.paypal.com/checkoutnow?token=private-order',
          status: 'APPROVED',
          links: [{ rel: 'approve', href: link }],
        };
        const expected = {
          order: {
            order_id: '5O190127TN364715T',
            approve_url: link,
            status: 'CREATED',
          },
          status: 'APPROVED',
        };
        const base = prepareEvent({
          agentId: 'demo-shopper',
          tool: 'create_order',
          args: {},
          resolvedCtx: {},
          decision: 'allow',
          matchedRules: [],
          policyVersion: policy.policyVersion,
          latencyMs: 1,
          eventKind: 'tool_call',
        });
        const appended = await f.app.query(
          'SELECT id FROM audit.append_event($1::jsonb)',
          [
            JSON.stringify({
              ...base,
              args_redacted: input,
              resolved_ctx: input,
            }),
          ],
        );
        const row = (
          await f.owner.query(
            'SELECT args_redacted, resolved_ctx FROM audit.audit_events WHERE id=$1::bigint',
            [appended.rows[0].id],
          )
        ).rows[0];
        assert.deepEqual(row.args_redacted, expected);
        assert.deepEqual(row.resolved_ctx, expected);
        assert.doesNotMatch(
          JSON.stringify(row),
          /private-order|www\.paypal\.com/,
        );
        // The earlier velocity layer still runs underneath the order layer.
        await assert.rejects(
          f.app.query('SELECT id FROM audit.append_event($1::jsonb)', [
            JSON.stringify({ ...base, resolved_ctx: { velocity: {} } }),
          ]),
          /Invalid velocity metadata/,
        );
        assert.equal((await verifyAudit(f.app)).ok, true);
      },
    );
    await t.test(
      'application credentials cannot rewrite or delete ledger history',
      async () => {
        for (const statement of [
          'DELETE FROM orders.orders',
          'DELETE FROM orders.captures',
          "UPDATE orders.orders SET merchant_ref=repeat('0',64)",
          "UPDATE orders.orders SET amount_value='0.01'",
          'UPDATE orders.captures SET execution_id=gen_random_uuid()',
          'TRUNCATE orders.captures',
        ])
          await assert.rejects(f.app.query(statement), /permission denied/);
        // The granted columns are guarded by row triggers: a settled row never
        // changes, attempts never decrease, and an unknown row settles only
        // under a new audit receipt. Each statement targets one existing row
        // of the named status and must leave it untouched.
        const keys = { orders: 'request_id', captures: 'execution_id' };
        const sample = async (table, status) => {
          const rows = (
            await f.app.query(
              `SELECT * FROM orders.${table} WHERE status=$1 ORDER BY created_at LIMIT 1`,
              [status],
            )
          ).rows;
          assert.equal(rows.length, 1, `${table} row with status ${status}`);
          return rows[0];
        };
        const refused = async (client, table, status, set, message) => {
          const row = await sample(table, status);
          const where = `WHERE merchant_ref=$1 AND ${keys[table]}=$2::uuid`;
          const params = [row.merchant_ref, row[keys[table]]];
          await assert.rejects(
            client.query(`UPDATE orders.${table} SET ${set} ${where}`, params),
            message,
          );
          const after = (
            await f.app.query(`SELECT * FROM orders.${table} ${where}`, params)
          ).rows[0];
          assert.deepEqual(after, row);
        };
        const link =
          "'https://www.sandbox.paypal.com/checkoutnow?token=rewritten'";
        await refused(
          f.app,
          'orders',
          'created',
          `order_id=repeat('X',17), approve_url=${link}`,
          /Terminal order/,
        );
        await refused(
          f.app,
          'orders',
          'created',
          "status='failed', order_id=NULL, approve_url=NULL",
          /Terminal order/,
        );
        await refused(
          f.app,
          'orders',
          'failed',
          'attempts=attempts+1',
          /Terminal order/,
        );
        await refused(
          f.app,
          'orders',
          'unknown',
          'attempts=attempts-1',
          /Order attempts never decrease/,
        );
        await refused(
          f.app,
          'orders',
          'unknown',
          `status='created', order_id=repeat('X',17), approve_url=${link}`,
          /Order outcome requires a new audit receipt/,
        );
        await refused(
          f.app,
          'orders',
          'unknown',
          "audit_hash=repeat('0',64)",
          /Invalid order transition/,
        );
        await refused(
          f.app,
          'captures',
          'completed',
          "capture_id=repeat('X',15)",
          /Terminal capture/,
        );
        await refused(
          f.app,
          'captures',
          'completed',
          "status='failed', capture_id=NULL",
          /Terminal capture/,
        );
        await refused(
          f.app,
          'captures',
          'failed',
          "status='completed', capture_id=repeat('X',15)",
          /Terminal capture/,
        );
        await refused(
          f.app,
          'captures',
          'unknown',
          'attempts=attempts-1',
          /Capture attempts never decrease/,
        );
        await refused(
          f.app,
          'captures',
          'unknown',
          "status='completed', capture_id=repeat('X',15)",
          /Capture outcome requires a new audit receipt/,
        );
        await refused(
          f.app,
          'captures',
          'unknown',
          "audit_hash=repeat('0',64)",
          /Invalid capture transition/,
        );
        // The binding is immutable for the owner too, not only by grant.
        await refused(
          f.owner,
          'orders',
          'created',
          "amount_value='0.01'",
          /Immutable order binding/,
        );
        await refused(
          f.owner,
          'captures',
          'completed',
          'order_request=gen_random_uuid()',
          /Immutable capture binding/,
        );
        const verification = await verifyAudit(f.app);
        assert.equal(verification.ok, true);
      },
    );
    await t.test(
      'restricted readers reject accidental order schema privileges',
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
          "CREATE ROLE order_receiver_test LOGIN PASSWORD 'receiver-test-only'",
        );
        await f.owner.query(
          `GRANT ${pg.escapeIdentifier(receiverGroup)} TO order_receiver_test`,
        );
        for (const [login, password, check] of [
          ['spendwall_dashboard_reader', 'hosted-test-only', checkHostedReader],
          ['order_receiver_test', 'receiver-test-only', checkWebhookReceiver],
        ]) {
          const target = new URL(url);
          target.username = login;
          target.password = password;
          const pool = new pg.Pool({ connectionString: target.toString() });
          try {
            await check(pool);
            await f.owner.query(
              `GRANT USAGE ON SCHEMA orders TO ${pg.escapeIdentifier(login)}`,
            );
            await f.owner.query(
              `GRANT SELECT (request_id) ON orders.orders TO ${pg.escapeIdentifier(login)}`,
            );
            await assert.rejects(
              check(pool),
              /unavailable/,
              'restricted principal must reject order metadata access',
            );
          } finally {
            await pool.end();
            await f.owner.query(`DROP OWNED BY ${pg.escapeIdentifier(login)}`);
            await f.owner.query(`DROP ROLE ${pg.escapeIdentifier(login)}`);
          }
        }
      },
    );
  },
);
