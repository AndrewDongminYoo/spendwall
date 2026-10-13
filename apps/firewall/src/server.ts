import 'reflect-metadata';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types.js';

import { RefundExecutor } from './refunds.ts';
import { createTokenManager } from './token.ts';
import type { TokenOptions } from './token.ts';
import { PayPalUpstream } from './upstream.ts';

type Options = TokenOptions & {
  proxyKey?: string;
  ledgerPath?: string;
  expectedTools?: Tool[];
  transport?: 'http' | 'sse';
  port?: number;
  timeoutMs?: number;
};

class ProxyModule {}
Module({})(ProxyModule);

function reject(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

export async function startProxy(options: Options = {}) {
  const env = options.env ?? process.env;
  const key = options.proxyKey ?? env.SPENDWALL_PROXY_KEY;
  if (!key || !/^[A-Za-z0-9_-]{32,128}$/.test(key))
    throw new Error('Set a 32–128 character SPENDWALL_PROXY_KEY locally.');
  const transport = options.transport ?? env.PAYPAL_MCP_TRANSPORT ?? 'http';
  if (transport !== 'http' && transport !== 'sse')
    throw new Error('PAYPAL_MCP_TRANSPORT must be http or sse.');
  const port = options.port ?? 3001;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid proxy port.');
  const tokens = createTokenManager({ ...options, env });
  const upstream = new PayPalUpstream({ ...options, transport, tokens });
  const expected: Tool[] =
    options.expectedTools ??
    JSON.parse(
      await readFile(
        new URL('../../../docs/paypal-mcp-tools.json', import.meta.url),
        'utf8',
      ),
    ).tools.map((tool: unknown) => ToolSchema.parse(tool));
  const tools = await upstream.listTools(expected);
  const validator = new AjvJsonSchemaValidator();
  const validators = new Map(
    tools.map((tool) => [
      tool.name,
      validator.getValidator(tool.inputSchema as JsonSchemaType),
    ]),
  );
  const refunds = await RefundExecutor.open({
    ...options,
    env,
    tokens,
    ledgerPath:
      options.ledgerPath ??
      fileURLToPath(
        new URL('../../../.spendwall/refunds.json', import.meta.url),
      ),
  });
  const active = new Set<Server>();
  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(ProxyModule, {
      logger: false,
      bodyParser: false,
      abortOnError: false,
    });
    let origin = '';
    app.use('/mcp', (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        if (
          req.headers.host !== new URL(origin).host ||
          (req.headers.origin !== undefined && req.headers.origin !== origin)
        ) {
          reject(res, 403, 'Forbidden origin or host.');
          return;
        }
        const provided = Buffer.from(req.headers.authorization ?? '');
        const expectedKey = Buffer.from(`Bearer ${key}`);
        if (
          provided.length !== expectedKey.length ||
          !timingSafeEqual(provided, expectedKey)
        ) {
          reject(res, 401, 'Local proxy authentication required.');
          return;
        }
        if (req.method !== 'POST') {
          reject(res, 405, 'Use MCP POST requests.');
          return;
        }
        if (!req.headers['content-type']?.startsWith('application/json')) {
          reject(res, 415, 'JSON is required.');
          return;
        }
        let length = 0;
        const chunks: Buffer[] = [];
        req.setTimeout(5_000, () => req.destroy());
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk);
          length += buffer.length;
          if (length > 1_048_576) {
            reject(res, 413, 'Request is too large.');
            return;
          }
          chunks.push(buffer);
        }
        req.setTimeout(0);
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(res, 400, 'Invalid JSON.');
          return;
        }
        const server = new Server(
          { name: 'spendwall-firewall', version: '1.0.0' },
          { capabilities: { tools: {} } },
        );
        active.add(server);
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools,
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const { name, arguments: args = {}, _meta } = request.params;
          const check = validators.get(name);
          if (!check || !check(args).valid)
            return {
              isError: true,
              content: [
                { type: 'text', text: 'Unknown tool or invalid arguments.' },
              ],
            };
          if (name === 'create_refund') {
            const id = _meta?.['spendwall/execution-id'];
            if (typeof id !== 'string')
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: 'Refund requires spendwall/execution-id metadata.',
                  },
                ],
              };
            try {
              const result = await refunds.execute(id, args);
              if (tokens.isSensitive(result))
                throw new Error('Unsafe refund result.');
              return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                structuredContent: result,
              };
            } catch {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: 'Refund not confirmed. Preserve the execution ID and inspect the local ledger before retrying.',
                  },
                ],
              };
            }
          }
          try {
            return await upstream.call({ name, arguments: args });
          } catch {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: 'PayPal MCP request failed or timed out; no automatic retry was attempted.',
                },
              ],
            };
          }
        });
        const downstream = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        res.on('close', () => {
          active.delete(server);
          void server.close();
        });
        // SDK concrete transports declare optional fields differently from Transport.
        await server.connect(downstream as Transport);
        await downstream.handleRequest(req, res, body);
      })().catch(() => {
        if (!res.headersSent && !res.destroyed)
          reject(res, 500, 'Proxy request failed.');
      });
    });
    await app.listen(port, '127.0.0.1');
    origin = await app.getUrl();
    const runningApp = app;
    let closed = false;
    return {
      url: `${origin}/mcp`,
      transport,
      toolCount: tools.length,
      async close() {
        if (closed) return;
        closed = true;
        await Promise.all([...active].map((server) => server.close()));
        await refunds.close();
        await runningApp.close();
      },
    };
  } catch (error) {
    await refunds.close();
    await app?.close();
    throw error;
  }
}
