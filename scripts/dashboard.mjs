import { isAbsolute } from 'node:path';
import { PolicyReplay } from '../apps/firewall/src/policy-preview/replay.ts';
import { claudePolicy } from '../apps/firewall/src/policy-preview/claude.ts';
import { startReplayRetention } from '../apps/firewall/src/policy-preview/retention.ts';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';
import { claudeQuery } from '../apps/firewall/src/dashboard/claude-query.ts';

if (process.argv.length !== 4 || process.argv[2] !== '--config') {
  console.error(
    'Usage: pnpm dashboard --config /absolute/private-dashboard.json',
  );
  process.exit(2);
}
let pool, replayPool, stopRetention;
try {
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
  if (typeof config.databaseUrl !== 'string') throw new Error();
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 2000,
  });
  let policyPreview;
  if (config.policyPreview) {
    const preview = config.policyPreview;
    if (
      !isAbsolute(preview.policyPath) ||
      typeof preview.databaseUrl !== 'string'
    )
      throw new Error();
    const replay = new PolicyReplay(preview.encryptionKey);
    replay.assertIndependent(config.identityKey);
    replay.assertIndependent(config.token);
    replayPool = new pg.Pool({
      connectionString: preview.databaseUrl,
      max: 2,
      connectionTimeoutMillis: 2000,
      statement_timeout: 5000,
      query_timeout: 6000,
    });
    stopRetention = await startReplayRetention(replayPool, replay);
    policyPreview = {
      accessToken: preview.accessToken,
      pool: replayPool,
      replay,
      loadPolicy: () => readFile(preview.policyPath, 'utf8'),
      ...(preview.claude ? { generate: claudePolicy(preview.claude) } : {}),
    };
  }
  const server = await startDashboardServer({
    ...(policyPreview ? { policyPreview } : {}),
    pool,
    identityKey: config.identityKey,
    merchantId: config.merchantId,
    token: config.token,
    agents: config.agents,
    ...(config.reconciliation ? { reconciliation: config.reconciliation } : {}),
    ...(config.claude
      ? {
          classify: claudeQuery({
            apiKey: config.claude.apiKey,
            model: config.claude.model,
          }),
        }
      : {}),
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
    await stopRetention?.();
    await replayPool?.end();
    await pool.end();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
} catch {
  console.error(
    'Dashboard startup failed. Check the private configuration and database.',
  );
  await stopRetention?.();
  await replayPool?.end();
  await pool?.end();
  process.exitCode = 1;
}
