-- Apply as the trusted owner after 009. Existing ledger rows are not rewritten.
BEGIN;
-- Inserts start every row the way OrderService reserves it, for every role:
-- status unknown, no provider ids, one counted attempt and a server clock. The
-- audit receipt must be an allow event for the matching tool appended in this
-- transaction, so a stale or copied receipt cannot reserve a ledger slot.
CREATE FUNCTION orders.guard_order_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, orders
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'unknown' OR NEW.order_id IS NOT NULL
    OR NEW.approve_url IS NOT NULL OR NEW.attempts IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Order reservation must start unknown';
  END IF;
  IF NOT EXISTS (SELECT FROM audit.audit_events e
    WHERE e.id = NEW.audit_id AND e.row_hash = NEW.audit_hash
      AND e.decision = 'allow' AND e.tool = 'create_order'
      AND e.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Order reservation requires a fresh audit receipt';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE FUNCTION orders.guard_capture_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, orders
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'unknown' OR NEW.capture_id IS NOT NULL
    OR NEW.attempts IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Capture reservation must start unknown';
  END IF;
  IF NOT EXISTS (SELECT FROM audit.audit_events e
    WHERE e.id = NEW.audit_id AND e.row_hash = NEW.audit_hash
      AND e.decision = 'allow' AND e.tool = 'pay_order'
      AND e.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Capture reservation requires a fresh audit receipt';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION orders.guard_order_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION orders.guard_capture_insert() FROM PUBLIC;
CREATE TRIGGER reserve_order BEFORE INSERT ON orders.orders FOR EACH ROW EXECUTE FUNCTION orders.guard_order_insert();
CREATE TRIGGER reserve_capture BEFORE INSERT ON orders.captures FOR EACH ROW EXECUTE FUNCTION orders.guard_capture_insert();
COMMIT;
