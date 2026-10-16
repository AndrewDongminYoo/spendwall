import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { withDemoDatabase } from '../apps/agent-demo/src/database.ts';
import { ContextResolver } from '../apps/firewall/src/context/index.ts';
import { InvoicePolicy } from '../apps/firewall/src/invoices/index.ts';
import { verifyAudit } from '../apps/firewall/src/audit/index.ts';
import { loadPolicy } from '../packages/policy/src/index.ts';

if (process.argv.length !== 2) {
  console.error('Usage: node scripts/invoice-demo.mjs');
  process.exit(2);
}
const abort = new AbortController();
const stop = () => abort.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const customer = { id: 'synthetic-customer', email: 'buyer@example.invalid' };
const trusted = { agent: { id: 'support' }, customer, agg: {} };
const money = (value) => ({ value, currency_code: 'USD' });
const draft = (value = '25.00', recipient = customer.email) => ({
  requestId: randomUUID(),
  tool: 'create_invoice',
  args: {
    currency_code: 'USD',
    primary_recipients: [{ billing_info: { email_address: recipient } }],
    items: [
      { name: 'Synthetic item', quantity: '1', unit_amount: money(value) },
    ],
  },
});
const send = () => ({
  requestId: randomUUID(),
  tool: 'send_invoice',
  args: { invoice_id: `INV2-${randomUUID()}` },
});
try {
  await withDemoDatabase(async (url) => {
    const owner = new pg.Pool({ connectionString: url });
    let app;
    try {
      for (const file of ['001-audit.sql', '008-invoice-policy.sql'])
        await owner.query(
          await readFile(
            new URL('../migrations/' + file, import.meta.url),
            'utf8',
          ),
        );
      const group = (await owner.query('SELECT audit.app_role() AS name'))
        .rows[0].name;
      await owner.query(
        "CREATE ROLE invoice_demo_login LOGIN PASSWORD 'synthetic-invoice-only'",
      );
      await owner.query(
        `GRANT ${pg.escapeIdentifier(group)} TO invoice_demo_login`,
      );
      const target = new URL(url);
      target.username = 'invoice_demo_login';
      target.password = 'synthetic-invoice-only';
      app = new pg.Pool({ connectionString: target.toString() });
      const resolver = new ContextResolver({
        merchant: {
          id: 'synthetic-merchant',
          email: 'merchant@example.invalid',
        },
        tokens: {
          get: async () => 'synthetic-invoice-token',
          isSensitive: () => false,
        },
        // Synthetic GET responses only. This adapter does not call fetch.
        fetchImpl: async (url, options) => {
          assert.equal(options.method, 'GET');
          assert.ok(
            String(url).startsWith(
              'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/',
            ),
          );
          const args = draft().args;
          return Response.json({
            id: String(url).split('/').at(-1),
            status: 'DRAFT',
            detail: { currency_code: 'USD' },
            invoicer: { email_address: 'merchant@example.invalid' },
            primary_recipients: args.primary_recipients,
            items: args.items,
            amount: {
              ...money('25.00'),
              breakdown: { item_total: money('25.00') },
            },
          });
        },
      });
      const service = new InvoicePolicy(app, {
        identityKey: '9'.repeat(64),
        resolver,
      });
      const policy = loadPolicy(
        await readFile(
          new URL('../apps/agent-demo/invoice-policy.yaml', import.meta.url),
          'utf8',
        ),
      );
      const rows = [];
      for (const [scenario, input, identity, expected] of [
        ['Valid draft', draft(), trusted, 'allow'],
        ['Amount above USD 100', draft('100.01'), trusted, 'deny'],
        [
          'Disallowed recipient domain',
          draft('25.00', 'buyer@evil.invalid'),
          {
            ...trusted,
            customer: { ...customer, email: 'buyer@evil.invalid' },
          },
          'deny',
        ],
      ]) {
        const result = await service.evaluateAndReserve(
          policy,
          input,
          identity,
        );
        assert.equal(result.decision, expected, scenario);
        rows.push({
          scenario,
          decision: result.decision,
          dispatch: result.dispatchAllowed,
          rules: result.matchedRules.join(', '),
        });
      }
      const requests = [send(), send()];
      const results = await Promise.all(
        requests.map((input) =>
          service.evaluateAndReserve(policy, input, trusted),
        ),
      );
      assert.equal(
        results.filter((result) => result.dispatchAllowed).length,
        1,
      );
      results.forEach((result, i) =>
        rows.push({
          scenario: `Concurrent send ${i + 1}`,
          decision: result.decision,
          dispatch: result.dispatchAllowed,
          rules: result.matchedRules.join(', '),
        }),
      );
      const index = results.findIndex((result) => result.dispatchAllowed);
      const retry = await service.evaluateAndReserve(
        policy,
        requests[index],
        trusted,
      );
      assert.equal(retry.replayed, true);
      assert.equal(retry.dispatchAllowed, false);
      assert.deepEqual(retry.receipt, results[index].receipt);
      rows.push({
        scenario: 'Retry of allowed send',
        decision: retry.decision,
        dispatch: retry.dispatchAllowed,
        rules: 'Original receipt; no new dispatch',
      });
      const audit = await verifyAudit(app);
      assert.equal(audit.ok, true);
      const stored = (
        await app.query(
          "SELECT count(*)::int AS n FROM invoice_policy.decisions WHERE tool='send_invoice' AND decision='allow'",
        )
      ).rows[0].n;
      assert.equal(stored, 1);
      console.table(rows);
      console.log(
        `Verified ${audit.count} audit events; ${stored} send reservation. No invoices were created or sent to PayPal.`,
      );
    } finally {
      await app?.end();
      await owner.end();
    }
  }, abort.signal);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
