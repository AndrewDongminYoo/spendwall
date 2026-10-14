-- Run once as a trusted schema owner, separately from the application login.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spendwall_audit_app') THEN
    CREATE ROLE spendwall_audit_app NOLOGIN;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'spendwall_audit_app'
             AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin))
     OR EXISTS (SELECT FROM pg_auth_members WHERE member = 'spendwall_audit_app'::regrole) THEN
    RAISE EXCEPTION 'Audit app group must be an unprivileged NOLOGIN role';
  END IF;
END $$;

CREATE SCHEMA audit;
REVOKE ALL ON SCHEMA audit FROM PUBLIC;
CREATE SEQUENCE audit.event_ids AS bigint;
CREATE TABLE audit.audit_events (
  id bigint PRIMARY KEY CHECK (id > 0),
  ts timestamptz(3) NOT NULL,
  agent_id text NOT NULL CHECK (agent_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  tool text NOT NULL CHECK (tool ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  args_redacted jsonb NOT NULL CHECK (jsonb_typeof(args_redacted) = 'object'),
  args_hash text NOT NULL CHECK (args_hash ~ '^[a-f0-9]{64}$'),
  resolved_ctx jsonb NOT NULL CHECK (jsonb_typeof(resolved_ctx) = 'object'),
  decision text NOT NULL CHECK (decision IN ('allow', 'deny', 'require_approval')),
  matched_rules jsonb NOT NULL CHECK (jsonb_typeof(matched_rules) = 'array'),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-f0-9]{64}$'),
  approval_id uuid,
  upstream_status integer CHECK (upstream_status BETWEEN 100 AND 599),
  upstream_result_ref uuid,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[a-f0-9]{64}$'),
  row_hash text NOT NULL CHECK (row_hash ~ '^[a-f0-9]{64}$'),
  event_kind text NOT NULL CHECK (event_kind IN
    ('tool_call', 'approval_created', 'approval_decided', 'approval_executed')),
  CHECK (event_kind = 'tool_call' OR approval_id IS NOT NULL)
);
CREATE TABLE audit.chain_head (
  singleton boolean PRIMARY KEY CHECK (singleton),
  event_id bigint,
  row_hash text NOT NULL CHECK (row_hash ~ '^[a-f0-9]{64}$')
);
INSERT INTO audit.chain_head VALUES (true, NULL, repeat('0', 64));

-- Canonical UTF-8 JSONB representation, independent of the connection timezone.
CREATE FUNCTION audit.event_payload(e audit.audit_events) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object('v', 1, 'event',
    (to_jsonb(e) - 'row_hash' - 'ts') || jsonb_build_object('ts',
      to_char(e.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))::text
$$;

-- Repeat the allowlist in the DB boundary to prevent raw SQL callers from
-- storing credentials/PII in JSON fields. Unknown keys and text are discarded.
CREATE FUNCTION audit.redact(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, audit
AS $$
DECLARE result jsonb := '{}'; item record; currency text; amount jsonb;
BEGIN
  IF octet_length(value::text) > 65536 THEN
    RAISE EXCEPTION 'Invalid audit event';
  END IF;
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN result; END IF;
  FOR item IN SELECT * FROM jsonb_each(value) LOOP
    IF item.key = 'amount' AND jsonb_typeof(item.value) = 'object' THEN
      currency := COALESCE(item.value ->> 'currency_code', item.value ->> 'currency');
      IF currency IN ('USD', 'EUR', 'KRW')
        AND jsonb_typeof(item.value -> 'value') = 'string'
        AND item.value ->> 'value' ~ '^[0-9]{1,12}(\.[0-9]{1,2})?$'
        AND (currency <> 'KRW' OR item.value ->> 'value' !~ '\.')
        AND (NOT item.value ? 'currency' OR item.value ->> 'currency' = currency)
        AND (NOT item.value ? 'currency_code' OR item.value ->> 'currency_code' = currency) THEN
        amount := jsonb_build_object('value', item.value -> 'value');
        IF item.value ? 'currency' THEN amount := amount || jsonb_build_object('currency', currency); END IF;
        IF item.value ? 'currency_code' THEN amount := amount || jsonb_build_object('currency_code', currency); END IF;
        result := result || jsonb_build_object(item.key, amount);
      END IF;
    ELSIF item.key IN ('amount_minor', 'refunded_minor', 'remaining_minor', 'age_hours', 'quantity')
      AND jsonb_typeof(item.value) = 'number' AND item.value::text ~ '^[0-9]+$'
      AND item.value::numeric <= 9007199254740991 THEN
      result := result || jsonb_build_object(item.key, item.value);
    ELSIF item.key IN ('currency', 'currency_code') AND jsonb_typeof(item.value) = 'string'
      AND item.value #>> '{}' IN ('USD', 'EUR', 'KRW') THEN
      result := result || jsonb_build_object(item.key, item.value);
    ELSIF item.key = 'status' AND jsonb_typeof(item.value) = 'string'
      AND item.value #>> '{}' IN ('COMPLETED', 'PENDING', 'FAILED', 'CANCELLED', 'DENIED', 'REFUNDED', 'PARTIALLY_REFUNDED') THEN
      result := result || jsonb_build_object(item.key, item.value);
    END IF;
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION audit.append_event(payload jsonb)
RETURNS TABLE(id text, row_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, audit
AS $$
DECLARE head audit.chain_head; tail audit.audit_events; next_event audit.audit_events;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR octet_length(payload::text) > 131072 THEN
    RAISE EXCEPTION 'Invalid audit event';
  END IF;
  -- Lock before allocating an ID: sequence allocation before lock acquisition
  -- would let commit/chain order disagree with ID order.
  SELECT * INTO STRICT head FROM audit.chain_head WHERE singleton FOR UPDATE;
  SELECT * INTO tail FROM audit.audit_events ORDER BY audit_events.id DESC LIMIT 1;
  IF (head.event_id IS NULL AND (tail.id IS NOT NULL OR head.row_hash <> repeat('0',64)))
     OR (head.event_id IS NOT NULL AND (tail.id IS DISTINCT FROM head.event_id
       OR tail.row_hash IS DISTINCT FROM head.row_hash
       OR encode(sha256(convert_to(audit.event_payload(tail), 'UTF8')), 'hex') IS DISTINCT FROM head.row_hash)) THEN
    RAISE EXCEPTION 'Audit chain head mismatch';
  END IF;
  next_event := jsonb_populate_record(NULL::audit.audit_events, payload);
  IF jsonb_typeof(next_event.matched_rules) IS DISTINCT FROM 'array'
     OR jsonb_array_length(next_event.matched_rules) > 128 THEN
    RAISE EXCEPTION 'Invalid audit event';
  END IF;
  IF next_event.agent_id ~* '^(Bearer|Basic|gh[pousr]_|sk[-_])'
     OR next_event.tool ~* '^(Bearer|Basic|gh[pousr]_|sk[-_])'
     OR EXISTS (SELECT FROM jsonb_array_elements(next_event.matched_rules) AS r(value)
       WHERE jsonb_typeof(value) <> 'string'
       OR value #>> '{}' !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
       OR value #>> '{}' ~* '^(Bearer|Basic|gh[pousr]_|sk[-_])') THEN
    RAISE EXCEPTION 'Invalid audit event';
  END IF;
  next_event.id := nextval('audit.event_ids');
  next_event.ts := clock_timestamp();
  next_event.args_redacted := audit.redact(next_event.args_redacted);
  next_event.resolved_ctx := audit.redact(next_event.resolved_ctx);
  next_event.prev_hash := head.row_hash;
  next_event.row_hash := encode(sha256(convert_to(audit.event_payload(next_event), 'UTF8')), 'hex');
  INSERT INTO audit.audit_events SELECT next_event.*;
  UPDATE audit.chain_head SET event_id = next_event.id, row_hash = next_event.row_hash WHERE singleton;
  RETURN QUERY SELECT next_event.id::text, next_event.row_hash;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM PUBLIC, spendwall_audit_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA audit FROM PUBLIC, spendwall_audit_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA audit FROM PUBLIC, spendwall_audit_app;
GRANT USAGE ON SCHEMA audit TO spendwall_audit_app;
GRANT SELECT ON audit.audit_events, audit.chain_head TO spendwall_audit_app;
GRANT EXECUTE ON FUNCTION audit.append_event(jsonb), audit.event_payload(audit.audit_events) TO spendwall_audit_app;
COMMIT;
