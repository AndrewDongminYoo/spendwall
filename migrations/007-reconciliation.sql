-- Apply as the trusted owner after 001 through 003. No audit rows are rewritten.
BEGIN;
CREATE SCHEMA reconciliation;
REVOKE ALL ON SCHEMA reconciliation FROM PUBLIC;
CREATE FUNCTION reconciliation.receiver_role() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT 'spendwall_webhook_' || left(encode(sha256(convert_to(current_database(), 'UTF8')), 'hex'), 40) $$;
DO $$
DECLARE receiver text := reconciliation.receiver_role();
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname=receiver) THEN
    RAISE EXCEPTION 'Webhook receiver group already exists';
  END IF;
  EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', receiver);
END $$;
CREATE TABLE reconciliation.refund_events (
  adapter_ref text NOT NULL CHECK (adapter_ref ~ '^[a-f0-9]{64}$'),
  event_ref text NOT NULL CHECK (event_ref ~ '^[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  key_id text NOT NULL CHECK (key_id ~ '^[a-f0-9]{64}$'),
  merchant_ref text NOT NULL CHECK (merchant_ref ~ '^[a-f0-9]{64}$'),
  refund_ref text NOT NULL CHECK (refund_ref ~ '^[a-f0-9]{64}$'),
  capture_ref text NOT NULL CHECK (capture_ref ~ '^[a-f0-9]{64}$'),
  usd_cents bigint NOT NULL CHECK (usd_cents BETWEEN 1 AND 1000000000),
  received_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (adapter_ref,event_ref)
);
CREATE TABLE reconciliation.refund_receipts (
  adapter_ref text NOT NULL CHECK (adapter_ref ~ '^[a-f0-9]{64}$'),
  key_id text NOT NULL CHECK (key_id ~ '^[a-f0-9]{64}$'),
  merchant_ref text NOT NULL CHECK (merchant_ref ~ '^[a-f0-9]{64}$'),
  refund_ref text NOT NULL CHECK (refund_ref ~ '^[a-f0-9]{64}$'),
  capture_ref text NOT NULL CHECK (capture_ref ~ '^[a-f0-9]{64}$'),
  usd_cents bigint NOT NULL CHECK (usd_cents BETWEEN 1 AND 1000000000),
  audit_id bigint NOT NULL UNIQUE REFERENCES audit.audit_events(id),
  audit_hash text NOT NULL CHECK (audit_hash ~ '^[a-f0-9]{64}$'),
  execution_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (adapter_ref,refund_ref)
);
CREATE FUNCTION reconciliation.valid_receipt(r reconciliation.refund_receipts, e audit.audit_events) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$ SELECT COALESCE(
  e.id=r.audit_id AND e.row_hash=r.audit_hash AND e.tool='create_refund' AND e.decision='allow'
  AND e.resolved_ctx->'velocity'->>'merchant_ref'=r.merchant_ref
  AND e.resolved_ctx->'velocity'->>'key_id'=r.key_id
  AND (e.resolved_ctx->'velocity'->>'usd_cents')::bigint=r.usd_cents
  AND ((e.event_kind='tool_call' AND e.approval_id IS NULL
    AND e.resolved_ctx->'velocity'->>'request_id'=r.execution_id::text)
    OR (e.event_kind='approval_executed' AND e.approval_id IS NOT NULL
      AND e.upstream_status BETWEEN 200 AND 299 AND e.upstream_result_ref=r.execution_id)), false) $$;
CREATE FUNCTION reconciliation.record_refund(payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, reconciliation
AS $$
DECLARE candidate reconciliation.refund_receipts; existing reconciliation.refund_receipts;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object'
    OR NOT payload ?& ARRAY['adapter_ref','key_id','merchant_ref','refund_ref','capture_ref','usd_cents','audit_id','audit_hash','execution_id']
    OR payload - ARRAY['adapter_ref','key_id','merchant_ref','refund_ref','capture_ref','usd_cents','audit_id','audit_hash','execution_id'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid refund receipt';
  END IF;
  candidate := jsonb_populate_record(NULL::reconciliation.refund_receipts, payload);
  IF NOT EXISTS (SELECT FROM audit.audit_events e WHERE reconciliation.valid_receipt(candidate,e)) THEN
    RAISE EXCEPTION 'Refund receipt has no matching audit evidence';
  END IF;
  INSERT INTO reconciliation.refund_receipts SELECT candidate.* ON CONFLICT DO NOTHING;
  SELECT * INTO existing FROM reconciliation.refund_receipts
    WHERE adapter_ref=candidate.adapter_ref AND refund_ref=candidate.refund_ref;
  IF existing IS DISTINCT FROM candidate THEN
    RAISE EXCEPTION 'Conflicting refund receipt';
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA reconciliation FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reconciliation FROM PUBLIC;
DO $$
DECLARE app_group text := audit.app_role(); receiver text := reconciliation.receiver_role();
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA reconciliation TO %I, %I', app_group, receiver);
  EXECUTE format('GRANT SELECT ON reconciliation.refund_events, reconciliation.refund_receipts TO %I', app_group);
  EXECUTE format('GRANT EXECUTE ON FUNCTION reconciliation.record_refund(jsonb), reconciliation.valid_receipt(reconciliation.refund_receipts,audit.audit_events) TO %I', app_group);
  EXECUTE format('GRANT SELECT ON reconciliation.refund_events TO %I', receiver);
  EXECUTE format('GRANT INSERT (adapter_ref,event_ref,payload_hash,key_id,merchant_ref,refund_ref,capture_ref,usd_cents) ON reconciliation.refund_events TO %I', receiver);
END $$;
COMMIT;
