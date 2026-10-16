-- Apply once as the trusted migration owner after migrations 001 through 003.
-- Set a unique password privately afterward; never reuse the owner credential.
BEGIN;
CREATE ROLE spendwall_dashboard_reader LOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA audit, approvals TO spendwall_dashboard_reader;
GRANT SELECT (id, row_hash, ts, agent_id, tool, args_hash, decision, event_kind,
  approval_id, upstream_status, upstream_result_ref, policy_version,
  matched_rules, resolved_ctx)
  ON audit.audit_events TO spendwall_dashboard_reader;
GRANT SELECT (approval_id, reservation_id, approval_state, execution_state,
  execution_id, expires_at) ON approvals.requests TO spendwall_dashboard_reader;
COMMIT;
