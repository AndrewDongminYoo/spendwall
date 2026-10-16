import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';
import { checkHostedReader } from '../apps/firewall/src/dashboard/hosted-reader.ts';

let pool, server;
try {
  if (process.argv.length !== 2) throw new Error();
  const configFile = process.env.SPENDWALL_DASHBOARD_CONFIG;
  if (!configFile || !isAbsolute(configFile)) throw new Error();
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const fields = [
    'identityKey',
    'merchantId',
    'token',
    'agents',
    'databaseTls',
  ];
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !fields.includes(key))
  )
    throw new Error();
  const database = new URL(process.env.SPENDWALL_DASHBOARD_DATABASE_URL ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    database.search ||
    database.hash
  )
    throw new Error();
  const tls = config.databaseTls ?? 'verify-full';
  if (
    tls !== 'verify-full' &&
    !(
      tls === 'disable' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
    )
  )
    throw new Error();
  const portText = process.env.PORT ?? '';
  if (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535)
    throw new Error();
  pool = new pg.Pool({
    connectionString: database.toString(),
    ssl: tls === 'verify-full' ? { rejectUnauthorized: true } : false,
    max: 4,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
    query_timeout: 6000,
    options: '-c default_transaction_read_only=on',
  });
  // pg removes failed idle clients; keep the process available for readiness
  // and let the next request reconnect without logging connection details.
  pool.on('error', () => {});
  // The migration owner, writer and replay reader must never run this service.
  await checkHostedReader(pool);
  server = await startDashboardServer({
    pool,
    identityKey: config.identityKey,
    token: config.token,
    merchantId: config.merchantId,
    ...(config.agents === undefined ? {} : { agents: config.agents }),
    hosted: { publicOrigin: process.env.SPENDWALL_PUBLIC_ORIGIN ?? '' },
    port: Number(portText),
  });
  console.log(
    'Hosted read-only dashboard API ready; UI deployment remains disabled.',
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } finally {
      await pool.end();
    }
  };
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    });
} catch {
  console.error(
    'Hosted dashboard startup failed. Check the private configuration and restricted database reader.',
  );
  await server?.close();
  await pool?.end();
  process.exitCode = 1;
}
