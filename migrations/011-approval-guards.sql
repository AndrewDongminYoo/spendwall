-- Apply as the trusted owner after 003. Existing approval rows are not rewritten.
-- Inserts and state changes each need a matching lifecycle event in their transaction.
BEGIN;
-- ApprovalService appends each lifecycle event after its row write, so these
-- checks run as deferred constraint triggers at commit, for every role. They use
-- the queued OLD and NEW tuples and never re-read the row, because one
-- transaction can create a row and then expire it.
--
-- A new row starts pending with no execution data. Its reservation must be the
-- velocity tool_call event for the same approval, which an interrupted creation
-- may have committed earlier. The approval_created event must be appended in
-- the inserting transaction.
CREATE FUNCTION approvals.guard_insert_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, approvals
AS $$
BEGIN
  IF NEW.approval_state IS DISTINCT FROM 'pending' OR NEW.execution_state IS NOT NULL
    OR NEW.execution_id IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.result_sealed IS NOT NULL THEN
    RAISE EXCEPTION 'Approval must start pending';
  END IF;
  IF NOT EXISTS (SELECT FROM audit.audit_events e
    WHERE e.id = NEW.reservation_id AND e.approval_id = NEW.approval_id
      AND e.event_kind = 'tool_call' AND e.decision = 'require_approval'
      AND e.tool = 'create_refund') THEN
    RAISE EXCEPTION 'Approval requires its velocity reservation';
  END IF;
  IF NOT EXISTS (SELECT FROM audit.audit_events e
    WHERE e.approval_id = NEW.approval_id AND e.event_kind = 'approval_created'
      AND e.decision = 'require_approval' AND e.tool = 'create_refund'
      AND e.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Approval creation requires a fresh audit event';
  END IF;
  RETURN NULL;
END $$;
-- A decision (pending to approved, denied or expired) needs approval_decided,
-- allow only for approved. An outcome from in_flight needs approval_executed;
-- succeeded needs allow with provider status 200 and the row's execution UUID,
-- failed and unknown need deny. The recovery re-claim unknown to in_flight writes
-- no event and is admitted, because the outcome that follows is bound. Any other
-- state change fails closed. 003's guard_update still orders the transitions.
CREATE FUNCTION approvals.guard_transition_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, approvals
AS $$
DECLARE
  kind text;
  verdict text;
BEGIN
  IF OLD.approval_state = 'pending' AND NEW.approval_state IN ('approved','denied','expired') THEN
    kind := 'approval_decided';
    verdict := CASE WHEN NEW.approval_state = 'approved' THEN 'allow' ELSE 'deny' END;
  ELSIF OLD.approval_state = 'approved' AND NEW.approval_state = 'approved'
    AND OLD.execution_state = 'in_flight' AND NEW.execution_state IN ('succeeded','failed','unknown') THEN
    kind := 'approval_executed';
    verdict := CASE WHEN NEW.execution_state = 'succeeded' THEN 'allow' ELSE 'deny' END;
  ELSIF OLD.approval_state = 'approved' AND NEW.approval_state = 'approved'
    AND OLD.execution_state = 'unknown' AND NEW.execution_state = 'in_flight' THEN
    RETURN NULL;
  ELSE
    RAISE EXCEPTION 'Approval transition has no audit receipt';
  END IF;
  IF NOT EXISTS (SELECT FROM audit.audit_events e
    WHERE e.approval_id = NEW.approval_id AND e.event_kind = kind
      AND e.decision = verdict AND e.tool = 'create_refund'
      AND e.xmin = pg_current_xact_id()::xid
      AND (NEW.execution_state IS DISTINCT FROM 'succeeded' OR kind <> 'approval_executed'
        OR (e.upstream_status = 200 AND e.upstream_result_ref = NEW.execution_id))) THEN
    RAISE EXCEPTION 'Approval transition requires a fresh matching audit event';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION approvals.guard_insert_receipt() FROM PUBLIC;
REVOKE ALL ON FUNCTION approvals.guard_transition_receipt() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER approval_insert_receipt AFTER INSERT ON approvals.requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION approvals.guard_insert_receipt();
CREATE CONSTRAINT TRIGGER approval_transition_receipt AFTER UPDATE ON approvals.requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.approval_state IS DISTINCT FROM NEW.approval_state
    OR OLD.execution_state IS DISTINCT FROM NEW.execution_state)
  EXECUTE FUNCTION approvals.guard_transition_receipt();
COMMIT;
