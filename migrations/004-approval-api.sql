-- Apply as the trusted owner after 001, 002 and 003.
BEGIN;
CREATE TABLE approvals.devices (
  device_ref text PRIMARY KEY CHECK (device_ref ~ '^[a-f0-9]{64}$'),
  owner_ref text NOT NULL CHECK (owner_ref ~ '^[a-f0-9]{64}$'),
  generation integer NOT NULL CHECK (generation > 0),
  token_sealed text NOT NULL CHECK (length(token_sealed) BETWEEN 40 AND 16384),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE approvals.used_enrollments (
  enrollment_hash text PRIMARY KEY CHECK (enrollment_hash ~ '^[a-f0-9]{64}$'),
  device_ref text NOT NULL REFERENCES approvals.devices(device_ref),
  used_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE approvals.deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL REFERENCES approvals.requests(approval_id),
  device_ref text NOT NULL REFERENCES approvals.devices(device_ref),
  generation integer NOT NULL CHECK (generation > 0),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','sending','sent','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_id uuid,
  leased_until timestamptz,
  UNIQUE(approval_id,device_ref,generation),
  CHECK ((state='sending' AND claim_id IS NOT NULL AND leased_until IS NOT NULL)
    OR (state<>'sending' AND claim_id IS NULL AND leased_until IS NULL))
);
CREATE INDEX delivery_ready ON approvals.deliveries(state,next_attempt_at);
CREATE INDEX approval_owner_pending ON approvals.requests(owner_ref,approval_state,approval_id);
CREATE FUNCTION approvals.guard_device_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,approvals AS $$
BEGIN
  IF (NEW.device_ref,NEW.owner_ref) IS DISTINCT FROM (OLD.device_ref,OLD.owner_ref)
    OR NEW.generation NOT IN (OLD.generation,OLD.generation+1)
    OR (NEW.generation=OLD.generation AND NEW.token_sealed<>OLD.token_sealed) THEN
    RAISE EXCEPTION 'Invalid device transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_device BEFORE UPDATE ON approvals.devices FOR EACH ROW EXECUTE FUNCTION approvals.guard_device_update();
CREATE FUNCTION approvals.guard_delivery_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,approvals AS $$
BEGIN
  IF (NEW.id,NEW.approval_id,NEW.device_ref,NEW.generation,NEW.expires_at)
      IS DISTINCT FROM (OLD.id,OLD.approval_id,OLD.device_ref,OLD.generation,OLD.expires_at)
    OR NEW.attempts<OLD.attempts
    OR (OLD.state IN ('sent','skipped') AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Invalid delivery transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_delivery BEFORE UPDATE ON approvals.deliveries FOR EACH ROW EXECUTE FUNCTION approvals.guard_delivery_update();
REVOKE ALL ON approvals.devices,approvals.used_enrollments,approvals.deliveries FROM PUBLIC;
REVOKE ALL ON FUNCTION approvals.guard_device_update(),approvals.guard_delivery_update() FROM PUBLIC;
DO $$
BEGIN
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON approvals.devices,approvals.deliveries TO %I',audit.app_role());
  EXECUTE format('GRANT SELECT,INSERT ON approvals.used_enrollments TO %I',audit.app_role());
END $$;
COMMIT;
