import { startProxy } from './server.ts';

if (import.meta.main) {
  try {
    const proxy = await startProxy({
      port: Number(process.env.SPENDWALL_PROXY_PORT ?? 3001),
    });
    console.log(
      JSON.stringify({
        environment: 'sandbox',
        url: proxy.url,
        transport: proxy.transport,
        tools: proxy.toolCount,
      }),
    );
    const shutdown = () => {
      void proxy.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch {
    console.error(
      'Proxy startup failed. Check sandbox credentials, local key, catalog and ledger.',
    );
    process.exitCode = 1;
  }
}
