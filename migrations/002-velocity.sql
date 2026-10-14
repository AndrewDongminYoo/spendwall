-- Owner-only extension. Existing rows and v1 hash payload are not rewritten.
BEGIN;

ALTER FUNCTION audit.redact(jsonb, integer) RENAME TO redact_payment_v1;
CREATE FUNCTION audit.redact(value jsonb, depth integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, audit
AS $$
DECLARE result jsonb; metadata jsonb; field text;
BEGIN
  result := audit.redact_payment_v1(value, depth);
  IF depth = 0 AND jsonb_typeof(value) = 'object' AND value ? 'velocity' THEN
    metadata := value -> 'velocity';
    IF jsonb_typeof(metadata) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid velocity metadata';
    END IF;
    IF NOT metadata ?& ARRAY['v', 'key_id', 'merchant_ref', 'customer_ref', 'request_id', 'binding_hash', 'usd_cents']
      OR metadata - ARRAY['v', 'key_id', 'merchant_ref', 'customer_ref', 'request_id', 'binding_hash', 'usd_cents'] <> '{}'::jsonb
      OR metadata -> 'v' IS DISTINCT FROM '1'::jsonb THEN
      RAISE EXCEPTION 'Invalid velocity metadata';
    END IF;
    FOREACH field IN ARRAY ARRAY['key_id', 'merchant_ref', 'customer_ref', 'binding_hash'] LOOP
      IF jsonb_typeof(metadata -> field) IS DISTINCT FROM 'string'
        OR metadata ->> field !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'Invalid velocity metadata';
      END IF;
    END LOOP;
    IF jsonb_typeof(metadata -> 'request_id') IS DISTINCT FROM 'string'
      OR metadata ->> 'request_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      OR jsonb_typeof(metadata -> 'usd_cents') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Invalid velocity metadata';
    END IF;
    IF metadata ->> 'usd_cents' !~ '^[0-9]+$' OR (metadata ->> 'usd_cents')::numeric > 1000000000 THEN
      RAISE EXCEPTION 'Invalid velocity metadata';
    END IF;
    result := result || jsonb_build_object('velocity', metadata);
  END IF;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION audit.redact(jsonb, integer) FROM PUBLIC;
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION audit.redact(jsonb, integer) FROM %I', audit.app_role());
END $$;
COMMIT;
