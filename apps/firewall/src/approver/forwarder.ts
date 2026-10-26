import { request } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';
import { createServer } from 'node:https';
import { BlockList, isIPv4 } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

export type ForwarderOptions = {
  /** IPv4 address inside the Tailscale CGNAT range 100.64.0.0/10. */
  bind: string;
  /** Listening port. 0 selects an available port. */
  port: number;
  /** Lowercase MagicDNS name, for example `mac.tailnet.ts.net`. */
  host: string;
  /** PEM certificate and private key for `host`. */
  cert: string | Buffer;
  key: string | Buffer;
  /** The approval API origin, `http://127.0.0.1:<port>`. */
  apiUrl: string;
};

export type Forwarder = {
  origin: string;
  close: () => Promise<void>;
};

const tailnet = new BlockList();
tailnet.addSubnet('100.64.0.0', 10, 'ipv4');

/** True only for a canonical IPv4 address inside 100.64.0.0/10. */
export function isTailnetAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isIPv4(value) &&
    /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value) &&
    tailnet.check(value, 'ipv4')
  );
}

/** True for a lowercase DNS name under `ts.net`. */
export function isTailnetHost(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(value)
  );
}

const hopByHop = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined && !hopByHop.has(name) && !named.has(name))
      result[name] = value;
  return result;
}

function refuse(res: ServerResponse, code: number) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(JSON.stringify({ error: 'Forwarding refused.' }));
}

async function listen(
  options: ForwarderOptions,
  bindAllowed: (bind: string) => boolean,
): Promise<Forwarder> {
  const { bind, port, host } = options;
  let api: URL;
  try {
    api = new URL(options.apiUrl);
  } catch {
    throw new Error('Forwarder configuration unavailable.');
  }
  if (
    !bindAllowed(bind) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    // Clients omit :443 from Host and origin, which would break the exact
    // `<host>:<port>` match; port 443 is refused instead of special-cased.
    port === 443 ||
    !isTailnetHost(host) ||
    api.protocol !== 'http:' ||
    api.hostname !== '127.0.0.1' ||
    !api.port ||
    api.origin !== options.apiUrl.replace(/\/$/, '')
  )
    throw new Error('Forwarder configuration unavailable.');
  // The upstream Host is exactly the string the approval API compares against.
  const upstreamHost = api.host,
    upstreamPort = Number(api.port);
  let expectedHost = '';
  const sockets = new Set<Socket>();

  const server = createServer(
    { cert: options.cert, key: options.key },
    (req: IncomingMessage, res: ServerResponse) => {
      const hosts = req.rawHeaders.filter(
        (name, index) => index % 2 === 0 && name.toLowerCase() === 'host',
      );
      if (hosts.length !== 1 || req.headers.host !== expectedHost)
        return refuse(res, 421);
      // The native app never sends Origin; a browser context is refused here.
      if (req.headers.origin !== undefined) return refuse(res, 403);
      if (!req.url?.startsWith('/')) return refuse(res, 400);
      const headers = endToEnd(req.headers);
      headers.host = upstreamHost;
      const upstream = request(
        {
          host: '127.0.0.1',
          port: upstreamPort,
          method: req.method,
          path: req.url,
          headers,
          agent: false,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, endToEnd(response.headers));
          response.pipe(res);
          response.on('error', () => res.destroy());
        },
      );
      upstream.on('error', () => {
        if (res.headersSent) res.destroy();
        else refuse(res, 502);
      });
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy();
      });
      req.on('error', () => upstream.destroy());
      req.pipe(upstream);
    },
  );
  // Protocol upgrades and CONNECT tunnels are not part of the approval API.
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  // Track raw TCP sockets, including ones still in (or stalled before) the TLS
  // handshake, so close() never waits for the handshake timeout.
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const bound = (server.address() as AddressInfo).port;
  expectedHost = `${host}:${bound}`;
  let shutdown: Promise<void> | undefined;
  return {
    origin: `https://${expectedHost}`,
    close: () => {
      shutdown ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
      return shutdown;
    },
  };
}

/**
 * Terminates TLS on a tailnet address and forwards to the loopback approval
 * API. Refuses to start for any bind address outside 100.64.0.0/10.
 */
export function startApproverForwarder(
  options: ForwarderOptions,
): Promise<Forwarder> {
  return listen(options, isTailnetAddress);
}

/**
 * Test-only seam: identical forwarding, but binds only 127.0.0.1 because test
 * machines have no tailnet address. The recording CLI never imports it.
 */
export function startApproverForwarderForTest(
  options: ForwarderOptions,
): Promise<Forwarder> {
  return listen(options, (bind) => bind === '127.0.0.1');
}
