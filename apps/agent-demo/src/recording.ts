import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy } from '../../../packages/policy/src/index.ts';
import { ContextResolver } from '../../firewall/src/context/index.ts';
import { RefundExecutor } from '../../firewall/src/refunds.ts';
import { startApproverServer } from '../../firewall/src/approver/server.ts';
import type { ApproverOptions } from '../../firewall/src/approver/server.ts';
import { DeviceAuthority } from '../../firewall/src/approver/identity.ts';
import { openDemoDatabase } from './firewall.ts';
import type { Ticket } from './firewall.ts';
import { recordedPayments } from './payments.ts';

const agentId = 'demo-support';
const captureId = 'DEMO_CAPTURE_00002';
export type RecordingOptions = Pick<
  ApproverOptions,
  | 'identityKey'
  | 'signingKey'
  | 'devices'
  | 'notifier'
  | 'port'
  | 'pollIntervalMs'
> & {
  // Trusted local fixtures, never values from the approval HTTP API.
  policyFile?: string | URL;
  ticketFile?: string | URL;
};

// Only recordedPayments can reach the executor or resolver. Neither environment
// credentials nor a provider URL can select a live payment implementation.
export async function createRecordingDemo(
  ownerUrl: string,
  options: RecordingOptions,
) {
  const database = await openDemoDatabase(ownerUrl, [
    '001-audit.sql',
    '002-velocity.sql',
    '003-approvals.sql',
    '004-approval-api.sql',
    '007-reconciliation.sql',
    '011-approval-guards.sql',
  ]);
  let directory: string | undefined;
  let executor: RefundExecutor | undefined;
  let api: Awaited<ReturnType<typeof startApproverServer>> | undefined;
  const payment = recordedPayments();
  try {
    directory = await mkdtemp(join(tmpdir(), 'spendwall-recording-'));
    executor = await RefundExecutor.open({
      ledgerPath: join(directory, 'refunds.json'),
      env: {
        PAYPAL_CLIENT_ID: 'synthetic-demo-client',
        PAYPAL_CLIENT_SECRET: 'synthetic-demo-secret',
      },
      fetchImpl: payment.fetchImpl,
    });
    const resolver = new ContextResolver({
      fetchImpl: payment.fetchImpl,
      tokens: {
        get: async () => 'synthetic-demo-token',
        isSensitive: () => false,
      },
      merchant: { id: payment.merchantId, email: 'merchant@example.test' },
    });
    const policy = async () =>
      loadPolicy(
        await readFile(
          options.policyFile ?? new URL('../policy.yaml', import.meta.url),
          'utf8',
        ),
      );
    const resolve = async (capture: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const ticket: Ticket = JSON.parse(
        await readFile(
          options.ticketFile ??
            new URL('../tickets/approval.json', import.meta.url),
          'utf8',
        ),
      );
      if (capture !== captureId || !ticket.captures.includes(capture))
        throw new Error('Recording ticket scope changed.');
      resolver.invalidateCapture(capture);
      const fresh = await resolver.resolve(
        { tool: 'create_refund', args: { capture_id: capture } },
        {
          agent: { id: agentId },
          customer: { id: ticket.customerId, email: 'customer@example.test' },
          agg: {},
        },
      );
      signal?.throwIfAborted();
      if (!fresh.ok) throw new Error('Recording trusted context unavailable.');
      return fresh;
    };
    const authority = new DeviceAuthority(database.app, {
      ...options,
      merchantId: payment.merchantId,
    });
    api = await startApproverServer({
      ...options,
      pool: database.app,
      merchantId: payment.merchantId,
      executor,
      reconciliation: true,
      refresh: async ({ input }, signal) => {
        const fresh = await resolve(
          String(input.context.args.capture_id),
          signal,
        );
        const current = await policy();
        signal.throwIfAborted();
        return {
          policy: current,
          input: {
            requestId: input.requestId,
            context: fresh.context,
            resolvedCtx: fresh.resolvedCtx,
          },
        };
      },
    });
    const server = api;
    const ready = async () => {
      const devices = options
        .devices()
        .filter((grant) => grant.agentId === agentId)
        .map((grant) => authority.deviceRef(grant.deviceId));
      const result = await database.app.query(
        'SELECT 1 FROM approvals.devices WHERE active AND owner_ref=$1 AND device_ref=ANY($2::text[]) LIMIT 1',
        [authority.ownerRef(agentId), devices],
      );
      return result.rows.length > 0;
    };
    const requestId = randomUUID();
    let request: ReturnType<typeof server.service.request> | undefined;
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      payments: payment.writes,
      ready,
      // Trusted runner capability only. The HTTP API has no request-creation route.
      async request() {
        if (closing) throw new Error('Recording closed.');
        if (!(await ready()))
          throw new Error(
            'A registered approver is required before the recording request.',
          );
        request ??= (async () => {
          const fresh = await resolve(captureId);
          return server.service.request(await policy(), {
            requestId,
            context: fresh.context,
            resolvedCtx: fresh.resolvedCtx,
          });
        })();
        return request;
      },
      status: (id: string) => server.service.check({ agentId, approvalId: id }),
      drainNotifications: () => server.drainNotifications(),
      close() {
        closing ??= (async () => {
          await server.close();
          await executor!.close();
          await database.close();
          await rm(directory!, { recursive: true, force: true });
        })();
        return closing;
      },
    };
  } catch (error) {
    await api?.close();
    await executor?.close();
    await database.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
