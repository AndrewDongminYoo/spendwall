import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { AgentAuthority } from '../apps/firewall/src/agent-auth.ts';
import { startProxy } from '../apps/firewall/src/server.ts';

if (
  process.argv.length !== 4 ||
  process.argv[2] !== '--config' ||
  !isAbsolute(process.argv[3])
) {
  console.error(
    'Usage: node scripts/agent-proxy.mjs --config /absolute/private-agent-proxy.json',
  );
  process.exitCode = 2;
} else {
  let pool, proxy;
  try {
    const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
    if (
      typeof config.databaseUrl !== 'string' ||
      !config.databaseUrl ||
      typeof config.ledgerPath !== 'string' ||
      !isAbsolute(config.ledgerPath)
    )
      throw new Error();
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 4,
      connectionTimeoutMillis: 2000,
      statement_timeout: 2000,
      query_timeout: 2500,
    });
    const agentAuth = new AgentAuthority(pool, config.merchantId);
    await pool.query('SELECT id FROM agent_auth.credentials LIMIT 0');
    proxy = await startProxy({
      agentAuth,
      ledgerPath: config.ledgerPath,
      port: config.port ?? 3001,
      transport: config.transport ?? 'http',
    });
    console.log(`Spendwall agent-authenticated sandbox proxy: ${proxy.url}`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await proxy.close();
      await pool.end();
    };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
  } catch {
    await proxy?.close();
    await pool?.end();
    console.error(
      'Agent proxy startup failed. Check private configuration, database and sandbox connectivity.',
    );
    process.exitCode = 1;
  }
}
