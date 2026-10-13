import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startProxy } from '../apps/firewall/src/server.ts';
import { requestSandboxToken } from './check-paypal-sandbox.mjs';
import { writeSnapshot } from './dump-paypal-mcp-tools.mjs';

function parseArgs(argv) {
  if (argv.length === 0) return { refund: false };
  if (
    argv.length !== 5 ||
    argv[0] !== '--refund' ||
    argv[1] !== '--capture' ||
    argv[3] !== '--execution-id' ||
    !/^[A-Za-z0-9_-]{15,32}$/.test(argv[2]) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      argv[4],
    )
  ) {
    throw new Error(
      'Usage: proxy-smoke.mjs [--refund --capture CAPTURE_ID --execution-id UUID]',
    );
  }
  return { refund: true, captureId: argv[2], executionId: argv[4] };
}

export async function runProxySmoke({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const args = parseArgs(argv);
  if (!env.PAYPAL_CLIENT_ID?.trim() || !env.PAYPAL_CLIENT_SECRET?.trim())
    throw new Error(
      'Load sandbox credentials locally before running the proxy check.',
    );
  const fixture = JSON.parse(
    await readFile(
      new URL('../fixtures/captures.json', import.meta.url),
      'utf8',
    ),
  );
  if (
    fixture.environment !== 'sandbox' ||
    fixture.clientIdHash !==
      createHash('sha256').update(env.PAYPAL_CLIENT_ID).digest('hex')
  )
    throw new Error('Capture fixture does not belong to this sandbox app.');
  const capture = args.refund
    ? fixture.captures.find((row) => row.id === args.captureId)
    : fixture.captures[0];
  if (!capture)
    throw new Error('Select a capture from fixtures/captures.json.');
  const key = randomBytes(32).toString('base64url');
  const proxy = await startProxy({ env, proxyKey: key, port: 0 });
  const client = new Client({ name: 'spendwall-smoke', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(proxy.url), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    const tools = await client.listTools();
    const order = await client.callTool({
      name: 'get_order',
      arguments: { id: capture.orderId },
    });
    if (order.isError || !JSON.stringify(order).includes(capture.orderId))
      throw new Error('Proxy order lookup was not confirmed.');
    const evidence = {
      environment: 'sandbox',
      transport: proxy.transport,
      toolCount: tools.tools.length,
      readTool: 'get_order',
      orderId: capture.orderId,
      checkedAt: new Date().toISOString(),
    };
    if (!args.refund) {
      await writeSnapshot(
        evidence,
        fileURLToPath(
          new URL('../fixtures/proxy-connection.json', import.meta.url),
        ),
      );
      return evidence;
    }
    const request = {
      name: 'create_refund',
      arguments: { capture_id: capture.id },
      _meta: { 'spendwall/execution-id': args.executionId },
    };
    const first = await client.callTool(request);
    if (first.isError || first.structuredContent?.status !== 'COMPLETED')
      throw new Error(
        'Refund not confirmed. Preserve this execution ID and inspect .spendwall/refunds.json.',
      );
    const duplicate = await client.callTool(request);
    const result = first.structuredContent;
    if (duplicate.isError || duplicate.structuredContent?.id !== result.id)
      throw new Error('Duplicate refund result was not confirmed.');
    const token = await requestSandboxToken({ env });
    const response = await fetch(
      `https://api-m.sandbox.paypal.com/v2/payments/refunds/${result.id}`,
      {
        headers: { Authorization: `Bearer ${token.access_token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error('Refund verification GET failed.');
    const verified = await response.json();
    if (
      verified.id !== result.id ||
      verified.status !== 'COMPLETED' ||
      verified.amount?.value !== result.amount.value ||
      verified.amount?.currency_code !== result.amount.currency_code
    )
      throw new Error(
        'Refund verification GET did not match the recorded result.',
      );
    const completed = {
      ...evidence,
      captureId: capture.id,
      executionId: args.executionId,
      refundId: result.id,
      duplicateRefundId: duplicate.structuredContent.id,
      amount: result.amount.value,
      currency: result.amount.currency_code,
      status: verified.status,
      verifiedBy: 'GET /v2/payments/refunds/{refund_id}',
    };
    await writeSnapshot(
      completed,
      fileURLToPath(new URL('../fixtures/proxy-refund.json', import.meta.url)),
    );
    return completed;
  } finally {
    await client.close().catch(() => {});
    await proxy.close();
  }
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runProxySmoke()));
  } catch (error) {
    const safeMessages = [
      'Usage:',
      'Load sandbox credentials',
      'Select a capture',
      'Capture fixture does not belong',
      'Refund not confirmed.',
      'PayPal MCP ',
      'PayPal tool catalog/schema drift;',
      'Refund ledger locked;',
      'Refund ledger belongs to a different sandbox app.',
      'Invalid refund ledger.',
      'Proxy order lookup was not confirmed.',
    ];
    console.error(
      safeMessages.some((prefix) => error.message?.startsWith(prefix))
        ? error.message
        : 'Proxy check failed. Check connectivity, credentials, catalog and the existing execution record; do not allocate a new refund ID to retry.',
    );
    process.exitCode = 1;
  }
}
