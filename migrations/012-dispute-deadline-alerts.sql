-- Apply as the trusted owner after 004. Alert rows are never deleted.
BEGIN;
-- One push per (merchant, dispute, stage, device, generation). Stages are the
-- review-time classification; due_at is the classified seller deadline.
-- An undeliverable row expires 72 hours after it is recorded, independent of
-- due_at, so an overdue alert is still delivered.
CREATE TABLE approvals.dispute_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_ref text NOT NULL CHECK (merchant_ref ~ '^[a-f0-9]{64}$'),
  dispute_id text NOT NULL CHECK (dispute_id ~ '^[A-Za-z0-9-]{1,255}$'),
  stage text NOT NULL CHECK (stage IN ('due_soon','overdue')),
  due_at timestamptz(3) NOT NULL,
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  owner_ref text NOT NULL CHECK (owner_ref ~ '^[a-f0-9]{64}$'),
  device_ref text NOT NULL REFERENCES approvals.devices(device_ref),
  generation integer NOT NULL CHECK (generation > 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','sending','sent','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at timestamptz NOT NULL,
  claim_id uuid,
  leased_until timestamptz,
  UNIQUE(merchant_ref,dispute_id,stage,device_ref,generation),
  CHECK (expires_at = created_at + interval '72 hours'),
  CHECK ((state='sending' AND claim_id IS NOT NULL AND leased_until IS NOT NULL)
    OR (state<>'sending' AND claim_id IS NULL AND leased_until IS NULL))
);
CREATE INDEX dispute_alert_ready ON approvals.dispute_alerts(merchant_ref,state,next_attempt_at);
-- New rows start ready for a device of the recorded owner, with server-set
-- times, for every role. Identity columns are immutable, attempts never
-- decrease and sent or skipped rows are final.
CREATE FUNCTION approvals.guard_dispute_alert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,approvals AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'ready' OR NEW.attempts IS DISTINCT FROM 0
      OR NOT EXISTS (SELECT FROM approvals.devices d
        WHERE d.device_ref=NEW.device_ref AND d.owner_ref=NEW.owner_ref) THEN
      RAISE EXCEPTION 'Invalid dispute alert';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.expires_at := NEW.created_at + interval '72 hours';
    NEW.next_attempt_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.merchant_ref,NEW.dispute_id,NEW.stage,NEW.due_at,NEW.binding_hash,
      NEW.owner_ref,NEW.device_ref,NEW.generation,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM (OLD.id,OLD.merchant_ref,OLD.dispute_id,OLD.stage,OLD.due_at,OLD.binding_hash,
      OLD.owner_ref,OLD.device_ref,OLD.generation,OLD.created_at,OLD.expires_at)
    OR NEW.attempts<OLD.attempts
    OR (OLD.state IN ('sent','skipped') AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Invalid dispute alert transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_dispute_alert BEFORE INSERT OR UPDATE ON approvals.dispute_alerts
  FOR EACH ROW EXECUTE FUNCTION approvals.guard_dispute_alert();
REVOKE ALL ON approvals.dispute_alerts FROM PUBLIC;
REVOKE ALL ON FUNCTION approvals.guard_dispute_alert() FROM PUBLIC;
DO $$
BEGIN
  EXECUTE format('GRANT SELECT,INSERT ON approvals.dispute_alerts TO %I',audit.app_role());
  -- The drain writes only delivery state; identity columns stay ungranted.
  EXECUTE format('GRANT UPDATE (state,attempts,next_attempt_at,claim_id,leased_until) ON approvals.dispute_alerts TO %I',audit.app_role());
END $$;
COMMIT;
