-- Apply as the trusted owner after 002. Order and capture rows are never deleted.
BEGIN;
-- Orders v2 facts join the audit redaction allowlist as a wrapper over the
-- current audit.redact; existing rows and earlier hash payloads are not rewritten.
ALTER FUNCTION audit.redact(jsonb, integer) RENAME TO redact_velocity_v2;
CREATE FUNCTION audit.redact(value jsonb, depth integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, audit
AS $$
DECLARE result jsonb; link text;
BEGIN
  result := audit.redact_velocity_v2(value, depth);
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN result; END IF;
  IF jsonb_typeof(value -> 'status') = 'string'
    AND value ->> 'status' IN ('CREATED', 'APPROVED') THEN
    result := result || jsonb_build_object('status', value -> 'status');
  END IF;
  IF jsonb_typeof(value -> 'order_id') = 'string'
    AND value ->> 'order_id' ~ '^[A-Z0-9]{17,32}$' THEN
    result := result || jsonb_build_object('order_id', value -> 'order_id');
  END IF;
  link := value ->> 'approve_url';
  IF jsonb_typeof(value -> 'approve_url') = 'string'
    AND link ~ '^https://www\.sandbox\.paypal\.com/\S+$' AND length(link) <= 512 THEN
    result := result || jsonb_build_object('approve_url', value -> 'approve_url');
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION audit.redact(jsonb, integer) FROM PUBLIC;
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION audit.redact(jsonb, integer) FROM %I', audit.app_role());
END $$;
CREATE SCHEMA orders;
REVOKE ALL ON SCHEMA orders FROM PUBLIC;
CREATE TABLE orders.orders (
  merchant_ref text NOT NULL CHECK (merchant_ref ~ '^[a-f0-9]{64}$'),
  request_id uuid NOT NULL,
  key_id text NOT NULL CHECK (key_id ~ '^[a-f0-9]{64}$'),
  agent_id text NOT NULL CHECK (agent_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  args_hash text NOT NULL CHECK (args_hash ~ '^[a-f0-9]{64}$'),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-f0-9]{64}$'),
  amount_value text NOT NULL CHECK (amount_value ~ '^(0|[1-9][0-9]{0,11})\.[0-9]{2}$'),
  amount_currency text NOT NULL CHECK (amount_currency = 'USD'),
  status text NOT NULL CHECK (status IN ('unknown','created','failed')),
  -- Provider attempts sent under this PayPal-Request-Id; a rejection with more
  -- than one attempt may be a duplicate response and never settles 'failed'.
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  order_id text CHECK (order_id ~ '^[A-Z0-9]{17,32}$'),
  approve_url text CHECK (approve_url ~ '^https://www\.sandbox\.paypal\.com/\S+$' AND length(approve_url) <= 512),
  audit_id bigint NOT NULL UNIQUE REFERENCES audit.audit_events(id),
  audit_hash text NOT NULL CHECK (audit_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (merchant_ref,request_id),
  CHECK ((status='created') = (order_id IS NOT NULL AND approve_url IS NOT NULL)),
  CHECK (status='created' OR (order_id IS NULL AND approve_url IS NULL))
);
CREATE UNIQUE INDEX orders_order_once ON orders.orders (merchant_ref,order_id)
  WHERE order_id IS NOT NULL;
CREATE TABLE orders.captures (
  merchant_ref text NOT NULL CHECK (merchant_ref ~ '^[a-f0-9]{64}$'),
  execution_id uuid NOT NULL,
  order_request uuid NOT NULL,
  key_id text NOT NULL CHECK (key_id ~ '^[a-f0-9]{64}$'),
  agent_id text NOT NULL CHECK (agent_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('unknown','completed','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  capture_id text CHECK (capture_id ~ '^[A-Za-z0-9_-]{15,32}$'),
  audit_id bigint NOT NULL UNIQUE REFERENCES audit.audit_events(id),
  audit_hash text NOT NULL CHECK (audit_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (merchant_ref,execution_id),
  FOREIGN KEY (merchant_ref,order_request) REFERENCES orders.orders(merchant_ref,request_id),
  CHECK ((status='completed') = (capture_id IS NOT NULL))
);
-- One live capture attempt per order; only a definitive failure frees the slot.
CREATE UNIQUE INDEX orders_capture_once ON orders.captures (merchant_ref,order_request)
  WHERE status<>'failed';
REVOKE ALL ON ALL TABLES IN SCHEMA orders FROM PUBLIC;
DO $$
DECLARE app_group text := audit.app_role();
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA orders TO %I',app_group);
  EXECUTE format('GRANT SELECT, INSERT ON orders.orders, orders.captures TO %I',app_group);
  -- The audit receipt moves from the reservation event to the event that records the outcome.
  EXECUTE format('GRANT UPDATE (status,attempts,order_id,approve_url,audit_id,audit_hash) ON orders.orders TO %I',app_group);
  EXECUTE format('GRANT UPDATE (status,attempts,capture_id,audit_id,audit_hash) ON orders.captures TO %I',app_group);
END $$;
COMMIT;
