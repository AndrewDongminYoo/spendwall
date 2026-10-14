-- Apply as the trusted owner after 001 and 002. No audit rows are rewritten.
BEGIN;
CREATE SCHEMA approvals;
REVOKE ALL ON SCHEMA approvals FROM PUBLIC;
CREATE TABLE approvals.requests (
  approval_id uuid PRIMARY KEY,
  reservation_id bigint NOT NULL UNIQUE REFERENCES audit.audit_events(id),
  owner_ref text NOT NULL CHECK (owner_ref ~ '^[a-f0-9]{64}$'),
  adapter_ref text NOT NULL CHECK (adapter_ref ~ '^[a-f0-9]{64}$'),
  binding_ref text NOT NULL CHECK (binding_ref ~ '^[a-f0-9]{64}$'),
  request_sealed text NOT NULL CHECK (length(request_sealed) BETWEEN 40 AND 262144),
  result_sealed text CHECK (length(result_sealed) BETWEEN 40 AND 262144),
  created_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  approval_state text NOT NULL DEFAULT 'pending' CHECK (approval_state IN ('pending','approved','denied','expired')),
  execution_state text CHECK (execution_state IN ('in_flight','succeeded','failed','unknown')),
  execution_id uuid UNIQUE,
  started_at timestamptz(3),
  CHECK (expires_at = created_at + interval '15 minutes'),
  CHECK ((approval_state = 'approved' AND execution_state IS NOT NULL AND execution_id IS NOT NULL AND started_at IS NOT NULL)
    OR (approval_state <> 'approved' AND execution_state IS NULL AND execution_id IS NULL AND started_at IS NULL AND result_sealed IS NULL))
);
CREATE FUNCTION approvals.guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, approvals
AS $$
BEGIN
  IF (NEW.approval_id,NEW.reservation_id,NEW.owner_ref,NEW.adapter_ref,NEW.binding_ref,NEW.request_sealed,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.approval_id,OLD.reservation_id,OLD.owner_ref,OLD.adapter_ref,OLD.binding_ref,OLD.request_sealed,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'Immutable approval binding';
  END IF;
  IF OLD.approval_state <> 'pending' AND NEW.approval_state <> OLD.approval_state THEN
    RAISE EXCEPTION 'Invalid approval transition';
  END IF;
  IF (OLD.approval_state = 'pending' AND NEW.approval_state = 'approved' AND NEW.execution_state <> 'in_flight')
    OR (OLD.execution_state = 'unknown' AND NEW.execution_state NOT IN ('unknown','in_flight')) THEN
    RAISE EXCEPTION 'Invalid execution transition';
  END IF;
  IF OLD.execution_id IS NOT NULL AND (NEW.execution_id,NEW.started_at) IS DISTINCT FROM (OLD.execution_id,OLD.started_at) THEN
    RAISE EXCEPTION 'Immutable execution identity';
  END IF;
  IF OLD.execution_state IN ('succeeded','failed') AND (NEW.execution_state,NEW.result_sealed) IS DISTINCT FROM (OLD.execution_state,OLD.result_sealed) THEN
    RAISE EXCEPTION 'Terminal execution';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION approvals.guard_update() FROM PUBLIC;
CREATE TRIGGER immutable_approval BEFORE UPDATE ON approvals.requests FOR EACH ROW EXECUTE FUNCTION approvals.guard_update();
DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA approvals TO %I', audit.app_role());
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON approvals.requests TO %I', audit.app_role());
END $$;
COMMIT;
