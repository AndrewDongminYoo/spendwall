import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadPolicy } from '../../../packages/policy/src/index.ts';
import { DeviceAuthority } from '../../firewall/src/approver/identity.ts';
import { ContextResolver } from '../../firewall/src/context/index.ts';
import {
  DisputeEvents,
  DisputeTracker,
} from '../../firewall/src/disputes/tracking.ts';
import type { SaleCustomer } from '../../firewall/src/disputes/tracking.ts';
import { openDemoDatabase } from './firewall.ts';
import { recordedPayments } from './payments.ts';
import type { SyntheticDispute } from './payments.ts';

export type DisputeTicket = {
  id: 'dispute';
  customerId: string;
  disputeId: string;
  sellerTransactionId: string;
  amount: SyntheticDispute['amount'];
  gross: SyntheticDispute['gross'];
  // The seller deadline, in hours after the demo clock; inside 24 hours it
  // classifies as due_soon.
  deadlineHours: number;
};
// The only agent that the sample dispute policy allows to review a claim.
const agentId = 'support';
const deviceId = 'demo-approver';
const hour = 3_600_000;

export async function readDisputeTicket(): Promise<DisputeTicket> {
  return JSON.parse(
    await readFile(new URL('../tickets/dispute.json', import.meta.url), 'utf8'),
  );
}

// A demo stand-in for a merchant's customer system: a fixed in-memory mapping
// from the ticket's sale to its synthetic customer. A deployment supplies its
// own authenticated customer records instead.
export function syntheticSaleCustomer(
  ticket: Pick<DisputeTicket, 'customerId' | 'sellerTransactionId'>,
): SaleCustomer {
  const customers = new Map([
    [
      ticket.sellerTransactionId,
      { id: ticket.customerId, email: 'customer@example.test' },
    ],
  ]);
  return (sellerTransactionId) => {
    const customer = customers.get(sellerTransactionId);
    return customer && { ...customer };
  };
}

// This composition is exclusively for the synthetic dispute demo. It never
// accepts a payment provider URL, accepts a claim or sends a push message.
export async function createDisputeDemo(
  ownerUrl: string,
  sourceTicket: DisputeTicket,
) {
  const ticket = structuredClone(sourceTicket);
  if (
    !Number.isSafeInteger(ticket.deadlineHours) ||
    ticket.deadlineHours < 1 ||
    ticket.deadlineHours > 23
  )
    throw new Error('The dispute ticket deadline must fall inside 24 hours.');
  // One fixed instant for the whole run. The tracker compares it with check
  // times that the event trigger sets from the database clock, and it ends
  // tracking 180 days after the first event, so the instant is ten minutes
  // ahead of the current time rather than a calendar date.
  const clock = Math.ceil(Date.now() / 1000) * 1000 + 10 * 60_000;
  const now = () => clock;
  const dueAt = new Date(clock + ticket.deadlineHours * hour).toISOString();
  const payment = recordedPayments({
    disputes: [
      {
        id: ticket.disputeId,
        sellerTransactionId: ticket.sellerTransactionId,
        amount: ticket.amount,
        gross: ticket.gross,
        dueAt,
      },
    ],
  });
  const database = await openDemoDatabase(ownerUrl, [
    '001-audit.sql',
    '002-velocity.sql',
    '003-approvals.sql',
    '011-approval-guards.sql',
    '004-approval-api.sql',
    '012-dispute-deadline-alerts.sql',
    '007-reconciliation.sql',
    '013-dispute-tracking.sql',
  ]);
  let receiver: pg.Pool | undefined;
  try {
    // The application group cannot insert events, so events go through a
    // separate login in the webhook receiver group, as in a deployment.
    const owner = database.owner;
    const group: string = (
      await owner.query('SELECT reconciliation.receiver_role() AS name')
    ).rows[0].name;
    const name: string = (
      await owner.query('SELECT current_database() AS name')
    ).rows[0].name;
    const login = `${name}_receiver`;
    const password = randomBytes(24).toString('hex');
    await owner.query(
      `CREATE ROLE ${pg.escapeIdentifier(login)} LOGIN PASSWORD ${pg.escapeLiteral(password)}`,
    );
    await owner.query(
      `GRANT ${pg.escapeIdentifier(group)} TO ${pg.escapeIdentifier(login)}`,
    );
    const target = new URL(ownerUrl);
    target.pathname = `/${name}`;
    target.username = login;
    target.password = password;
    receiver = new pg.Pool({
      connectionString: target.toString(),
      connectionTimeoutMillis: 2000,
    });
    const identityKey = randomBytes(32).toString('hex');
    const credential = randomBytes(32).toString('base64url');
    const devices = new DeviceAuthority(database.app, {
      identityKey,
      signingKey: randomBytes(32).toString('hex'),
      merchantId: payment.merchantId,
      devices: () => [
        {
          deviceId,
          agentId,
          enrollmentHash: createHash('sha256').update(credential).digest('hex'),
        },
      ],
    });
    // One synthetic approver device, so the owner of the review agent has an
    // alert recipient. Its token is never sent anywhere.
    await devices.enroll(deviceId, 'synthetic-demo-device-token', credential);
    const resolver = new ContextResolver({
      fetchImpl: payment.fetchImpl,
      now,
      tokens: {
        get: async () => 'synthetic-demo-token',
        isSensitive: () => false,
      },
      merchant: { id: payment.merchantId, email: 'merchant@example.test' },
    });
    const events = new DisputeEvents({
      identityKey,
      merchantId: payment.merchantId,
      adapterRef: createHash('sha256')
        .update('spendwall.demo.dispute-adapter')
        .digest('hex'),
    });
    // Without alerts, the tracker records into DisputeDeadlineAlerts with no
    // notifier: the alert row is durable and the drain is never run.
    const tracker = new DisputeTracker({
      pool: database.app,
      devices,
      resolver,
      policy: loadPolicy(
        await readFile(
          new URL('../dispute-policy.yaml', import.meta.url),
          'utf8',
        ),
      ),
      agentId,
      saleCustomer: syntheticSaleCustomer(ticket),
      now,
    });
    const receiverPool = receiver;
    return {
      ticket,
      dueAt,
      payments: payment.writes,
      disputeReads: payment.disputeReads,
      // Stores the event as the webhook receiver does after it verifies a
      // delivery. Signature verification is outside the demo.
      async receive() {
        const eventId = 'WH-DEMO-DISPUTE-00001';
        const eventType = 'CUSTOMER.DISPUTE.CREATED';
        await events.receive(receiverPool, {
          kind: 'dispute',
          eventId,
          eventType,
          disputeId: ticket.disputeId,
          sellerTransactionId: ticket.sellerTransactionId,
          payload: {
            id: eventId,
            event_type: eventType,
            resource: { dispute_id: ticket.disputeId },
          },
        });
      },
      tick: () => tracker.tick(),
      async tracked() {
        return (
          await owner.query<{
            last_outcome: string | null;
            ended: string | null;
            failures: number;
            next_check_at: Date;
          }>(
            'SELECT last_outcome,ended,failures,next_check_at FROM disputes.tracked WHERE dispute_id=$1',
            [ticket.disputeId],
          )
        ).rows;
      },
      async alerts() {
        return (
          await owner.query<{
            stage: string;
            state: string;
            attempts: number;
            due_at: Date;
          }>(
            'SELECT stage,state,attempts,due_at FROM approvals.dispute_alerts WHERE dispute_id=$1',
            [ticket.disputeId],
          )
        ).rows;
      },
      async close() {
        await tracker.close();
        await receiverPool.end();
        await database.close();
      },
    };
  } catch (error) {
    await receiver?.end();
    await database.close();
    throw error;
  }
}
export type DisputeDemo = Awaited<ReturnType<typeof createDisputeDemo>>;

// Stores one verified-shape event, runs one tracker tick and checks the
// tracked outcome and the alert row. Returns the number of alert rows.
export async function replayDispute(
  demo: DisputeDemo,
  log: (line: string) => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await demo.receive();
  log(
    `Stored synthetic event CUSTOMER.DISPUTE.CREATED for ${demo.ticket.disputeId}; webhook signature verification is outside the demo.`,
  );
  signal?.throwIfAborted();
  await demo.tick();
  const tracked = await demo.tracked();
  const alerts = await demo.alerts();
  const row = tracked[0];
  const alert = alerts[0];
  if (
    tracked.length !== 1 ||
    row?.last_outcome !== 'due_soon' ||
    row.ended !== null ||
    row.failures !== 0 ||
    row.next_check_at.getTime() !== Date.parse(demo.dueAt) ||
    alerts.length !== 1 ||
    alert?.stage !== 'due_soon' ||
    alert.state !== 'ready' ||
    alert.attempts !== 0 ||
    alert.due_at.getTime() !== Date.parse(demo.dueAt) ||
    demo.payments.length !== 0
  )
    throw new Error(
      `Unexpected dispute scenario outcome: tracked=${tracked.length} outcome=${row?.last_outcome ?? 'none'} failures=${row?.failures ?? 'none'} ended=${row?.ended ?? 'none'} alerts=${alerts.length} reads=${demo.disputeReads()} writes=${demo.payments.length}.`,
    );
  log(
    `Tracker outcome: due_soon; seller deadline ${demo.dueAt}, ${demo.ticket.deadlineHours} hours after the demo clock.`,
  );
  log(
    'Deadline alert recorded for the synthetic approver device and left ready: the alert drain is not run, so no FCM message is sent. No claim is accepted.',
  );
  return alerts.length;
}
