import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  Reconciliation,
  checkWebhookReceiver,
} from '../apps/firewall/src/webhooks/reconciliation.ts';
import { ApprovalService } from '../apps/firewall/src/approvals/index.ts';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';
import { checkHostedReader } from '../apps/firewall/src/dashboard/hosted-reader.ts';
import {
  dashboardFixture,
  key,
  policy,
  request,
} from './helpers/dashboard-fixture.mjs';

const url = process.env.AUDIT_TEST_DATABASE_URL;
const adapterRef = 'a'.repeat(64);
const event = (n = 1) => ({
  eventId: `WH-SYNTHETIC-${n}`,
  refundId: 'REFUND123456789012',
  captureId: 'CAPTURE12345678901',
  usdCents: 500,
  payload: { id: `WH-SYNTHETIC-${n}`, private: 'do not store' },
});
const options = { identityKey: key, merchantId: 'merchantA', adapterRef };
test(
  'verified events persist once and late execution evidence resolves an observed refund',
  { skip: !url },
  async (t) => {
    const f = await dashboardFixture(url);
    const reconciliation = new Reconciliation(options);
    t.after(async () => {
      const receiver = (
        await f.owner.query('SELECT reconciliation.receiver_role() AS name')
      ).rows[0].name;
      await f.owner.query('DROP SCHEMA reconciliation CASCADE');
      await f.owner.query(`DROP OWNED BY ${pg.escapeIdentifier(receiver)}`);
      await f.owner.query(`DROP ROLE ${pg.escapeIdentifier(receiver)}`);
      await f.close();
    });
    const migration = new URL(
      '../migrations/007-reconciliation.sql',
      import.meta.url,
    );
    await f.owner.query(await readFile(migration, 'utf8'));
    await Promise.all(
      Array.from({ length: 8 }, () => reconciliation.receive(f.owner, event())),
    );
    let data = await reconciliation.read(f.app);
    assert.equal(
      data.items.length,
      1,
      'concurrent receipts must persist one observation',
    );
    assert.equal(data.items[0].state, 'pending');
    const input = request('5.00');
    const allowed = await f.velocity.evaluateAndReserve(policy('allow'), input);
    await reconciliation.record(f.app, allowed.receipt, {
      executionId: input.requestId,
      captureId: 'CAPTURE12345678901',
      id: 'REFUND123456789012',
      status: 'COMPLETED',
      amount: { value: '5.00', currency_code: 'USD' },
    });
    data = await new Reconciliation(options).read(f.app);
    assert.equal(data.items[0].state, 'matched');
    assert.equal(data.items[0].audit_id, allowed.receipt.id);
    assert.equal(JSON.stringify(data).includes('REFUND123'), false);
    assert.equal(JSON.stringify(data).includes('do not store'), false);
    await assert.rejects(
      reconciliation.receive(f.owner, {
        ...event(),
        payload: { changed: true },
      }),
    );
    assert.equal((await reconciliation.read(f.app)).items.length, 1);
    await t.test(
      'approval completion records a receipt in the execution transaction',
      async () => {
        const service = new ApprovalService(f.app, {
          ...options,
          reconciliation: true,
          executor: {
            identity: adapterRef,
            execute: async (id, args) => ({
              executionId: id,
              captureId: args.capture_id,
              id: 'REFUND123456789099',
              status: 'COMPLETED',
              amount: args.amount,
            }),
            reconcile: async () => {
              throw new Error();
            },
          },
        });
        const input = request('6.00');
        const loaded = policy('require_approval');
        const pending = await service.request(loaded, input);
        const detail = await service.details({
          approvalId: pending.approval_id,
          agentId: 'support',
        });
        const result = await service.decide(
          {
            approvalId: pending.approval_id,
            agentId: 'support',
            decision: 'approve',
            argsHash: detail.args_hash,
          },
          async () => ({ input, policy: loaded }),
        );
        assert.equal(result.execution_state, 'succeeded');
        const receipts = await f.app.query(
          'SELECT audit_id::text FROM reconciliation.refund_receipts WHERE execution_id=$1',
          [result.execution_id],
        );
        assert.equal(
          receipts.rows.length,
          1,
          'approval completion must commit its provider receipt',
        );
      },
    );
    await t.test(
      'receiver permissions cannot create matching firewall evidence',
      async () => {
        const group = (
          await f.owner.query('SELECT reconciliation.receiver_role() AS name')
        ).rows[0].name;
        await f.owner.query(
          "CREATE ROLE reconciliation_receiver_test LOGIN PASSWORD 'receiver-test-only'",
        );
        await f.owner.query(
          `GRANT ${pg.escapeIdentifier(group)} TO reconciliation_receiver_test`,
        );
        const target = new URL(url);
        target.username = 'reconciliation_receiver_test';
        target.password = 'receiver-test-only';
        const receiver = new pg.Pool({ connectionString: target.toString() });
        try {
          await checkWebhookReceiver(receiver);
          await assert.rejects(checkWebhookReceiver(f.owner), /receiver/i);
          await assert.rejects(checkWebhookReceiver(f.app), /receiver/i);
          await reconciliation.receive(receiver, event(2));
          await reconciliation.receive(receiver, event(2));
          for (const sql of [
            'DELETE FROM reconciliation.refund_events',
            'UPDATE reconciliation.refund_events SET usd_cents=1',
            'INSERT INTO reconciliation.refund_events (received_at) VALUES (clock_timestamp())',
            "SELECT reconciliation.record_refund('{}'::jsonb)",
            'SELECT * FROM audit.audit_events',
            "UPDATE approvals.requests SET approval_state='approved'",
            'DELETE FROM reconciliation.refund_receipts',
          ])
            await assert.rejects(receiver.query(sql), { code: '42501' });
          for (const sql of [
            'DELETE FROM reconciliation.refund_events',
            'UPDATE reconciliation.refund_receipts SET usd_cents=1',
          ])
            await assert.rejects(f.app.query(sql), { code: '42501' });
          await f.owner.query(
            'GRANT UPDATE ON reconciliation.refund_events TO reconciliation_receiver_test',
          );
          await assert.rejects(checkWebhookReceiver(receiver), /receiver/i);
          await f.owner.query(
            'REVOKE UPDATE ON reconciliation.refund_events FROM reconciliation_receiver_test',
          );
        } finally {
          await receiver.end();
          await f.owner.query('DROP OWNED BY reconciliation_receiver_test');
          await f.owner.query('DROP ROLE reconciliation_receiver_test');
        }
      },
    );
    await t.test(
      'unmatched observations age and late receipts repair them without rewriting events',
      async () => {
        const outside = { ...event(3), refundId: 'OUTSIDE12345678901' };
        await reconciliation.receive(f.owner, outside);
        await f.owner.query(
          "UPDATE reconciliation.refund_events SET received_at=clock_timestamp()-interval '6 minutes'",
        );
        let data = await reconciliation.read(f.app);
        assert.equal(
          data.items.filter((item) => item.state === 'unmediated').length,
          1,
        );
        const attempt = request('5.00');
        const allowed = await f.velocity.evaluateAndReserve(
          policy('allow'),
          attempt,
        );
        const result = {
          executionId: attempt.requestId,
          captureId: outside.captureId,
          id: outside.refundId,
          status: 'COMPLETED',
          amount: { value: '5.00', currency_code: 'USD' },
        };
        await assert.rejects(
          reconciliation.record(f.app, allowed.receipt, {
            ...result,
            status: 'PENDING',
          }),
        );
        await assert.rejects(
          reconciliation.record(f.app, allowed.receipt, {
            ...result,
            executionId: input.requestId,
          }),
        );
        await reconciliation.record(f.app, allowed.receipt, result);
        await reconciliation.record(f.app, allowed.receipt, result);
        data = await reconciliation.read(f.app);
        assert.equal(
          data.items.filter((item) => item.state === 'unmediated').length,
          0,
        );
        assert.equal(
          data.items.every((item) => item.state === 'matched'),
          true,
        );
        assert.equal(
          data.items.every(
            (item) =>
              new Date(item.received_at).getTime() < Date.now() - 300000,
          ),
          true,
        );
      },
    );
    await t.test(
      'refund identity, capture and amount determine matching, not coincident timestamps',
      async () => {
        for (const [index, changed] of [
          { refundId: 'OTHERREFUND1234567' },
          { captureId: 'OTHERCAPTURE123456' },
          { usdCents: 600 },
        ].entries()) {
          const next = { ...event(10 + index), ...changed };
          await reconciliation.receive(f.owner, next);
        }
        const data = await reconciliation.read(f.app);
        assert.equal(
          data.items.filter((item) => item.state === 'pending').length,
          1,
        );
        assert.equal(
          data.items.filter((item) => item.state === 'mismatch').length,
          2,
        );
        assert.equal(
          (
            await new Reconciliation({
              ...options,
              merchantId: 'merchantB',
            }).read(f.app)
          ).items.length,
          0,
        );
        assert.equal(
          (
            await new Reconciliation({
              ...options,
              adapterRef: 'b'.repeat(64),
            }).read(f.app)
          ).items.length,
          0,
        );
        await assert.rejects(
          new Reconciliation({ ...options, identityKey: 'c'.repeat(64) }).read(
            f.app,
          ),
          /unavailable/,
        );
      },
    );
    await t.test(
      'changing the linked audit row cannot preserve a matched receipt',
      async () => {
        await f.owner.query(
          'UPDATE audit.audit_events SET upstream_result_ref=$1 WHERE event_kind=$2',
          [input.requestId, 'approval_executed'],
        );
        await reconciliation.receive(f.owner, {
          ...event(40),
          refundId: 'REFUND123456789099',
          usdCents: 600,
        });
        const data = await reconciliation.read(f.app);
        assert.equal(
          data.items.filter((item) => item.state === 'mismatch').length,
          3,
        );
      },
    );
    await t.test(
      'local dashboard reads the persisted reconciliation projection',
      async () => {
        // Restore the unrelated lifecycle field before the existing dashboard folds it.
        await f.owner
          .query(`UPDATE audit.audit_events e SET upstream_result_ref=r.execution_id
      FROM reconciliation.refund_receipts r WHERE e.id=r.audit_id AND e.event_kind='approval_executed'`);
        const server = await startDashboardServer({
          pool: f.app,
          identityKey: key,
          merchantId: 'merchantA',
          token: '8'.repeat(64),
          reconciliation: { adapterRef },
        });
        try {
          const response = await fetch(`${server.url}/stats`, {
            headers: { authorization: `Bearer ${'8'.repeat(64)}` },
          });
          assert.equal(response.status, 200);
          const stats = await response.json();
          assert.equal(stats.reconciliation.items.length, 7);
          assert.equal(
            stats.reconciliation.items.filter(
              (item) => item.state === 'mismatch',
            ).length,
            2,
          );
        } finally {
          await server.close();
        }
        await assert.rejects(
          startDashboardServer({
            pool: f.app,
            identityKey: key,
            merchantId: 'merchantA',
            token: '8'.repeat(64),
            hosted: { publicOrigin: 'https://example.invalid' },
            reconciliation: { adapterRef },
          }),
          /configuration/,
        );
      },
    );
    await t.test(
      'hosted reader rejects accidental reconciliation privileges',
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
        const target = new URL(url);
        target.username = 'spendwall_dashboard_reader';
        target.password = 'hosted-test-only';
        const reader = new pg.Pool({ connectionString: target.toString() });
        try {
          await checkHostedReader(reader);
          await f.owner.query(
            'GRANT USAGE ON SCHEMA reconciliation TO spendwall_dashboard_reader',
          );
          await f.owner.query(
            'GRANT SELECT (event_ref) ON reconciliation.refund_events TO spendwall_dashboard_reader',
          );
          await assert.rejects(checkHostedReader(reader), /unavailable/);
        } finally {
          await reader.end();
          await f.owner.query('DROP OWNED BY spendwall_dashboard_reader');
          await f.owner.query('DROP ROLE spendwall_dashboard_reader');
        }
      },
    );
    await t.test(
      'receipt failure rolls back approval completion instead of acknowledging success',
      async () => {
        const service = new ApprovalService(f.app, {
          ...options,
          reconciliation: true,
          executor: {
            identity: adapterRef,
            execute: async (id, args) => ({
              executionId: id,
              captureId: args.capture_id,
              id: 'REFUND123456789012',
              status: 'COMPLETED',
              amount: args.amount,
            }),
            reconcile: async () => {
              throw new Error();
            },
          },
        });
        const input = request('9.00'),
          loaded = policy('require_approval');
        const pending = await service.request(loaded, input);
        const detail = await service.details({
          approvalId: pending.approval_id,
          agentId: 'support',
        });
        await assert.rejects(
          service.decide(
            {
              approvalId: pending.approval_id,
              agentId: 'support',
              decision: 'approve',
              argsHash: detail.args_hash,
            },
            async () => ({ input, policy: loaded }),
          ),
        );
        const stored = (
          await f.app.query(
            'SELECT execution_state FROM approvals.requests WHERE approval_id=$1',
            [pending.approval_id],
          )
        ).rows[0];
        assert.equal(stored.execution_state, 'in_flight');
        const completed = await f.app.query(
          "SELECT id FROM audit.audit_events WHERE approval_id=$1 AND event_kind='approval_executed'",
          [pending.approval_id],
        );
        assert.equal(completed.rows.length, 0);
      },
    );
    await t.test(
      'observation overflow is unavailable rather than a partial clean report',
      async () => {
        await f.owner
          .query(`INSERT INTO reconciliation.refund_events (adapter_ref,event_ref,payload_hash,key_id,merchant_ref,refund_ref,capture_ref,usd_cents)
      SELECT adapter_ref, encode(sha256(convert_to('extra-'||n,'UTF8')),'hex'),payload_hash,key_id,merchant_ref,refund_ref,capture_ref,usd_cents
      FROM (SELECT * FROM reconciliation.refund_events LIMIT 1) sample CROSS JOIN generate_series(1,1001) n`);
        await assert.rejects(reconciliation.read(f.app), /limit/);
      },
    );
  },
);
