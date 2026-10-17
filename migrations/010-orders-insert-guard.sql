-- Apply as the trusted owner after 009. Existing ledger rows are not rewritten.
-- Reservation inserts and unknown-to-terminal settles each need a fresh receipt.
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
-- Settling an unknown row moves its receipt to the outcome event, for every
-- role. That event must be an allow event for the matching tool appended in this
-- transaction, name the row's request or execution UUID, carry a provider status
-- of the settled class (2xx for created or completed, a 4xx other than 408 or 429
-- for failed) and match the row's agent and policy. A created order must match
-- the event's order id and approve link, and a capture the parent order's id.
-- The redaction keeps no capture id, so capture_id is not bound to the event.
-- Unknown-to-unknown updates never reach these checks.
CREATE FUNCTION orders.guard_order_settle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, orders
AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM audit.audit_events e
    WHERE e.id = NEW.audit_id AND e.row_hash = NEW.audit_hash
      AND e.decision = 'allow' AND e.tool = 'create_order'
      AND e.xmin = pg_current_xact_id()::xid
      AND e.upstream_result_ref = OLD.request_id
      AND e.agent_id = OLD.agent_id AND e.policy_version = OLD.policy_version
      AND CASE NEW.status
        WHEN 'created' THEN e.upstream_status BETWEEN 200 AND 299
          AND e.resolved_ctx -> 'order' ->> 'order_id' = NEW.order_id
          AND e.resolved_ctx -> 'order' ->> 'approve_url' = NEW.approve_url
        WHEN 'failed' THEN e.upstream_status BETWEEN 400 AND 499
          AND e.upstream_status NOT IN (408, 429)
        ELSE false END) THEN
    RAISE EXCEPTION 'Order outcome requires a fresh matching audit receipt';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION orders.guard_capture_settle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, orders
AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM audit.audit_events e
    WHERE e.id = NEW.audit_id AND e.row_hash = NEW.audit_hash
      AND e.decision = 'allow' AND e.tool = 'pay_order'
      AND e.xmin = pg_current_xact_id()::xid
      AND e.upstream_result_ref = OLD.execution_id
      AND e.agent_id = OLD.agent_id AND e.policy_version = OLD.policy_version
      AND e.resolved_ctx -> 'order' ->> 'order_id' = (SELECT o.order_id FROM orders.orders o
        WHERE o.merchant_ref = OLD.merchant_ref AND o.request_id = OLD.order_request)
      AND CASE NEW.status
        WHEN 'completed' THEN e.upstream_status BETWEEN 200 AND 299
        WHEN 'failed' THEN e.upstream_status BETWEEN 400 AND 499
          AND e.upstream_status NOT IN (408, 429)
        ELSE false END) THEN
    RAISE EXCEPTION 'Capture outcome requires a fresh matching audit receipt';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION orders.guard_order_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION orders.guard_capture_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION orders.guard_order_settle() FROM PUBLIC;
REVOKE ALL ON FUNCTION orders.guard_capture_settle() FROM PUBLIC;
CREATE TRIGGER reserve_order BEFORE INSERT ON orders.orders FOR EACH ROW EXECUTE FUNCTION orders.guard_order_insert();
CREATE TRIGGER reserve_capture BEFORE INSERT ON orders.captures FOR EACH ROW EXECUTE FUNCTION orders.guard_capture_insert();
-- Same-event triggers fire in name order, so settle_* runs after 009's forward_only_*.
CREATE TRIGGER settle_order BEFORE UPDATE ON orders.orders FOR EACH ROW
  WHEN (OLD.status = 'unknown' AND NEW.status <> 'unknown') EXECUTE FUNCTION orders.guard_order_settle();
CREATE TRIGGER settle_capture BEFORE UPDATE ON orders.captures FOR EACH ROW
  WHEN (OLD.status = 'unknown' AND NEW.status <> 'unknown') EXECUTE FUNCTION orders.guard_capture_settle();
COMMIT;
