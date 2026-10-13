import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { format } from 'prettier';

import { requestSandboxToken } from './check-paypal-sandbox.mjs';

const endpoint = 'https://mcp.sandbox.paypal.com/sse';
const failure =
  'PayPal MCP discovery failed; check sandbox credentials and connectivity.';

export async function discoverPayPalTools({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 60_000,
} = {}) {
  const client = new Client({ name: 'spendwall-discovery', version: '1.0.0' });
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(failure));
    }, timeoutMs);
  });
  const sandboxFetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      ![
        'https://api-m.sandbox.paypal.com',
        'https://mcp.sandbox.paypal.com',
      ].includes(url.origin)
    ) {
      throw new Error(failure);
    }
    return fetchImpl(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        controller.signal,
        ...(init.signal ? [init.signal] : []),
      ]),
    });
  };
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const token = await requestSandboxToken({
          env,
          fetchImpl: sandboxFetch,
        });
        const transport = new SSEClientTransport(new URL(endpoint), {
          fetch: sandboxFetch,
          requestInit: {
            headers: { Authorization: `Bearer ${token.access_token}` },
          },
        });
        await client.connect(transport);
        const tools = [];
        const names = new Set();
        const cursors = new Set();
        let cursor;
        let pages = 0;
        do {
          if (++pages > 100) throw new Error(failure);
          const result = await client.listTools(
            cursor === undefined ? undefined : { cursor },
            { signal: controller.signal },
          );
          for (const tool of result.tools) {
            if (names.has(tool.name)) throw new Error(failure);
            names.add(tool.name);
            tools.push(tool);
          }
          cursor = result.nextCursor;
          if (cursor !== undefined) {
            if (cursors.has(cursor)) throw new Error(failure);
            cursors.add(cursor);
          }
        } while (cursor !== undefined);
        if (tools.length === 0) throw new Error(failure);
        tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return {
          source: {
            endpoint,
            transport: 'sse',
            fetchedAt: new Date().toISOString(),
            pages,
          },
          tools,
        };
      })(),
    ]);
  } catch {
    throw new Error(failure);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await client.close().catch(() => {});
  }
}

export async function writeSnapshot(snapshot, target) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const text = await format(JSON.stringify(snapshot), { parser: 'json' });
    await writeFile(temporary, text, { flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (import.meta.main) {
  try {
    const snapshot = await discoverPayPalTools();
    await writeSnapshot(
      snapshot,
      fileURLToPath(new URL('../docs/paypal-mcp-tools.json', import.meta.url)),
    );
    console.log(
      `Saved ${snapshot.tools.length} tools from ${snapshot.source.pages} page(s) to docs/paypal-mcp-tools.json.`,
    );
  } catch {
    console.error(`${failure} No snapshot was saved.`);
    process.exitCode = 1;
  }
}
