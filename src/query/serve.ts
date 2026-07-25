/**
 * Minimal HTTP server exposing `QueryApi` plus the static demo page (web/). No framework —
 * `node:http` is enough for three routes and a file server (house rule: prefer the standard
 * library over a dependency; see ~/.claude/CLAUDE.md's "before writing new code" ladder).
 *
 * `handleApiRequest` is deliberately independent of `node:http`'s `IncomingMessage`/
 * `ServerResponse` — it takes a pathname and `URLSearchParams`, returns a plain `ApiResult` — so
 * test/query.test.ts can exercise routing and param validation without binding a port.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize as normalizePathSegment, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArkivReadConfig } from '../config.js';
import type { QueryApi } from '../types.js';
import { createQueryApi } from './index.js';
import { isAddrLike, toLowerAddr } from './normalize.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export interface ApiErrorBody {
  readonly status: number;
  readonly error: string;
}

/** Result of routing one `/api/*` request. `StrategyAttestation`'s only numeric-looking fields
 * (`committed`, `lastBlock`) are already decimal strings on the type (src/types.ts) — there is no
 * bigint anywhere in this payload to lose precision on a plain `JSON.stringify`. */
export type ApiResult =
  | { readonly status: 200; readonly body: readonly unknown[] }
  | { readonly status: 400 | 404 | 500; readonly body: ApiErrorBody };

function badRequest(message: string): { status: 400; body: ApiErrorBody } {
  return { status: 400, body: { status: 400, error: message } };
}

/** Routes one `/api/*` request against `api`. Exported so tests can call it directly. */
export async function handleApiRequest(
  api: QueryApi,
  pathname: string,
  params: URLSearchParams,
): Promise<ApiResult> {
  try {
    if (pathname === '/api/strategies') {
      const tokenA = params.get('tokenA');
      const tokenB = params.get('tokenB');
      if (tokenA === null || tokenB === null) {
        return badRequest('Query params tokenA and tokenB are both required.');
      }
      if (!isAddrLike(tokenA) || !isAddrLike(tokenB)) {
        return badRequest(
          'tokenA and tokenB must each be a 20-byte hex address (0x followed by 40 hex chars).',
        );
      }
      const result = await api.strategiesByPair(toLowerAddr(tokenA), toLowerAddr(tokenB));
      return { status: 200, body: result };
    }

    if (pathname === '/api/maker') {
      const maker = params.get('maker');
      if (maker === null) {
        return badRequest('Query param maker is required.');
      }
      if (!isAddrLike(maker)) {
        return badRequest('maker must be a 20-byte hex address (0x followed by 40 hex chars).');
      }
      const result = await api.strategiesByMaker(toLowerAddr(maker));
      return { status: 200, body: result };
    }

    if (pathname === '/api/underfunded') {
      const result = await api.underfundedMakers();
      return { status: 200, body: result };
    }

    return { status: 404, body: { status: 404, error: `No such route: ${pathname}` } };
  } catch (err) {
    // Never leak a stack trace to the client — log server-side, return a generic message.
    console.error(`[query] request to ${pathname} failed:`, err);
    return { status: 500, body: { status: 500, error: 'Internal error handling the request.' } };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

/**
 * Serves a static file from `webDir`. Path-traversal guard: the requested path is normalised
 * (collapsing `..` segments) before being joined onto `webDir`, and the final resolved path must
 * still fall inside `webDir` — a request like `/../../.env` cannot escape the directory.
 */
async function serveStatic(webDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const relPath = pathname === '/' ? '/index.html' : pathname;
  const target = resolve(join(webDir, normalizePathSegment(relPath)));
  const withinWebDir = target === webDir || target.startsWith(webDir + sep);
  if (!withinWebDir) {
    sendJson(res, 403, { status: 403, error: 'Forbidden.' });
    return;
  }
  try {
    const data = await readFile(target);
    const contentType = CONTENT_TYPES[extname(target)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch {
    sendJson(res, 404, { status: 404, error: 'Not found.' });
  }
}

export function createRequestHandler(
  api: QueryApi,
  webDir: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const result = await handleApiRequest(api, url.pathname, url.searchParams);
      sendJson(res, result.status, result.body);
      return;
    }
    await serveStatic(webDir, url.pathname, res);
  };
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  // `loadArkivReadConfig()` — not `loadArkivConfig()` — because this server is read-only and
  // Arkiv reads are public: it needs an RPC endpoint and the Arkiv chain id, never a private key.
  // Requiring a signing key here would mean nobody could even load the demo page without a
  // funded key, and a read path holding one at all is a needless liability. Both values default
  // from the SDK's own `braga` chain export when unset, so the server starts with zero env
  // configured too.
  const config = loadArkivReadConfig();
  const api = createQueryApi(config);
  // `resolve()` strips the trailing slash `fileURLToPath` leaves from the trailing-slash URL, so
  // this matches the un-slashed form `serveStatic`'s traversal guard compares `target` against.
  const webDir = resolve(fileURLToPath(new URL('../../web/', import.meta.url)));
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);

  const server = createServer((req, res) => {
    createRequestHandler(api, webDir)(req, res).catch((err: unknown) => {
      console.error('[query] unhandled request error:', err);
      if (!res.headersSent) sendJson(res, 500, { status: 500, error: 'Internal error.' });
    });
  });
  server.listen(port, () => {
    console.log(`[query] demo server listening on http://localhost:${port}`);
  });
}
