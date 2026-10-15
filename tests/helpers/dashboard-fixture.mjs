import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadPolicy } from '../../packages/policy/src/index.ts';
import { ApprovalService } from '../../apps/firewall/src/approvals/index.ts';
import { VelocityPolicy } from '../../apps/firewall/src/velocity/index.ts';
import { startDashboardServer } from '../../apps/firewall/src/dashboard/server.ts';

export const key = '7'.repeat(64),
  token = '8'.repeat(64);
export const policy = (then) =>
  loadPolicy(
    JSON.stringify({
      agents: {
        support: { tools: { allow: ['create_refund'], deny: [] } },
        returns: { tools: { allow: ['create_refund'], deny: [] } },
      },
      rules: [{ id: 'refund-review', when: 'true', then }],
      default: 'deny',
    }),
  );
export function request(
  value = '60.00',
  agent = 'support',
  merchant = 'merchantA',
) {
  return {
    requestId: randomUUID(),
    context: {
      tool: 'create_refund',
      args: { capture_id: 'CAPTURE12345678901' },
      amount: { value, currency: 'USD' },
      agent: { id: agent },
      customer: { id: 'private-customer', email: 'private@example.invalid' },
      merchant: { id: merchant },
      agg: {},
    },
    resolvedCtx: {},
  };
}
export async function dashboardFixture(url, staticDirectory) {
  const target = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/spendwall_audit_test');
  const owner = new pg.Pool({ connectionString: url });
  let app, server, group;
  const close = async () => {
    await server?.close();
    await app?.end();
    try {
      if (group) {
        await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(group)}`);
        await owner.query(`DROP ROLE ${pg.escapeIdentifier(group)}`);
      }
    } finally {
      await owner.end();
    }
  };
  try {
    await owner.query('DROP SCHEMA IF EXISTS approvals CASCADE');
    await owner.query('DROP SCHEMA IF EXISTS audit CASCADE');
    for (const file of [
      '001-audit.sql',
      '002-velocity.sql',
      '003-approvals.sql',
    ])
      await owner.query(
        await readFile(
          new URL('../../migrations/' + file, import.meta.url),
          'utf8',
        ),
      );
    group = (await owner.query('SELECT audit.app_role() AS name')).rows[0].name;
    await owner.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='dashboard_test_login') THEN CREATE ROLE dashboard_test_login LOGIN PASSWORD 'dashboard-test-only'; END IF; END $$",
    );
    await owner.query(
      `GRANT ${pg.escapeIdentifier(group)} TO dashboard_test_login`,
    );
    target.username = 'dashboard_test_login';
    target.password = 'dashboard-test-only';
    app = new pg.Pool({
      connectionString: target.toString(),
      max: 4,
      connectionTimeoutMillis: 2000,
    });
    let executions = 0;
    const executor = {
      identity: 'a'.repeat(64),
      execute: async (id, args) => {
        executions++;
        return {
          executionId: id,
          captureId: args.capture_id,
          id: 'REFUND123456789012',
          status: 'COMPLETED',
          amount: args.amount,
        };
      },
      reconcile: async () => {
        throw new Error('No external calls.');
      },
    };
    const service = new ApprovalService(app, {
      identityKey: key,
      merchantId: 'merchantA',
      executor,
    });
    const velocity = new VelocityPolicy(app, { identityKey: key });
    server = await startDashboardServer({
      pool: app,
      identityKey: key,
      merchantId: 'merchantA',
      token,
      agents: [
        { id: 'support', name: 'Support bot', budgetCents: 20000 },
        { id: 'returns', name: 'Returns bot', budgetCents: 10000 },
      ],
      ...(staticDirectory ? { staticDirectory } : {}),
    });
    const addPending = async (value = '60.00', agent = 'support') => {
      const input = request(value, agent),
        loaded = policy('require_approval');
      const result = await service.request(loaded, input);
      assert.equal(result.status, 'pending_approval');
      return { input, loaded, id: result.approval_id };
    };
    const approve = async (entry) => {
      const detail = await service.details({
        agentId: entry.input.context.agent.id,
        approvalId: entry.id,
      });
      return service.decide(
        {
          agentId: entry.input.context.agent.id,
          approvalId: entry.id,
          decision: 'approve',
          argsHash: detail.args_hash,
        },
        async () => ({ input: entry.input, policy: entry.loaded }),
      );
    };
    return {
      owner,
      app,
      server,
      service,
      velocity,
      addPending,
      approve,
      get executions() {
        return executions;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
