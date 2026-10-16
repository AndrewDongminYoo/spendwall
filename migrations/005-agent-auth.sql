-- Apply once as the trusted owner. Independent of the audit/approval schemas.
BEGIN;
CREATE SCHEMA agent_auth;
REVOKE ALL ON SCHEMA agent_auth FROM PUBLIC;
CREATE FUNCTION agent_auth.reader_role() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT 'spendwall_agent_reader_' || left(encode(sha256(convert_to(current_database(),'UTF8')),'hex'),40)
$$;
CREATE TABLE agent_auth.credentials (
  id uuid PRIMARY KEY,
  merchant_id text NOT NULL CHECK (merchant_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  agent_id text NOT NULL CHECK (agent_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  tools text[] NOT NULL CHECK (cardinality(tools) <= 128 AND array_position(tools,NULL) IS NULL),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);
REVOKE ALL ON ALL TABLES IN SCHEMA agent_auth FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA agent_auth FROM PUBLIC;
DO $$
DECLARE role_name text := agent_auth.reader_role();
BEGIN
  -- A pre-existing role could carry unrelated privileges; fail instead of reusing it.
  EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
  EXECUTE format('GRANT USAGE ON SCHEMA agent_auth TO %I',role_name);
  EXECUTE format('GRANT SELECT ON agent_auth.credentials TO %I',role_name);
END $$;
COMMIT;
