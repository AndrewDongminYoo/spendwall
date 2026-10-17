import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { loadPolicy } from '../../../packages/policy/src/index.ts';
import { ContextResolver } from '../../firewall/src/context/index.ts';
import { RefundExecutor } from '../../firewall/src/refunds.ts';
import { Reconciliation } from '../../firewall/src/webhooks/reconciliation.ts';
import { ApprovalService } from '../../firewall/src/approvals/index.ts';
import { checkApproval } from '../../firewall/src/approvals/tool.ts';
import { recordedPayments } from './payments.ts';

export const refundScenarios = [
  'small',
  'approval',
  'injection',
  'velocity',
] as const;
export const scenarios = [...refundScenarios, 'shopping'] as const;
export type RefundScenario = (typeof refundScenarios)[number];
export type Scenario = (typeof scenarios)[number];
export type Ticket = {
  id: RefundScenario;
  customerId: string;
  body: string;
  captures: string[];
  recordedCalls: { capture_id: string }[];
};
export async function readTicket(name: RefundScenario): Promise<Ticket> {
  return JSON.parse(
    await readFile(new URL(`../tickets/${name}.json`, import.meta.url), 'utf8'),
  );
}

export type DecisionEvent = {
  decision: string;
  reason: string;
  capture?: string;
  order?: string;
};
const agentId = 'demo-support';

// Each demo owns one disposable database and an application login limited to the audit app group.
export async function openDemoDatabase(ownerUrl: string, files: string[]) {
  const database = `demo_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: ownerUrl });
  let owner: pg.Pool | undefined, app: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)}`);
    const target = new URL(ownerUrl);
    target.pathname = `/${database}`;
    owner = new pg.Pool({ connectionString: target.toString() });
    for (const file of files)
      await owner.query(
        await readFile(
          new URL(`../../../migrations/${file}`, import.meta.url),
          'utf8',
        ),
      );
    const group: string = (await owner.query('SELECT audit.app_role() AS name'))
      .rows[0].name;
    const login = `${database}_app`;
    const password = randomBytes(24).toString('hex');
    await owner.query(
      `CREATE ROLE ${pg.escapeIdentifier(login)} LOGIN PASSWORD ${pg.escapeLiteral(password)}`,
    );
    await owner.query(
      `GRANT ${pg.escapeIdentifier(group)} TO ${pg.escapeIdentifier(login)}`,
    );
    target.username = login;
    target.password = password;
    app = new pg.Pool({
      connectionString: target.toString(),
      connectionTimeoutMillis: 2000,
    });
    const pools = { owner, app };
    return {
      ...pools,
      async close() {
        await pools.app.end();
        await pools.owner.end();
        await admin.end();
      },
    };
  } catch (error) {
    await app?.end();
    await owner?.end();
    await admin.end();
    throw error;
  }
}

// This composition is exclusively for synthetic demos. It never accepts a payment provider URL.
export async function createDemo(
  ownerUrl: string,
  sourceTicket: Ticket,
  emit: (event: DecisionEvent) => void = () => {},
) {
  const ticket = structuredClone(sourceTicket);
  const database = await openDemoDatabase(ownerUrl, [
    '001-audit.sql',
    '002-velocity.sql',
    '003-approvals.sql',
    '007-reconciliation.sql',
  ]);
  const app = database.app;
  let executor: RefundExecutor | undefined;
  let directory: string | undefined;
  const payment = recordedPayments();
  try {
    directory = await mkdtemp(join(tmpdir(), 'spendwall-demo-'));
    executor = await RefundExecutor.open({
      ledgerPath: join(directory, 'refunds.json'),
      env: {
        PAYPAL_CLIENT_ID: 'synthetic-demo-client',
        PAYPAL_CLIENT_SECRET: 'synthetic-demo-secret',
      },
      fetchImpl: payment.fetchImpl,
    });
    const refunds = executor;
    const resolver = new ContextResolver({
      fetchImpl: payment.fetchImpl,
      tokens: {
        get: async () => 'synthetic-demo-token',
        isSensitive: () => false,
      },
      merchant: { id: payment.merchantId, email: 'merchant@example.test' },
    });
    const policy = loadPolicy(
      await readFile(new URL('../policy.yaml', import.meta.url), 'utf8'),
    );
    const identityKey = randomBytes(32).toString('hex');
    const reconciliation = new Reconciliation({
      identityKey,
      merchantId: payment.merchantId,
      adapterRef: refunds.identity,
    });
    const approvals = new ApprovalService(app, {
      identityKey,
      merchantId: payment.merchantId,
      executor: refunds,
      reconciliation: true,
    });
    const pending = new Set<string>();
    const receiptRecoveries = new Map<string, () => Promise<void>>();
    const events: DecisionEvent[] = [];
    const record = (event: DecisionEvent) => {
      events.push(event);
      emit(event);
    };
    const result = (value: Record<string, unknown>, isError = false) => ({
      isError,
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent: value,
    });
    const resolve = (args: { capture_id: string }) =>
      resolver.resolve(
        { tool: 'create_refund', args },
        {
          agent: { id: agentId },
          customer: { id: ticket.customerId, email: 'customer@example.test' },
          agg: {},
        },
      );
    const server = createSdkMcpServer({
      name: 'firewall',
      version: '1.0.0',
      tools: [
        tool(
          'create_refund',
          'Request a full refund for one capture on this ticket. Policy may deny or require human approval.',
          { capture_id: z.string().min(15).max(32) },
          async (args) => {
            const denied = (reason: string) => {
              record({ decision: 'deny', reason, capture: args.capture_id });
              return result({ decision: 'deny', reason }, true);
            };
            if (!ticket.captures.includes(args.capture_id))
              return denied('ticket_scope');
            try {
              resolver.invalidateCapture(args.capture_id);
              const resolved = await resolve(args);
              if (!resolved.ok) return denied(resolved.reason);
              const requestId = randomUUID();
              const outcome = await approvals.request(policy, {
                requestId,
                context: resolved.context,
                resolvedCtx: resolved.resolvedCtx,
              });
              if ('decision' in outcome) {
                const reason =
                  outcome.matchedRules.join(',') ||
                  outcome.reason ||
                  'default_deny';
                record({
                  decision: outcome.decision,
                  reason,
                  capture: args.capture_id,
                });
                if (outcome.decision !== 'allow')
                  return result({ ...outcome, reason }, true);
                const audit = outcome.receipt;
                if (!audit) return denied('firewall_unavailable');
                const completed = await refunds.execute(requestId, {
                  ...args,
                  amount: {
                    value: resolved.context.amount.value,
                    currency_code: resolved.context.amount.currency,
                  },
                });
                if (completed.status === 'COMPLETED') {
                  const recover = () =>
                    reconciliation.record(app, audit, completed);
                  receiptRecoveries.set(completed.executionId, recover);
                  try {
                    await recover();
                    receiptRecoveries.delete(completed.executionId);
                  } catch {
                    return result({
                      decision: 'allow',
                      reason,
                      result: completed,
                      reconciliation: 'unresolved',
                      message:
                        'Refund completed. Do not submit another refund; the operator must recover its reconciliation receipt using this execution ID.',
                    });
                  }
                }
                return result({ decision: 'allow', reason, result: completed });
              }
              if (outcome.status === 'pending_approval') {
                pending.add(outcome.approval_id);
                record({
                  decision: 'pending_approval',
                  reason: 'human_approval',
                  capture: args.capture_id,
                });
              }
              return result({ ...outcome });
            } catch {
              return denied('firewall_unavailable');
            }
          },
        ),
        tool(
          'check_approval',
          'Read an approval status. This cannot approve or execute a refund.',
          { approval_id: z.string().uuid() },
          async (args) => checkApproval(approvals, { agentId }, args),
        ),
      ],
    });
    return {
      server,
      ticket,
      events,
      payments: payment.writes,
      pendingIds: () => [...pending],
      // Receipt-only recovery belongs to the runner, never an agent tool.
      async recoverReconciliation(executionId: string) {
        const recover = receiptRecoveries.get(executionId);
        if (!recover) throw new Error('Unknown demo receipt recovery.');
        await recover();
        receiptRecoveries.delete(executionId);
      },
      // The runner holds this capability. It is never exposed as an agent tool.
      async humanDetails(id: string) {
        if (!pending.has(id)) throw new Error('Unknown demo approval.');
        return approvals.details({ agentId, approvalId: id });
      },
      async humanDecision(
        id: string,
        decision: 'approve' | 'deny',
        argsHash?: string,
      ) {
        if (!pending.has(id)) throw new Error('Unknown demo approval.');
        const details = await approvals.details({ agentId, approvalId: id });
        const view = await approvals.decide(
          {
            agentId,
            approvalId: id,
            decision,
            argsHash: argsHash ?? details.args_hash,
          },
          async ({ input }) => {
            const capture = String(input.context.args.capture_id);
            if (!ticket.captures.includes(capture))
              throw new Error('Ticket scope changed.');
            resolver.invalidateCapture(capture);
            const fresh = await resolve({ capture_id: capture });
            if (!fresh.ok) throw new Error('Context unavailable.');
            return {
              policy,
              input: {
                requestId: input.requestId,
                context: fresh.context,
                resolvedCtx: fresh.resolvedCtx,
              },
            };
          },
        );
        pending.delete(id);
        record({
          decision: view.status,
          reason: view.execution_state ?? 'human_decision',
        });
        return view;
      },
      async close() {
        await server.instance.close();
        await refunds.close();
        await database.close();
        await rm(directory!, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await executor?.close();
    await database.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export type Demo = Awaited<ReturnType<typeof createDemo>>;
