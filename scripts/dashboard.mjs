import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';

if (process.argv.length !== 4 || process.argv[2] !== '--config') {
  console.error(
    'Usage: pnpm dashboard --config /absolute/private-dashboard.json',
  );
  process.exit(2);
}
let pool;
try {
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
  if (typeof config.databaseUrl !== 'string') throw new Error();
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 2000,
  });
  const server = await startDashboardServer({
    pool,
    identityKey: config.identityKey,
    merchantId: config.merchantId,
    token: config.token,
    agents: config.agents,
    port: config.port ?? 4400,
    staticDirectory: fileURLToPath(
      new URL('../apps/dashboard/dist', import.meta.url),
    ),
  });
  console.log(`Spendwall read-only dashboard: ${server.url}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    await pool.end();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
} catch {
  console.error(
    'Dashboard startup failed. Check the private configuration and database.',
  );
  await pool?.end();
  process.exitCode = 1;
}
