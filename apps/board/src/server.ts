/**
 * The local board (plan §10): a Hono app serving the built UI and an authenticated JSON API.
 *
 * Authorization: launch nonce → one-time session ticket → per-launch HttpOnly cookie on the
 * `.localhost` launch host (or the 127.0.0.1 fallback). Every request passes a Host check (421);
 * `/api/*` needs the cookie (401); mutating requests also need an exact Origin and `X-DNR-CSRF: 1` (403).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { ApiErrorBody, BoardStatus, Health } from '@dnr/ui/model';
import { checkTransition } from '@dnr/ui/model';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { type BoardStorePort, NotFoundError, TransitionError } from './store-port';

const ENFORCED = new Set(['approved', 'stale', 'relanded', 'violated']);

export const NONCE_TTL_MS = 60_000;
export const TICKET_TTL_MS = 60_000;
export const DEFAULT_PLAYGROUND_ORIGIN = 'https://dnr-playground.pages.dev';
/**
 * Hosted Playground origins whose `/orders/:id?board=<port>` view may probe `/api/health` (§10):
 * the Cloudflare Pages site and its GitHub Pages mirror. Health returns only `{origin, version}`.
 */
export const DEFAULT_PLAYGROUND_ORIGINS = [DEFAULT_PLAYGROUND_ORIGIN, 'https://nihalnihalani.github.io'];

export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

export interface BoardContext {
  store: BoardStorePort;
  version: string;
  port: number;
  /** Per-launch random label: launch host `dnr-<rand>.localhost:<port>`, cookie `dnr_<port>_<rand>`. */
  rand: string;
  /** `'127.0.0.1'` skips the `.localhost` host entirely. */
  host: 'auto' | '127.0.0.1';
  openOrder?: string | undefined;
  /** Hosted Playground origin(s) allowed to probe /api/health with CORS. */
  playgroundOrigin: string | string[];
  staticDir: string;
  now: () => number;
  user: string;
}

export interface BoardAuth {
  readonly launchHost: string;
  readonly loopbackHost: string;
  readonly cookieName: string;
  /** Mint a single-use launch nonce valid for 60 s from now. */
  issueNonce(): string;
  /** Origin of the host the last session cookie was issued on, else the preferred origin. */
  activeOrigin(): string;
}

export interface BoardApp {
  app: Hono;
  auth: BoardAuth;
}

const token = (bytes: number): string => randomBytes(bytes).toString('base64url');
export const randLabel = (): string => randomBytes(6).toString('hex');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(y, y);
    return false;
  }
  return timingSafeEqual(x, y);
}

/** Take a single-use token from `map` if present and unexpired. */
function consume(map: Map<string, number>, key: string | undefined, now: number): boolean {
  if (!key) return false;
  const exp = map.get(key);
  if (exp === undefined) return false;
  map.delete(key);
  return now < exp;
}

const err = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 421,
  error: ApiErrorBody['error'],
  message: string,
) => c.json({ error, message } satisfies ApiErrorBody, status);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const LAUNCH_JS = `(function () {
  var b = document.body;
  var t = encodeURIComponent(b.getAttribute('data-ticket') || '');
  var probe = b.getAttribute('data-probe') || '';
  var done = false;
  function go(url) { if (done) return; done = true; location.replace(url); }
  function fallback() { go('/session?t=' + t); }
  if (!probe) { fallback(); return; }
  var timer = setTimeout(fallback, 2000);
  fetch(probe + '/api/ping', { mode: 'cors', credentials: 'omit', cache: 'no-store' })
    .then(function (r) { clearTimeout(timer); if (r.ok) go(probe + '/session?t=' + t); else fallback(); })
    .catch(function () { clearTimeout(timer); fallback(); });
})();
`;

const EXPIRED_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DNR board</title></head>' +
  '<body><p>launch link expired; run dnr board again</p></body></html>';

const STUB_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="dnr-adapter" content="api">' +
  '<title>DNR board</title></head><body><p>The board UI is not built. Run ' +
  '<code>pnpm -F @dnr/playground build</code> and restart <code>dnr board</code>.</p></body></html>';

const PatchSchema = z
  .strictObject({
    status: z.enum(['draft', 'approved', 'retired']).optional(),
    reason: z.string().optional(),
  })
  .refine((b) => b.status !== undefined || b.reason !== undefined, { message: 'empty patch' });
const AllowOnceSchema = z.strictObject({ ttl: z.number().int().min(60).max(86_400).default(3600) });
const ConfirmGrantSchema = z.strictObject({ session_key: z.string().min(1).nullable() });

class BadRequest extends Error {}

async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest('body is not JSON');
  }
}

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequest(r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}

export function createBoardApp(ctx: BoardContext): BoardApp {
  const loopbackHost = `127.0.0.1:${ctx.port}`;
  const launchHost = ctx.host === '127.0.0.1' ? loopbackHost : `dnr-${ctx.rand}.localhost:${ctx.port}`;
  const allowedHosts = new Set([launchHost, loopbackHost]);
  const loopbackOrigin = `http://${loopbackHost}`;
  const preferredOrigin = `http://${launchHost}`;
  const cookieName = `dnr_${ctx.port}_${ctx.rand}`;
  const cookieValue = randomBytes(32).toString('hex');
  const nonces = new Map<string, number>();
  const tickets = new Map<string, number>();
  let active: string | null = null;

  const auth: BoardAuth = {
    launchHost,
    loopbackHost,
    cookieName,
    issueNonce() {
      const n = token(32);
      nonces.set(n, ctx.now() + NONCE_TTL_MS);
      return n;
    },
    activeOrigin: () => active ?? preferredOrigin,
  };

  const app = new Hono();

  // Security headers on every response, including errors.
  app.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Content-Security-Policy')) c.res.headers.set('Content-Security-Policy', CSP);
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    if (c.req.path.startsWith('/api/') || c.req.path === '/api')
      c.res.headers.set('Cache-Control', 'no-store');
  });

  // 421: Host check on every request (DNS rebinding).
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!allowedHosts.has(host)) return err(c, 421, 'misdirected', 'Host is not this board');
    await next();
  });

  // Public, CORS-enabled probes. No auth, no repository data.
  const health = (corsOrigins: string[]) => (c: Context) => {
    const origin = c.req.header('origin');
    c.header('Vary', 'Origin');
    const allowed = origin !== undefined && corsOrigins.includes(origin);
    if (allowed) {
      c.header('Access-Control-Allow-Origin', origin);
      if (c.req.header('access-control-request-private-network') === 'true') {
        c.header('Access-Control-Allow-Private-Network', 'true');
      }
    }
    if (c.req.method === 'OPTIONS') {
      if (allowed) {
        c.header('Access-Control-Allow-Methods', 'GET');
        c.header('Access-Control-Max-Age', '600');
      }
      return c.body(null, 204);
    }
    return c.json({ origin: auth.activeOrigin(), version: ctx.version } satisfies Health);
  };
  const playground = ([] as string[]).concat(ctx.playgroundOrigin);
  const healthHandler = health(playground);
  const pingHandler = health([...playground, loopbackOrigin]);
  app.on(['GET', 'OPTIONS'], '/api/health', healthHandler);
  app.on(['GET', 'OPTIONS'], '/api/ping', pingHandler);

  // 401 then 403 for the rest of the API.
  app.use('/api/*', async (c, next) => {
    const got = getCookie(c, cookieName);
    if (got === undefined || !safeEqual(got, cookieValue)) {
      return err(c, 401, 'unauthorized', 'Missing or invalid board session; run dnr board');
    }
    const m = c.req.method;
    if (m === 'POST' || m === 'PATCH' || m === 'PUT' || m === 'DELETE') {
      const host = c.req.header('host') ?? '';
      const origin = c.req.header('origin');
      if (!allowedHosts.has(host) || origin !== `http://${host}`) {
        return err(c, 403, 'forbidden', 'Missing or foreign Origin');
      }
      if (c.req.header('x-dnr-csrf') !== '1') return err(c, 403, 'forbidden', 'Missing X-DNR-CSRF header');
    }
    await next();
  });

  const by = ctx.user;
  app.get('/api/orders', async (c) => c.json({ orders: await ctx.store.listOrders() }));
  app.get('/api/orders/:id', async (c) => {
    const id = c.req.param('id');
    const row = await ctx.store.getOrder(id);
    if (!row) throw new NotFoundError(`No order ${id}`);
    return c.json({ ...row, grants: await ctx.store.listGrants(id) });
  });
  // The board applies the §10 state table itself, whatever store sits behind it: an invalid
  // transition (including a no-op such as draft → draft) and an allow-once on an order that is
  // not enforced are 409 before the store is touched.
  const rowOr404 = async (id: string) => {
    const row = await ctx.store.getOrder(id);
    if (!row) throw new NotFoundError(`No order ${id}`);
    return row;
  };
  app.patch('/api/orders/:id', async (c) => {
    const id = c.req.param('id');
    const body = parse(PatchSchema, await readJson(c));
    if (body.reason !== undefined) {
      body.reason = body.reason.trim();
      if (body.reason.length < 1 || body.reason.length > 280)
        throw new BadRequest('reason must be 1–280 characters');
    }
    const row = await rowOr404(id);
    if (body.status !== undefined) {
      const t = checkTransition(row.order.status, body.status);
      if (!t.ok) throw new TransitionError(t.message);
    }
    return c.json(await ctx.store.patchOrder(id, body, by));
  });
  app.post('/api/orders/:id/allow-once', async (c) => {
    const id = c.req.param('id');
    const { ttl } = parse(AllowOnceSchema, await readJson(c));
    const row = await rowOr404(id);
    if (!ENFORCED.has(row.effective))
      throw new TransitionError(`Allow once needs an enforced order; ${id} is ${row.effective}`);
    return c.json(await ctx.store.allowOnce(id, ttl, by));
  });
  // N5: a human confirms a suspect grant. Mutating, so the Origin and X-DNR-CSRF checks apply.
  app.post('/api/orders/:id/grants/confirm', async (c) => {
    const { session_key } = parse(ConfirmGrantSchema, await readJson(c));
    if (!ctx.store.confirmGrant) throw new NotFoundError('This store cannot confirm grants');
    return c.json(await ctx.store.confirmGrant(c.req.param('id'), session_key, by));
  });
  app.post('/api/orders/:id/reapprove', async (c) =>
    c.json(await ctx.store.reapprove(c.req.param('id'), by)),
  );
  app.get('/api/orders/:id/diff', async (c) => c.json(await ctx.store.diff(c.req.param('id'))));
  // Error banners (§10): the tamper flag and the hook's fail-open events, newest first.
  app.get('/api/status', async (c) => {
    const tamper = ctx.store.tamper ? await ctx.store.tamper() : null;
    const events = await ctx.store.listEvents({});
    const error_open = events
      .filter((e) => e.decision.outcome === 'error_open')
      .map((e) => {
        const b = e.decision.breakdown?.[0] as { error?: unknown } | undefined;
        return { at: e.at, hook: e.hook, error: typeof b?.error === 'string' ? b.error : '' };
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    return c.json({
      tamper: tamper ? { opened_at: tamper.opened_at, findings: tamper.findings } : null,
      error_open,
    } satisfies BoardStatus);
  });
  app.get('/api/events', async (c) => {
    const order = c.req.query('order');
    return c.json({ events: await ctx.store.listEvents(order ? { order } : {}) });
  });
  app.all('/api/*', (c) => err(c, 404, 'not_found', 'No such route'));

  // Launch: nonce → page carrying a session ticket → /session sets the cookie.
  app.get('/launch', (c) => {
    c.header('Cache-Control', 'no-store');
    if (!consume(nonces, c.req.query('n'), ctx.now())) return c.html(EXPIRED_HTML, 403);
    const ticket = token(32);
    tickets.set(ticket, ctx.now() + TICKET_TTL_MS);
    const probe = launchHost === loopbackHost ? '' : `http://${launchHost}`;
    // The probe is the only cross-origin fetch the board ever makes.
    c.header(
      'Content-Security-Policy',
      probe ? CSP.replace("connect-src 'self'", `connect-src 'self' ${probe}`) : CSP,
    );
    return c.html(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DNR board</title>' +
        '<script src="/launch.js" defer></script></head>' +
        `<body data-ticket="${escapeHtml(ticket)}" data-probe="${escapeHtml(probe)}">` +
        '<p>Opening the DNR board…</p></body></html>',
    );
  });
  app.get('/launch.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return c.body(LAUNCH_JS);
  });
  app.get('/session', (c) => {
    c.header('Cache-Control', 'no-store');
    if (!consume(tickets, c.req.query('t'), ctx.now())) return c.html(EXPIRED_HTML, 403);
    const host = c.req.header('host') ?? '';
    active = `http://${host}`;
    c.header('Set-Cookie', `${cookieName}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/api`);
    const to = ctx.openOrder ? `/orders/${encodeURIComponent(ctx.openOrder)}` : '/graveyard';
    return c.redirect(to, 302);
  });

  // Static UI with SPA fallback.
  const root = resolve(ctx.staticDir);
  const serveIndex = async (c: Context) => {
    let html: string;
    try {
      html = await readFile(join(root, 'index.html'), 'utf8');
    } catch {
      return c.html(STUB_HTML);
    }
    const injected = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<meta name="dnr-adapter" content="api">`);
    c.header('Cache-Control', 'no-cache');
    return c.html(injected);
  };
  app.get('*', async (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path);
    } catch {
      return serveIndex(c);
    }
    const file = resolve(root, `.${rel}`);
    if (
      rel !== '/' &&
      !rel.includes('\0') &&
      file.startsWith(root + sep) &&
      !file.endsWith(`${sep}index.html`)
    ) {
      const st = await stat(file).catch(() => null);
      if (st?.isFile()) {
        const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
        const data = await readFile(file);
        return c.body(new Uint8Array(data), 200, { 'Content-Type': type });
      }
    }
    return serveIndex(c);
  });

  app.notFound((c) => err(c, 404, 'not_found', 'Not found'));
  app.onError((e, c) => {
    if (e instanceof BadRequest) return err(c, 400, 'bad_request', e.message);
    // Matched by name too, so @dnr/store's own TransitionError / OrderNotFoundError map without importing ours.
    const name = (e as { name?: unknown } | null)?.name;
    const msg = (e as Error)?.message ?? String(e);
    if (e instanceof TransitionError || name === 'TransitionError')
      return err(c, 409, 'invalid_transition', msg);
    if (e instanceof NotFoundError || name === 'NotFoundError' || name === 'OrderNotFoundError')
      return err(c, 404, 'not_found', msg);
    // Not an ApiErrorBody code on purpose: an unexpected failure is not a client error. No details leak.
    return c.json({ error: 'internal', message: 'Internal board error' }, 500);
  });

  return { app, auth };
}
