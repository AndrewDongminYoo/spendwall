import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadPolicy } from '../packages/policy/src/index.ts';
import { ApprovalService } from '../apps/firewall/src/approvals/index.ts';
import { VelocityPolicy } from '../apps/firewall/src/velocity/index.ts';
import { databaseTls, databaseUrl, hostedConfig } from './hosted-database.mjs';

// Writes one small batch of synthetic refund decisions so that the hosted
// dashboard's 24-hour views stay populated. A scheduled job runs it. Payments
// are synthetic: the executor below never contacts PayPal.
const rowBudget = 9000;
const digits = (length) => Array.from({ length }, () => randomInt(10)).join('');
const cents = (min, max) => (randomInt(min, max + 1) / 100).toFixed(2);

function policy(ruleId, then) {
  return loadPolicy(
    JSON.stringify({
      agents: Object.fromEntries(
        agentIds.map((id) => [
          id,
          { tools: { allow: ['create_refund'], deny: [] } },
        ]),
      ),
      rules: [{ id: ruleId, when: 'true', then }],
      default: 'deny',
    }),
  );
}
function request(value, agent, merchant) {
  return {
    requestId: randomUUID(),
    context: {
      tool: 'create_refund',
      args: { capture_id: `CAPTURE${digits(11)}` },
      amount: { value, currency: 'USD' },
      agent: { id: agent },
      customer: { id: 'synthetic-customer', email: 'buyer@example.invalid' },
      merchant: { id: merchant },
      agg: {},
    },
    resolvedCtx: {},
  };
}

let pool, agentIds;
try {
  if (process.argv.length !== 2) throw new Error();
  const config = await hostedConfig(process.env.SPENDWALL_DASHBOARD_CONFIG);
  const database = databaseUrl(process.env.SPENDWALL_WRITER_DATABASE_URL);
  agentIds = (config.agents ?? []).map((agent) => agent.id);
  if (agentIds.length === 0) throw new Error();
  pool = new pg.Pool({
    connectionString: database.toString(),
    ssl: databaseTls(config.databaseTls, database.hostname),
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  const rows = (
    await pool.query('SELECT count(*)::int AS n FROM audit.audit_events')
  ).rows[0].n;
  if (rows >= rowBudget) {
    console.log('Synthetic writer skipped: the audit row budget is reached.');
  } else {
    const executor = {
      identity: 'a'.repeat(64),
      execute: async (executionId, args) => ({
        executionId,
        captureId: args.capture_id,
        id: `REFUND${digits(12)}`,
        status: 'COMPLETED',
        amount: args.amount,
      }),
      reconcile: async () => {
        throw new Error('No external calls.');
      },
    };
    const options = {
      identityKey: config.identityKey,
      merchantId: config.merchantId,
    };
    const velocity = new VelocityPolicy(pool, options);
    const service = new ApprovalService(pool, { ...options, executor });
    const main = agentIds[0],
      other = agentIds[1] ?? main;
    await velocity.evaluateAndReserve(
      policy('small-refund', 'allow'),
      request(cents(500, 1800), main, config.merchantId),
    );
    await velocity.evaluateAndReserve(
      policy('small-refund', 'allow'),
      request(cents(500, 1800), other, config.merchantId),
    );
    await velocity.evaluateAndReserve(
      policy('refund-over-limit', 'deny'),
      request(cents(12000, 25000), main, config.merchantId),
    );
    const input = request(cents(3000, 9000), main, config.merchantId),
      loaded = policy('manager-review', 'require_approval');
    const pending = await service.request(loaded, input);
    if (pending.status !== 'pending_approval') throw new Error();
    const detail = await service.details({
      agentId: main,
      approvalId: pending.approval_id,
    });
    await service.decide(
      {
        agentId: main,
        approvalId: pending.approval_id,
        decision: 'approve',
        argsHash: detail.args_hash,
      },
      async () => ({ input, policy: loaded }),
    );
    console.log('Synthetic writer added one batch of synthetic refunds.');
  }
} catch {
  console.error(
    'Synthetic writer failed. Check the writer URL and private configuration.',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
