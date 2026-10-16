-- Optional encrypted replay storage. Apply after 001 and 002 as trusted owner.
BEGIN;
CREATE SCHEMA policy_replay;
REVOKE ALL ON SCHEMA policy_replay FROM PUBLIC;
CREATE TABLE policy_replay.snapshots (
  event_id bigint PRIMARY KEY REFERENCES audit.audit_events(id),
  merchant_ref text NOT NULL CHECK (merchant_ref ~ '^[a-f0-9]{64}$'),
  payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 29 AND 262144),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 days')
);
CREATE INDEX snapshots_expiry ON policy_replay.snapshots(expires_at,event_id);
CREATE FUNCTION policy_replay.reader_role() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT 'spendwall_replay_reader_' || left(encode(sha256(convert_to(current_database(),'UTF8')),'hex'),40)
$$;
CREATE FUNCTION policy_replay.purge_expired() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,policy_replay AS $$
  WITH expired AS (
    SELECT event_id FROM policy_replay.snapshots
    WHERE expires_at <= statement_timestamp()
    ORDER BY expires_at,event_id LIMIT 1000 FOR UPDATE SKIP LOCKED
  )
  DELETE FROM policy_replay.snapshots s USING expired e WHERE s.event_id=e.event_id
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA policy_replay FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA policy_replay FROM PUBLIC;
DO $$
DECLARE reader text := policy_replay.reader_role(); writer text := audit.app_role();
BEGIN
  EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',reader);
  EXECUTE format('GRANT USAGE ON SCHEMA policy_replay TO %I, %I',reader,writer);
  EXECUTE format('GRANT SELECT ON policy_replay.snapshots TO %I',reader);
  EXECUTE format('GRANT INSERT(event_id,merchant_ref,payload) ON policy_replay.snapshots TO %I',writer);
  EXECUTE format('GRANT USAGE ON SCHEMA audit TO %I',reader);
  EXECUTE format('GRANT SELECT ON audit.audit_events TO %I',reader);
  EXECUTE format('GRANT EXECUTE ON FUNCTION policy_replay.purge_expired() TO %I, %I',reader,writer);
END $$;
COMMIT;
