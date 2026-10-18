-- Apply as the trusted owner after 007 and 012. Rows are never deleted.
BEGIN;
CREATE SCHEMA disputes;
REVOKE ALL ON SCHEMA disputes FROM PUBLIC;
-- One row per verified dispute event. The receiver stores keyed references,
-- the event type and the two lookup identifiers; never a payload, buyer data,
-- amount, note or header.
CREATE TABLE disputes.events (
  adapter_ref text NOT NULL CHECK (adapter_ref ~ '^[a-f0-9]{64}$'),
  merchant_ref text NOT NULL CHECK (merchant_ref ~ '^[a-f0-9]{64}$'),
  event_ref text NOT NULL CHECK (event_ref ~ '^[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  event_type text NOT NULL CHECK (event_type IN
    ('CUSTOMER.DISPUTE.CREATED','CUSTOMER.DISPUTE.UPDATED','CUSTOMER.DISPUTE.RESOLVED')),
  dispute_id text NOT NULL CHECK (dispute_id ~ '^[A-Za-z0-9-]{1,255}$'),
  seller_transaction_id text NOT NULL CHECK (seller_transaction_id ~ '^[A-Za-z0-9-]{1,255}$'),
  received_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (adapter_ref,merchant_ref,event_ref)
);
-- One row per (merchant, dispute). Only the event trigger creates rows or
-- changes event_version; the tracker writes the schedule, the failure streak,
-- the outcome, the ending and its claim.
CREATE TABLE disputes.tracked (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_ref text NOT NULL CHECK (merchant_ref ~ '^[a-f0-9]{64}$'),
  dispute_id text NOT NULL CHECK (dispute_id ~ '^[A-Za-z0-9-]{1,255}$'),
  seller_transaction_id text NOT NULL CHECK (seller_transaction_id ~ '^[A-Za-z0-9-]{1,255}$'),
  first_event_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  event_version bigint NOT NULL CHECK (event_version > 0),
  next_check_at timestamptz NOT NULL,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  failing_since timestamptz,
  last_outcome text CHECK (last_outcome IN ('unmapped','dispute_unavailable','not_acceptable',
    'policy_denied','not_provided','scheduled','due_soon','overdue','resolved')),
  ended text CHECK (ended IN ('resolved','overdue','exhausted','expired')),
  claim_id uuid,
  leased_until timestamptz,
  UNIQUE (merchant_ref,dispute_id),
  CHECK ((failures = 0) = (failing_since IS NULL)),
  CHECK (CASE WHEN last_outcome IN ('unmapped','dispute_unavailable') THEN failures > 0 ELSE failures = 0 END),
  CHECK ((claim_id IS NULL) = (leased_until IS NULL))
);
CREATE INDEX tracked_due ON disputes.tracked(merchant_ref,next_check_at) WHERE ended IS NULL;
-- A verified event inserts or advances its tracked row at the database clock.
-- It never changes identity columns or a row that has ended. now() is the
-- transaction start, so a later commit can carry an earlier time; the last
-- event time keeps the greater value and settlement binds to event_version.
CREATE FUNCTION disputes.track_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,disputes AS $$
BEGIN
  INSERT INTO disputes.tracked AS t (merchant_ref,dispute_id,seller_transaction_id,
    first_event_at,last_event_at,event_version,next_check_at,ended)
  VALUES (NEW.merchant_ref,NEW.dispute_id,NEW.seller_transaction_id,now(),now(),1,now(),
    CASE WHEN NEW.event_type='CUSTOMER.DISPUTE.RESOLVED' THEN 'resolved' END)
  ON CONFLICT (merchant_ref,dispute_id) DO UPDATE
    SET event_version=t.event_version+1,last_event_at=GREATEST(t.last_event_at,now()),
      next_check_at=now(),ended=EXCLUDED.ended
    WHERE t.ended IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER track_event AFTER INSERT ON disputes.events
  FOR EACH ROW EXECUTE FUNCTION disputes.track_event();
-- For every role: identity columns are immutable, an ended row is final,
-- event_version and last_event_at change only through the event trigger and
-- never go back, and the failure streak resets only on a successful outcome.
CREATE FUNCTION disputes.guard_tracked() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,disputes AS $$
DECLARE
  from_event boolean := pg_trigger_depth() > 1;
  success boolean := COALESCE(NEW.last_outcome NOT IN ('unmapped','dispute_unavailable'), false);
BEGIN
  IF (NEW.id,NEW.merchant_ref,NEW.dispute_id,NEW.seller_transaction_id,NEW.first_event_at)
      IS DISTINCT FROM (OLD.id,OLD.merchant_ref,OLD.dispute_id,OLD.seller_transaction_id,OLD.first_event_at)
    OR OLD.ended IS NOT NULL
    OR NEW.event_version < OLD.event_version
    OR NEW.last_event_at < OLD.last_event_at
    OR (NOT from_event AND (NEW.event_version,NEW.last_event_at)
      IS DISTINCT FROM (OLD.event_version,OLD.last_event_at))
    OR (from_event AND (NEW.event_version <> OLD.event_version + 1
      OR (NEW.failures,NEW.failing_since,NEW.last_outcome,NEW.claim_id,NEW.leased_until)
        IS DISTINCT FROM (OLD.failures,OLD.failing_since,OLD.last_outcome,OLD.claim_id,OLD.leased_until)))
    OR (NEW.failures < OLD.failures AND NOT success)
    OR (OLD.failing_since IS NOT NULL AND NEW.failing_since IS DISTINCT FROM OLD.failing_since
      AND NOT (NEW.failing_since IS NULL AND success)) THEN
    RAISE EXCEPTION 'Invalid tracked dispute transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_tracked BEFORE UPDATE ON disputes.tracked
  FOR EACH ROW EXECUTE FUNCTION disputes.guard_tracked();
REVOKE ALL ON ALL TABLES IN SCHEMA disputes FROM PUBLIC;
REVOKE ALL ON FUNCTION disputes.track_event(), disputes.guard_tracked() FROM PUBLIC;
DO $$
DECLARE app_group text := audit.app_role(); receiver text := reconciliation.receiver_role();
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA disputes TO %I, %I', app_group, receiver);
  -- The tracker reads its rows and writes only schedule, outcome and claim state.
  EXECUTE format('GRANT SELECT ON disputes.tracked TO %I', app_group);
  EXECUTE format('GRANT UPDATE (next_check_at,failures,failing_since,last_outcome,ended,claim_id,leased_until) ON disputes.tracked TO %I', app_group);
  -- The receiver reads and inserts events only; the trigger writes tracked rows.
  EXECUTE format('GRANT SELECT ON disputes.events TO %I', receiver);
  EXECUTE format('GRANT INSERT (adapter_ref,merchant_ref,event_ref,payload_hash,event_type,dispute_id,seller_transaction_id) ON disputes.events TO %I', receiver);
END $$;
COMMIT;
