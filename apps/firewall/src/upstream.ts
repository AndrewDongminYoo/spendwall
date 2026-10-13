import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { canonical, isRecord } from './refunds.ts';
import type { createTokenManager } from './token.ts';

type Options = {
  tokens: ReturnType<typeof createTokenManager>;
  transport: 'http' | 'sse';
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class PayPalUpstream {
  private options: Options;
  constructor(options: Options) {
    this.options = options;
  }

  private async run<T>(
    operationName: 'catalog' | 'tool',
    operation: (client: Client, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const client = new Client({ name: 'spendwall-proxy', version: '1.0.0' });
    let stage: string = 'initialization';
    let failedStatus: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Upstream deadline exceeded.'));
      }, this.options.timeoutMs ?? 15_000);
    });
    const authenticatedFetch: typeof fetch = async (input, init = {}) => {
      controller.signal.throwIfAborted();
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== 'https://mcp.sandbox.paypal.com')
        throw new Error('Unexpected upstream origin.');
      const token = await this.options.tokens.get();
      controller.signal.throwIfAborted();
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      const response = await (this.options.fetchImpl ?? fetch)(input, {
        ...init,
        headers,
        redirect: 'error',
        signal: AbortSignal.any([
          controller.signal,
          ...(init.signal ? [init.signal] : []),
        ]),
      });
      if (response.status === 401) this.options.tokens.invalidate(token);
      failedStatus = response.ok ? undefined : response.status;
      return response;
    };
    try {
      return await Promise.race([
        deadline,
        (async () => {
          const url = new URL(
            `https://mcp.sandbox.paypal.com/${this.options.transport}`,
          );
          const transport =
            this.options.transport === 'sse'
              ? new SSEClientTransport(url, { fetch: authenticatedFetch })
              : new StreamableHTTPClientTransport(url, {
                  fetch: authenticatedFetch,
                  reconnectionOptions: {
                    maxRetries: 0,
                    initialReconnectionDelay: 1_000,
                    maxReconnectionDelay: 1_000,
                    reconnectionDelayGrowFactor: 1,
                  },
                });
          // Keep strict optional-property checks; adapt the SDK's inconsistent declarations here.
          await client.connect(transport as Transport);
          stage = operationName;
          const result = await operation(client, controller.signal);
          if (this.options.tokens.isSensitive(result))
            throw new Error('Unsafe upstream result.');
          return result;
        })(),
      ]);
    } catch {
      throw new Error(
        `PayPal MCP ${this.options.transport} ${stage} failed (${failedStatus ? `HTTP ${failedStatus}` : 'authentication, network, protocol or timeout'}); no automatic retry was attempted.`,
      );
    } finally {
      clearTimeout(timer!);
      controller.abort();
      await client.close().catch(() => {});
    }
  }

  async listTools(expected: Tool[]): Promise<Tool[]> {
    const tools = await this.run('catalog', async (client, signal) => {
      const found: Tool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        if (cursors.size >= 100) throw new Error('Too many catalog pages.');
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          signal,
        });
        found.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (cursors.has(cursor)) throw new Error('Repeated catalog cursor.');
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      return found.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    });
    const contract = (items: Tool[]) =>
      items
        .map((tool) => {
          const inputSchema = structuredClone(tool.inputSchema);
          if (
            tool.name === 'list_transactions' &&
            isRecord(inputSchema.properties)
          ) {
            // PayPal regenerates these two default timestamps when listing tools.
            for (const field of ['start_date', 'end_date']) {
              const property = inputSchema.properties[field];
              if (
                isRecord(property) &&
                typeof property.default === 'string' &&
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(
                  property.default,
                ) &&
                Number.isFinite(Date.parse(property.default))
              )
                property.default = '<rolling timestamp>';
            }
          }
          return { name: tool.name, inputSchema };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    if (
      tools.length === 0 ||
      new Set(tools.map((tool) => tool.name)).size !== tools.length ||
      canonical(contract(tools)) !== canonical(contract(expected))
    )
      throw new Error(
        'PayPal tool catalog/schema drift; refresh and review the snapshot.',
      );
    return tools;
  }

  async call(params: CallToolRequest['params']) {
    return this.run('tool', async (client, signal) => {
      const result = await client.callTool(params, undefined, { signal });
      if (result.isError) throw new Error('Upstream tool failed.');
      return result;
    });
  }
}
