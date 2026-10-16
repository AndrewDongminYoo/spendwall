-- Apply as the trusted owner after 001. Reservations are immutable.
BEGIN;
CREATE SCHEMA invoice_policy;
REVOKE ALL ON SCHEMA invoice_policy FROM PUBLIC;
CREATE TABLE invoice_policy.decisions (
  merchant_ref text NOT NULL CHECK (merchant_ref ~ '^[a-f0-9]{64}$'),
  request_id uuid NOT NULL,
  key_id text NOT NULL CHECK (key_id ~ '^[a-f0-9]{64}$'),
  customer_ref text NOT NULL CHECK (customer_ref ~ '^[a-f0-9]{64}$'),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  invoice_ref text CHECK (invoice_ref ~ '^[a-f0-9]{64}$'),
  agent_id text NOT NULL,
  tool text NOT NULL CHECK (tool IN ('create_invoice','send_invoice')),
  args_hash text NOT NULL CHECK (args_hash ~ '^[a-f0-9]{64}$'),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('allow','deny')),
  day date NOT NULL,
  audit_id bigint NOT NULL UNIQUE REFERENCES audit.audit_events(id),
  audit_hash text NOT NULL CHECK (audit_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (merchant_ref,request_id),
  CHECK ((tool='send_invoice') = (invoice_ref IS NOT NULL))
);
CREATE UNIQUE INDEX invoice_send_once ON invoice_policy.decisions (merchant_ref,invoice_ref)
  WHERE tool='send_invoice' AND decision='allow';
CREATE FUNCTION invoice_policy.record_decision(payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, invoice_policy
AS $$
DECLARE candidate invoice_policy.decisions;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object'
    OR NOT payload ?& ARRAY['merchant_ref','request_id','key_id','customer_ref','binding_hash','invoice_ref','agent_id','tool','args_hash','policy_version','decision','day','audit_id','audit_hash']
    OR payload - ARRAY['merchant_ref','request_id','key_id','customer_ref','binding_hash','invoice_ref','agent_id','tool','args_hash','policy_version','decision','day','audit_id','audit_hash'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid invoice decision';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('spendwall/invoice-policy/v1',0));
  candidate := jsonb_populate_record(NULL::invoice_policy.decisions,payload);
  IF candidate.day IS DISTINCT FROM (clock_timestamp() AT TIME ZONE 'UTC')::date
    OR EXISTS (SELECT FROM invoice_policy.decisions
      WHERE key_id<>candidate.key_id OR day>(clock_timestamp() AT TIME ZONE 'UTC')::date) THEN
    RAISE EXCEPTION 'Invoice reservation scope unavailable';
  END IF;
  IF NOT EXISTS (SELECT FROM audit.audit_events e WHERE e.id=candidate.audit_id AND e.row_hash=candidate.audit_hash
    AND e.agent_id=candidate.agent_id AND e.tool=candidate.tool AND e.args_hash=candidate.args_hash
    AND e.policy_version=candidate.policy_version AND e.decision=candidate.decision
    AND e.event_kind='tool_call' AND e.approval_id IS NULL AND e.upstream_status IS NULL AND e.upstream_result_ref IS NULL) THEN
    RAISE EXCEPTION 'Invoice decision has no matching audit evidence';
  END IF;
  INSERT INTO invoice_policy.decisions SELECT candidate.*;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA invoice_policy FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA invoice_policy FROM PUBLIC;
DO $$
DECLARE app_group text := audit.app_role();
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA invoice_policy TO %I',app_group);
  EXECUTE format('GRANT SELECT ON invoice_policy.decisions TO %I',app_group);
  EXECUTE format('GRANT EXECUTE ON FUNCTION invoice_policy.record_decision(jsonb) TO %I',app_group);
END $$;
COMMIT;
