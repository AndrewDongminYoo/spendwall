import type { Pool, PoolClient } from 'pg';
import type { AuditReceipt } from '../audit/index.ts';
import type { RefundResult } from '../refunds.ts';
import type { VerifiedRefund } from './paypal.ts';
import { usdCents } from './paypal.ts';
import { createHmac } from 'node:crypto';
import { canonical } from '../refunds.ts';
import { identifier, snapshot } from '../context/json.ts';

type Database = Pick<Pool | PoolClient, 'query'>;
// Reports whether dispute tracking (migration 013) is installed; without it,
// the receiver acknowledges dispute events as ignored.
export async function checkWebhookReceiver(
  db: Database,
): Promise<{ disputeTracking: boolean }> {
  try {
    const result = await db.query<{
      restricted: boolean;
      dispute_tracking: boolean;
    }>(`
      WITH principals AS (SELECT oid FROM pg_roles
        WHERE rolname=current_user OR pg_has_role(current_user,oid,'MEMBER'))
      SELECT NOT (
        EXISTS (SELECT FROM pg_roles WHERE (rolname=current_user OR pg_has_role(current_user,oid,'MEMBER'))
          AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
        OR EXISTS (SELECT FROM pg_roles r
          WHERE r.rolname <> current_user AND pg_has_role(current_user,r.oid,'MEMBER')
          AND r.rolname <> 'spendwall_webhook_' || left(encode(sha256(convert_to(current_database(),'UTF8')),'hex'),40))
        OR EXISTS (SELECT FROM pg_database CROSS JOIN principals r WHERE datname=current_database() AND pg_has_role(r.oid,datdba,'USAGE'))
        OR EXISTS (SELECT FROM pg_namespace n CROSS JOIN principals r WHERE nspname IN ('audit','approvals','approver','agent_auth','policy_replay','reconciliation','invoice_policy','orders','disputes')
          AND (pg_has_role(r.oid,nspowner,'USAGE') OR has_schema_privilege(r.oid,n.oid,'CREATE')))
        OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN principals r
          WHERE n.nspname IN ('audit','approvals','approver','agent_auth','policy_replay','reconciliation','invoice_policy','orders','disputes')
          AND ((c.relkind IN ('r','p','v','m','f') AND (
            has_table_privilege(r.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_any_column_privilege(r.oid,c.oid,'UPDATE,REFERENCES')
            OR EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
              AND ((has_column_privilege(r.oid,c.oid,a.attnum,'SELECT') AND NOT ((n.nspname='reconciliation' AND c.relname='refund_events')
                  OR (n.nspname='disputes' AND c.relname='events')))
                OR (has_column_privilege(r.oid,c.oid,a.attnum,'INSERT') AND NOT ((n.nspname='reconciliation' AND c.relname='refund_events'
                  AND a.attname IN ('adapter_ref','event_ref','payload_hash','key_id','merchant_ref','refund_ref','capture_ref','usd_cents'))
                  OR (n.nspname='disputes' AND c.relname='events'
                  AND a.attname IN ('adapter_ref','merchant_ref','event_ref','payload_hash','event_type','dispute_id','seller_transaction_id'))))))))
            OR (c.relkind='S' AND has_sequence_privilege(r.oid,c.oid,'SELECT,USAGE,UPDATE'))))
        OR EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          CROSS JOIN principals r
          WHERE n.nspname IN ('audit','approvals','approver','agent_auth','policy_replay','reconciliation','invoice_policy','orders','disputes')
          AND p.prosecdef AND has_function_privilege(r.oid,p.oid,'EXECUTE'))
      ) AND has_schema_privilege('reconciliation','USAGE')
        AND has_table_privilege('reconciliation.refund_events','SELECT')
        AND NOT EXISTS (SELECT FROM unnest(ARRAY['adapter_ref','event_ref','payload_hash','key_id','merchant_ref','refund_ref','capture_ref','usd_cents']) AS field
          WHERE NOT has_column_privilege('reconciliation.refund_events',field,'INSERT'))
        -- Once dispute tracking is installed, the receiver must be able to store its events.
        AND CASE WHEN NOT EXISTS (SELECT FROM pg_namespace WHERE nspname='disputes') THEN true ELSE
          has_schema_privilege('disputes','USAGE')
          AND has_table_privilege('disputes.events','SELECT')
          AND NOT EXISTS (SELECT FROM unnest(ARRAY['adapter_ref','merchant_ref','event_ref','payload_hash','event_type','dispute_id','seller_transaction_id']) AS field
            WHERE NOT has_column_privilege('disputes.events',field,'INSERT')) END AS restricted,
        EXISTS (SELECT FROM pg_namespace WHERE nspname='disputes') AS dispute_tracking`);
    const row = result.rows[0];
    if (row?.restricted !== true || typeof row.dispute_tracking !== 'boolean')
      throw new Error();
    return { disputeTracking: row.dispute_tracking };
  } catch {
    throw new Error('Webhook receiver database permissions unavailable.');
  }
}
export type ReconciliationData = {
  coverage: string;
  items: {
    reference: string;
    received_at: string;
    usd: number;
    state: 'pending' | 'matched' | 'unmediated' | 'mismatch';
    audit_id: string | null;
  }[];
};
export class Reconciliation {
  readonly #key: Buffer;
  private readonly scope: {
    adapter_ref: string;
    key_id: string;
    merchant_ref: string;
  };
  constructor(options: {
    identityKey: string;
    merchantId: string;
    adapterRef: string;
  }) {
    if (
      !/^[a-f0-9]{64}$/i.test(options.identityKey) ||
      !/^[a-f0-9]{64}$/.test(options.adapterRef)
    )
      throw new Error('Invalid reconciliation configuration.');
    identifier(options.merchantId);
    this.#key = Buffer.from(options.identityKey, 'hex');
    const velocity = (domain: string, value: string) =>
      createHmac('sha256', this.#key)
        .update(JSON.stringify(['spendwall/velocity', 1, domain, value]))
        .digest('hex');
    this.scope = {
      adapter_ref: options.adapterRef,
      key_id: velocity('key', 'continuity'),
      merchant_ref: velocity('merchant', options.merchantId),
    };
  }
  private ref(domain: string, value: unknown) {
    return createHmac('sha256', this.#key)
      .update(canonical(['spendwall/reconciliation', 1, domain, value]))
      .digest('hex');
  }
  private refund(refundId: string, captureId: string) {
    return {
      refund_ref: this.ref('refund', identifier(refundId, 15, 32)),
      capture_ref: this.ref('capture', identifier(captureId, 15, 32)),
    };
  }
  async record(
    db: Database,
    audit: AuditReceipt,
    result: RefundResult,
  ): Promise<void> {
    if (result.status !== 'COMPLETED')
      throw new Error('Completed refund required.');
    const payload = {
      ...this.scope,
      ...this.refund(result.id, result.captureId),
      usd_cents: usdCents(result.amount),
      audit_id: audit.id,
      audit_hash: audit.row_hash,
      execution_id: result.executionId,
    };
    await db.query('SELECT reconciliation.record_refund($1::jsonb)', [
      JSON.stringify(payload),
    ]);
  }
  async receive(db: Database, event: VerifiedRefund): Promise<void> {
    identifier(event.eventId, 1, 255);
    if (
      !Number.isSafeInteger(event.usdCents) ||
      event.usdCents < 1 ||
      event.usdCents > 1_000_000_000
    )
      throw new Error('Invalid refund observation.');
    const data = {
      ...this.scope,
      ...this.refund(event.refundId, event.captureId),
      event_ref: this.ref('event', event.eventId),
      payload_hash: this.ref('payload', snapshot(event.payload)),
      usd_cents: event.usdCents,
    };
    const inserted = await db.query(
      `INSERT INTO reconciliation.refund_events (adapter_ref,event_ref,payload_hash,key_id,merchant_ref,refund_ref,capture_ref,usd_cents)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING event_ref`,
      [
        data.adapter_ref,
        data.event_ref,
        data.payload_hash,
        data.key_id,
        data.merchant_ref,
        data.refund_ref,
        data.capture_ref,
        data.usd_cents,
      ],
    );
    if (inserted.rowCount === 1) return;
    const { rows } = await db.query<{ matches: boolean }>(
      `SELECT payload_hash=$3 AND key_id=$4 AND merchant_ref=$5 AND refund_ref=$6 AND capture_ref=$7 AND usd_cents=$8 AS matches
      FROM reconciliation.refund_events WHERE adapter_ref=$1 AND event_ref=$2`,
      [
        data.adapter_ref,
        data.event_ref,
        data.payload_hash,
        data.key_id,
        data.merchant_ref,
        data.refund_ref,
        data.capture_ref,
        data.usd_cents,
      ],
    );
    if (rows[0]?.matches !== true)
      throw new Error('Conflicting webhook event.');
  }
  async read(db: Database): Promise<ReconciliationData> {
    const continuity = await db.query<{ mismatch: boolean }>(
      `SELECT EXISTS (SELECT FROM reconciliation.refund_events WHERE key_id<>$1)
        OR EXISTS (SELECT FROM reconciliation.refund_receipts WHERE key_id<>$1) AS mismatch`,
      [this.scope.key_id],
    );
    if (continuity.rows[0]?.mismatch !== false)
      throw new Error('Reconciliation unavailable.');
    const { rows } = await db.query<ReconciliationData['items'][number]>(
      `SELECT w.event_ref AS reference, w.received_at::text, (w.usd_cents::float8/100) AS usd,
        CASE WHEN r.refund_ref IS NOT NULL THEN
          CASE WHEN r.capture_ref=w.capture_ref AND r.usd_cents=w.usd_cents AND reconciliation.valid_receipt(r,e)
            THEN 'matched' ELSE 'mismatch' END
          WHEN w.received_at>clock_timestamp()-interval '5 minutes' THEN 'pending' ELSE 'unmediated' END AS state,
        CASE WHEN r.refund_ref IS NOT NULL THEN r.audit_id::text ELSE NULL END AS audit_id
      FROM reconciliation.refund_events w
      LEFT JOIN reconciliation.refund_receipts r ON r.adapter_ref=w.adapter_ref AND r.refund_ref=w.refund_ref
        AND r.merchant_ref=w.merchant_ref AND r.key_id=w.key_id
      LEFT JOIN audit.audit_events e ON e.id=r.audit_id
      WHERE w.adapter_ref=$1 AND w.merchant_ref=$2 AND w.key_id=$3
      ORDER BY w.received_at DESC,w.event_ref LIMIT 1001`,
      [this.scope.adapter_ref, this.scope.merchant_ref, this.scope.key_id],
    );
    if (rows.length > 1000)
      throw new Error('Reconciliation observation limit reached.');
    return {
      coverage:
        'Observed sandbox USD refunds only. Unmediated means no matching firewall completion evidence after five minutes; it does not prove a bypass or complete PayPal coverage.',
      items: rows.map((row) => ({
        ...row,
        received_at: new Date(row.received_at).toISOString(),
      })),
    };
  }
}
