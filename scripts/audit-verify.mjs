import pg from 'pg';
import { verifyAudit } from '../apps/firewall/src/audit/index.ts';

let pool;
try {
  const url = process.env.AUDIT_DATABASE_URL;
  if (!url) throw new Error();
  pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  const result = await verifyAudit(pool);
  if (result.ok)
    console.log(
      `Verified ${result.count} audit events; head ${result.headHash}.`,
    );
  else {
    console.error(
      `Audit integrity failure at row ${result.id ?? 'unknown'} (position ${result.position}): ${result.reason}.`,
    );
    process.exitCode = 1;
  }
} catch {
  console.error(
    'Audit verification failed. Check AUDIT_DATABASE_URL, read permissions, and the owner-applied audit migration.',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
