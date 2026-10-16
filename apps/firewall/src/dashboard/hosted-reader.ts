import type { Pool } from 'pg';

// Recheck on health probes so later privilege changes make readiness fail.
export async function checkHostedReader(pool: Pick<Pool, 'connect'>) {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query<{ restricted: boolean }>(`
      SELECT NOT (
        EXISTS (SELECT FROM pg_roles WHERE rolname=current_user
          AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
        OR EXISTS (SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user))
        OR EXISTS (SELECT FROM pg_database WHERE datname=current_database()
          AND pg_has_role(current_user,datdba,'USAGE'))
        OR EXISTS (SELECT FROM pg_namespace WHERE nspname IN
          ('audit','approvals','approver','agent_auth','policy_replay','reconciliation','invoice_policy')
          AND (pg_has_role(current_user,nspowner,'USAGE') OR has_schema_privilege(oid,'CREATE')))
        OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('audit','approvals','approver','agent_auth','policy_replay','reconciliation','invoice_policy')
          AND ((c.relkind IN ('r','p','v','m','f') AND
            (has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
             OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES')
             OR EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid=c.oid
               AND a.attnum>0 AND NOT a.attisdropped
               AND has_column_privilege(c.oid,a.attnum,'SELECT')
               AND NOT (
                 (n.nspname='audit' AND c.relname='audit_events' AND a.attname IN
                   ('id','row_hash','ts','agent_id','tool','args_hash','decision','event_kind',
                    'approval_id','upstream_status','upstream_result_ref','policy_version',
                    'matched_rules','resolved_ctx'))
                 OR (n.nspname='approvals' AND c.relname='requests' AND a.attname IN
                   ('approval_id','reservation_id','approval_state','execution_state','execution_id','expires_at'))
               ))))
            OR (c.relkind='S' AND has_sequence_privilege(c.oid,'SELECT,USAGE,UPDATE'))))
        OR EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname IN ('audit','approvals','approver','agent_auth','policy_replay','reconciliation','invoice_policy')
          AND p.prosecdef AND has_function_privilege(p.oid,'EXECUTE'))
      ) AS restricted`);
    if (result.rows[0]?.restricted !== true) throw new Error();
    await client.query(
      `SELECT id, row_hash, ts, agent_id, tool, args_hash, decision, event_kind,
        approval_id, upstream_status, upstream_result_ref, policy_version,
        matched_rules, resolved_ctx FROM audit.audit_events LIMIT 0`,
    );
    await client.query(
      `SELECT approval_id, reservation_id, approval_state, execution_state,
        execution_id, expires_at FROM approvals.requests LIMIT 0`,
    );
  } catch {
    throw new Error('Hosted dashboard reader unavailable.');
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    client.release(discard);
  }
}
