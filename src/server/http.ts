import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from '../core/log.ts';
import { handleApi, readStaticFile, type ApiContext } from './api.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  readonly port: number;
  /** Bind address. Loopback only by default — this is a personal, local tool. */
  readonly host?: string;
  readonly publicDir?: string;
}

/**
 * The local HTTP server.
 *
 * Binds to 127.0.0.1 by default. There is no authentication because there is
 * no remote surface: the socket is not reachable from another machine. A
 * same-origin check on mutating requests prevents a random web page in the
 * user's browser from driving the API via a cross-site request.
 */
export function createServer(ctx: ApiContext, opts: ServerOptions): http.Server {
  const publicDir = opts.publicDir ?? path.resolve(HERE, '../../public');
  const host = opts.host ?? '127.0.0.1';

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log.error('request failed', { url: req.url, err: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${opts.port}`}`);
    const method = req.method ?? 'GET';

    // Never cache API responses; the numbers change under the user's feet.
    const baseHeaders: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };

    if (url.pathname.startsWith('/api/')) {
      // CSRF guard for state-changing verbs.
      if (method !== 'GET' && method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin) {
          try {
            const o = new URL(origin);
            if (o.hostname !== host && o.hostname !== 'localhost' && o.hostname !== '127.0.0.1') {
              res.writeHead(403, { ...baseHeaders, 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'Cross-origin requests are not allowed.' }));
              return;
            }
          } catch {
            res.writeHead(403, { ...baseHeaders, 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid origin.' }));
            return;
          }
        }
      }

      let body: unknown;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        body = await readJsonBody(req);
      }
      const result = await handleApi(ctx, method, url, body);
      if (result.raw !== undefined) {
        res.writeHead(result.status, {
          ...baseHeaders,
          'content-type': result.contentType ?? 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(result.raw);
        return;
      }
      res.writeHead(result.status, {
        ...baseHeaders,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(result.body));
      return;
    }

    const file = readStaticFile(publicDir, url.pathname);
    if (file) {
      res.writeHead(200, {
        ...baseHeaders,
        'content-type': file.type,
        'cache-control': url.pathname === '/' ? 'no-store' : 'no-cache',
        // No external anything: the dashboard is fully self-contained.
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      });
      res.end(file.body);
      return;
    }

    // SPA fallback so deep links work.
    const index = readStaticFile(publicDir, '/index.html');
    if (index) {
      res.writeHead(200, {
        ...baseHeaders,
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(index.body);
      return;
    }

    res.writeHead(404, { ...baseHeaders, 'content-type': 'text/plain' });
    res.end('Not found. Run `npm run build` to produce the dashboard assets.');
  }

  return server;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    // Import payloads are the largest legitimate body; 32 MB is generous.
    if (size > 32 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(b);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Start the server, trying successive ports if the preferred one is busy. */
export async function listen(
  server: http.Server,
  port: number,
  host = '127.0.0.1',
  attempts = 12,
): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const p = port + i;
    const ok = await new Promise<boolean>((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE') resolve(false);
        else resolve(false);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    });
    if (ok) return p;
  }
  throw new Error(`Could not bind to any port in ${port}–${port + attempts - 1}`);
}
