import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { databaseTls, databaseUrl } from './hosted-database.mjs';

// One-time preparation of an empty hosted demo database, run by its owner.
// It applies the migrations the dashboard and the synthetic writer need, then
// creates the restricted reader and the writer logins with private passwords.
const migrations = [
  '001-audit.sql',
  '002-velocity.sql',
  '003-approvals.sql',
  '011-approval-guards.sql',
];
const writerRole = 'spendwall_demo_writer';

function password(name) {
  const value = process.env[name] ?? '';
  if (value.length < 24 || !/^[\x21-\x7e]+$/.test(value))
    throw new Error('Invalid password.');
  return value;
}

let pool;
try {
  if (process.argv.length !== 2) throw new Error();
  const database = databaseUrl(process.env.SPENDWALL_SETUP_DATABASE_URL);
  const readerPassword = password('SPENDWALL_READER_PASSWORD');
  const writerPassword = password('SPENDWALL_WRITER_PASSWORD');
  if (readerPassword === writerPassword) throw new Error();
  pool = new pg.Pool({
    connectionString: database.toString(),
    ssl: databaseTls(
      process.env.SPENDWALL_SETUP_DATABASE_TLS,
      database.hostname,
    ),
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  const existing = await pool.query(
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('audit', 'approvals')) AS found",
  );
  if (existing.rows[0].found) {
    console.error('Hosted setup refused: Spendwall schemas already exist.');
    process.exitCode = 2;
  } else {
    for (const file of migrations)
      await pool.query(
        await readFile(
          new URL(`../migrations/${file}`, import.meta.url),
          'utf8',
        ),
      );
    await pool.query(
      await readFile(new URL('./hosting-reader.sql', import.meta.url), 'utf8'),
    );
    await pool.query(
      `ALTER ROLE spendwall_dashboard_reader PASSWORD ${pg.escapeLiteral(readerPassword)}`,
    );
    const group = (await pool.query('SELECT audit.app_role() AS name')).rows[0]
      .name;
    await pool.query(
      `CREATE ROLE ${writerRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${pg.escapeLiteral(writerPassword)}`,
    );
    await pool.query(`GRANT ${pg.escapeIdentifier(group)} TO ${writerRole}`);
    console.log(
      'Hosted setup complete: migrations, restricted reader and synthetic writer are ready.',
    );
  }
} catch {
  console.error(
    'Hosted setup failed. Check the owner URL, its TLS mode and the passwords.',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
