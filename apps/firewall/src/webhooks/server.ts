import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PayPalWebhookVerifier, VerifiedEvent } from './paypal.ts';
import { WebhookError } from './paypal.ts';

function reply(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<string> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      req.headers['content-type'] ?? '',
    ) ||
    req.headers['content-encoding'] !== undefined
  )
    throw new WebhookError(415);
  const timer = setTimeout(() => req.destroy(), 5000);
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const part of req.iterator({ destroyOnReturn: false })) {
      const chunk = Buffer.from(part);
      bytes += chunk.length;
      if (bytes > 65536) {
        req.resume();
        throw new WebhookError(413);
      }
      chunks.push(chunk);
    }
    try {
      const raw = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(Buffer.concat(chunks));
      JSON.parse(raw);
      return raw;
    } catch {
      throw new WebhookError(400);
    }
  } finally {
    clearTimeout(timer);
  }
}
export async function startWebhookServer(options: {
  verifier: Pick<PayPalWebhookVerifier, 'verify'>;
  // Resolves to 'ignored' for a verified event that the deployment does not store.
  receive: (event: VerifiedEvent) => Promise<void | 'ignored'>;
  port?: number;
}) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid webhook port.');
  let origin = '',
    active = 0;
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 10000 },
    (req, res) => {
      void (async () => {
        if (
          req.headers.host !== new URL(origin).host ||
          req.headers.origin !== undefined
        )
          throw new WebhookError(403);
        if (req.url !== '/webhooks/paypal') throw new WebhookError(404);
        if (req.method !== 'POST') throw new WebhookError(405);
        const names = req.rawHeaders
          .filter((_, i) => i % 2 === 0)
          .map((name) => name.toLowerCase());
        if (
          names.some(
            (name, i) =>
              name.startsWith('paypal-') && names.indexOf(name) !== i,
          )
        )
          throw new WebhookError(400);
        if (active >= 4) throw new WebhookError(503);
        active++;
        try {
          const event = await options.verifier.verify(
            req.headers,
            await body(req),
          );
          const outcome = event ? await options.receive(event) : 'ignored';
          reply(res, 200, {
            status: outcome === 'ignored' ? 'ignored' : 'received',
          });
        } finally {
          active--;
        }
      })().catch((error: unknown) => {
        if (!res.headersSent)
          reply(res, error instanceof WebhookError ? error.code : 503, {
            error: 'Webhook was not accepted.',
          });
        else res.destroy();
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
