import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PayPalWebhookVerifier } from '../apps/firewall/src/webhooks/paypal.ts';
import {
  Reconciliation,
  checkWebhookReceiver,
} from '../apps/firewall/src/webhooks/reconciliation.ts';
import { startWebhookServer } from '../apps/firewall/src/webhooks/server.ts';
import { DisputeEvents } from '../apps/firewall/src/disputes/tracking.ts';

if (
  process.argv.length !== 4 ||
  process.argv[2] !== '--config' ||
  !isAbsolute(process.argv[3])
) {
  console.error(
    'Usage: node scripts/webhooks.mjs --config /absolute/private-webhooks.json',
  );
  process.exit(2);
}
let pool;
try {
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
  if (typeof config.databaseUrl !== 'string') throw new Error();
  const verifier = new PayPalWebhookVerifier({
    webhookId: config.webhookId,
    merchantId: config.merchantId,
  });
  const reconciliation = new Reconciliation({
    identityKey: config.identityKey,
    merchantId: config.merchantId,
    adapterRef: verifier.adapterRef,
  });
  const disputes = new DisputeEvents({
    identityKey: config.identityKey,
    merchantId: config.merchantId,
    adapterRef: verifier.adapterRef,
  });
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  await checkWebhookReceiver(pool);
  const server = await startWebhookServer({
    verifier,
    receive: async (event) => {
      const { disputeTracking } = await checkWebhookReceiver(pool);
      if (event.kind === 'dispute') {
        // Without migration 013, dispute events stay ignored as before.
        if (!disputeTracking) return 'ignored';
        await disputes.receive(pool, event);
      } else await reconciliation.receive(pool, event);
    },
    port: config.port ?? 4402,
  });
  console.log(
    `Spendwall sandbox webhook receiver: ${server.url}/webhooks/paypal`,
  );
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
    'Webhook startup failed. Check the private configuration, sandbox credentials and database role.',
  );
  await pool?.end();
  process.exitCode = 1;
}
