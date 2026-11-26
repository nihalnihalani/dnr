/**
 * `@dnr/board`: the local board server (plan §10). `dnr board` calls `startBoard` with a store
 * backed by `@dnr/store`, then opens `launchUrl` in the browser. The launch URL carries the
 * single-use nonce: it is never printed or logged (AUTH-08).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { createBoardApp, DEFAULT_PLAYGROUND_ORIGIN, randLabel } from './server';
import type { BoardStorePort } from './store-port';

export interface StartBoardOptions {
  store: BoardStorePort;
  version: string;
  /** 0/undefined = random free port. */
  port?: number;
  /** '127.0.0.1' forces the fallback (dnr board --host 127.0.0.1). */
  host?: 'auto' | '127.0.0.1';
  /** --open <id>: after launch, land on /orders/<id>. */
  openOrder?: string;
  /** Default 'https://dnr-playground.pages.dev'. */
  playgroundOrigin?: string;
  /** Built UI; default = apps/playground/dist resolved from this file. */
  staticDir?: string;
  /** ms clock, for nonce expiry tests. */
  now?: () => number;
  /** 'by' recorded in history/grants; default process.env.USER ?? 'human'. */
  user?: string;
}

export interface BoardHandle {
  port: number;
  /** Preferred board origin. */
  origin: string;
  launchHost: string;
  launchUrl: string;
  close(): Promise<void>;
}

export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../playground/dist', import.meta.url));

export async function startBoard(opts: StartBoardOptions): Promise<BoardHandle> {
  const server = createServer();
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', rej);
      res();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const { app, auth } = createBoardApp({
    store: opts.store,
    version: opts.version,
    port,
    rand: randLabel(),
    host: opts.host ?? 'auto',
    openOrder: opts.openOrder,
    playgroundOrigin: opts.playgroundOrigin ?? DEFAULT_PLAYGROUND_ORIGIN,
    staticDir: opts.staticDir ?? DEFAULT_STATIC_DIR,
    now: opts.now ?? Date.now,
    user: opts.user ?? process.env.USER ?? 'human',
  });
  server.on('request', getRequestListener(app.fetch));
  const nonce = auth.issueNonce();
  return {
    port,
    origin: `http://${auth.launchHost}`,
    launchHost: auth.launchHost,
    launchUrl: `http://${auth.loopbackHost}/launch?n=${nonce}`,
    close: () =>
      new Promise<void>((res, rej) => {
        server.close((e) => (e ? rej(e) : res()));
        server.closeAllConnections();
      }),
  };
}

export { type BoardApp, type BoardAuth, type BoardContext, createBoardApp } from './server';
export * from './store-port';
