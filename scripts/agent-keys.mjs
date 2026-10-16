import { open, readFile, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import {
  issueAgentKey,
  revokeAgentKey,
} from '../apps/firewall/src/agent-auth.ts';

const [action, flag, configPath, outputFlag, outputPath, ...extra] =
  process.argv.slice(2);
if (
  !['issue', 'revoke'].includes(action) ||
  flag !== '--config' ||
  !configPath ||
  !isAbsolute(configPath) ||
  extra.length ||
  (action === 'issue'
    ? outputFlag !== '--output' || !outputPath || !isAbsolute(outputPath)
    : outputFlag !== undefined)
) {
  console.error(
    'Usage: node scripts/agent-keys.mjs issue|revoke --config /absolute/private.json [--output /absolute/new-key.json]',
  );
  process.exitCode = 2;
} else {
  let pool, output, issued, merchant;
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (typeof config.databaseUrl !== 'string' || !config.databaseUrl)
      throw new Error();
    merchant = config.merchantId;
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 1,
      connectionTimeoutMillis: 2000,
      statement_timeout: 2000,
      query_timeout: 2500,
    });
    if (action === 'issue') {
      output = await open(outputPath, 'wx', 0o600);
      issued = await issueAgentKey(
        pool,
        merchant,
        config.agentId,
        config.tools,
      );
      await output.writeFile(JSON.stringify(issued) + '\n');
      await output.sync();
      console.log('Agent credential written to the new private file.');
    } else {
      if (!(await revokeAgentKey(pool, merchant, config.keyId)))
        throw new Error();
      console.log('Agent credential revoked.');
    }
  } catch {
    if (issued) {
      try {
        await revokeAgentKey(pool, merchant, issued.id);
      } catch {
        console.error(
          'Credential rollback unavailable; the database owner must inspect recent issuance before reuse.',
        );
      }
    }
    if (output) {
      await output.close();
      output = undefined;
      await unlink(outputPath).catch(() => {});
    }
    console.error(
      'Agent key operation failed. Check private configuration, database privileges and output path.',
    );
    process.exitCode = 1;
  } finally {
    await output?.close();
    await pool?.end();
  }
}
