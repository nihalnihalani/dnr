/**
 * Board acceptance tests (plan §10): real HTTP against `startBoard` on a random port.
 * `node:http` is used so Host, Origin and Cookie can be set freely.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventRecord, Order } from '@dnr/schemas';
import type { OrderRow } from '@dnr/ui/model';
import { afterEach, describe, expect, it } from 'vitest';
import { type BoardHandle, MemoryStore, type StartBoardOptions, startBoard } from './index';

const PLAYGROUND = 'https://dnr-playground.pages.dev';
const SHA = (c: string) => c.repeat(40);

function order(id: string, status: Order['status']): Order {
  return {
    schema: 'dnr.order/v1',
    id,
    status,
    source: 'revert',
    original_sha: SHA('a'),
    revert_sha: SHA('b'),
    snapshot_sha: SHA('c'),
    tickets: [],
    links: [{ rel: 'original', url: 'https://example.com/commit/a' }],
    reason: 'Reverted: broke the parser',
    reason_source: 'drafter',
    units: [
      {
        file: 'src/a.py',
        qualname: 'f',
        kind: 'modified',
        tokenizer: { grammar: 'python', normalizer: 1 },
        A: ['x'],
        R: ['y'],
        c_state_ref: { sha: SHA('d'), file: 'src/a.py', qualname: 'f' },
        post_revert_hash: 'e'.repeat(64),
        post_revert_token_count: 3,
      },
    ],
    history: [{ at: '2026-01-01T00:00:00Z', by: 'dnr', action: 'created' }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const ID = {
  draft: 'dnr-000000000a',
  approved: 'dnr-000000000b',
  retired: 'dnr-000000000c',
  stale: 'dnr-000000000d',
  drift: 'dnr-000000000e',
};

function rows(): OrderRow[] {
  return [
    { order: order(ID.draft, 'draft'), effective: 'draft', drift: false },
    { order: order(ID.approved, 'approved'), effective: 'approved', drift: false },
    { order: order(ID.retired, 'retired'), effective: 'retired', drift: false },
    { order: order(ID.stale, 'approved'), effective: 'stale', drift: false },
    { order: order(ID.drift, 'approved'), effective: 'approved', drift: true },
  ];
}

function event(id: string, orderId: string | null): EventRecord {
  return {
    event_id: id,
    at: '2026-01-02T00:00:00Z',
    mode: 'enforce',
    hook: 'pre-write',
    session_key: 's1',
    raw: {},
    target_rel: 'src/a.py',
    proposed_text: null,
    session_patch: null,
    decision: {
      outcome: orderId ? 'block' : 'allow',
      tier: orderId ? 'match' : 'none',
      order_id: orderId,
      edit_score: null,
      prox_score: null,
      fired_by: null,
      scope: 'order',
      breakdown: [],
      reason_line: null,
      latency_ms: 1,
      fast_path: false,
    },
    dnr_version: '0.0.0',
    kiro_cli_version: null,
  };
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => unknown;
}

function http(
  port: number,
  path: string,
  opts: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const boards: BoardHandle[] = [];
afterEach(async () => {
  await Promise.all(boards.splice(0).map((b) => b.close()));
});

const emptyStatic = mkdtempSync(join(tmpdir(), 'dnr-board-empty-'));

async function start(over: Partial<StartBoardOptions> = {}) {
  const now = { t: 1_000_000 };
  const store = new MemoryStore({
    rows: rows(),
    events: [event('e1', ID.approved), event('e2', null)],
    now: () => now.t,
  });
  const board = await startBoard({
    store,
    version: '1.2.3',
    port: 0,
    staticDir: emptyStatic,
    now: () => now.t,
    user: 'tester',
    ...over,
  });
  boards.push(board);
  return { board, store, now };
}

const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};
const ticketOf = (html: string) => /data-ticket="([^"]+)"/.exec(html)?.[1] ?? '';
const probeOf = (html: string) => /data-probe="([^"]*)"/.exec(html)?.[1];

/** Run the launch flow, landing the session on `host`; returns the Cookie header value. */
async function login(board: BoardHandle, host = board.launchHost): Promise<string> {
  const launch = await http(board.port, pathOf(board.launchUrl));
  expect(launch.status).toBe(200);
  const s = await http(board.port, `/session?t=${ticketOf(launch.body)}`, { host });
  expect(s.status).toBe(302);
  const set = [s.headers['set-cookie'] ?? []].flat()[0] ?? '';
  return set.split(';')[0] ?? '';
}

function mutating(board: BoardHandle, cookie: string, extra: Record<string, string> = {}) {
  return {
    host: board.launchHost,
    headers: {
      cookie,
      origin: `http://${board.launchHost}`,
      'x-dnr-csrf': '1',
      'content-type': 'application/json',
      ...extra,
    },
  };
}

describe('board authorization', () => {
  it('AUTH-01: launch nonce is single-use and expires after 60 s', async () => {
    const { board } = await start();
    const first = await http(board.port, pathOf(board.launchUrl));
    expect(first.status).toBe(200);
    const second = await http(board.port, pathOf(board.launchUrl));
    expect(second.status).toBe(403);
    expect(second.body).toContain('launch link expired; run dnr board again');
    expect((await http(board.port, '/launch?n=nope')).status).toBe(403);
    expect((await http(board.port, '/launch')).status).toBe(403);

    const late = await start();
    late.now.t += 60_001;
    const expired = await http(late.board.port, pathOf(late.board.launchUrl));
    expect(expired.status).toBe(403);
    expect(expired.body).toContain('launch link expired');
  });

  it('AUTH-01: session ticket is single-use and expires', async () => {
    const { board } = await start();
    const launch = await http(board.port, pathOf(board.launchUrl));
    const t = ticketOf(launch.body);
    expect((await http(board.port, `/session?t=${t}`)).status).toBe(302);
    expect((await http(board.port, `/session?t=${t}`)).status).toBe(403);
    expect((await http(board.port, '/session?t=forged')).status).toBe(403);

    const b = await start();
    const l2 = await http(b.board.port, pathOf(b.board.launchUrl));
    b.now.t += 60_001;
    expect((await http(b.board.port, `/session?t=${ticketOf(l2.body)}`)).status).toBe(403);
  });

  it('AUTH-02: launch page probes the .localhost host; /session on either host sets the cookie', async () => {
    const { board } = await start();
    expect(board.launchHost).toMatch(new RegExp(`^dnr-[a-z0-9]{8,}\\.localhost:${board.port}$`));
    expect(board.origin).toBe(`http://${board.launchHost}`);
    expect(board.launchUrl.startsWith(`http://127.0.0.1:${board.port}/launch?n=`)).toBe(true);

    const launch = await http(board.port, pathOf(board.launchUrl));
    expect(launch.headers['content-type']).toMatch(/text\/html/);
    expect(probeOf(launch.body)).toBe(`http://${board.launchHost}`);
    expect(launch.body).toContain('<script src="/launch.js"');
    expect(launch.body).not.toMatch(/<script>(?!<)/);
    expect(launch.headers['content-security-policy']).toContain(
      `connect-src 'self' http://${board.launchHost}`,
    );
    expect(launch.headers['cache-control']).toBe('no-store');

    const js = await http(board.port, '/launch.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.body).toContain('/api/ping');
    expect(js.body).toContain('location.replace');

    // The probe target answers ping with CORS for the 127.0.0.1 launch page.
    const ping = await http(board.port, '/api/ping', {
      host: board.launchHost,
      headers: { origin: `http://127.0.0.1:${board.port}` },
    });
    expect(ping.status).toBe(200);
    expect(ping.headers['access-control-allow-origin']).toBe(`http://127.0.0.1:${board.port}`);

    // Cookie on the .localhost host (probe succeeded) and the active origin follows it.
    const s = await http(board.port, `/session?t=${ticketOf(launch.body)}`, { host: board.launchHost });
    expect(s.status).toBe(302);
    expect(s.headers.location).toBe('/graveyard');
    expect([s.headers['set-cookie']].flat()[0]).toMatch(/^dnr_/);
    const h = (await http(board.port, '/api/health')).json() as { origin: string };
    expect(h.origin).toBe(`http://${board.launchHost}`);

    // Fallback: cookie on 127.0.0.1 (probe failed, e.g. Safari).
    const b2 = await start();
    const l2 = await http(b2.board.port, pathOf(b2.board.launchUrl));
    const s2 = await http(b2.board.port, `/session?t=${ticketOf(l2.body)}`);
    expect(s2.status).toBe(302);
    expect([s2.headers['set-cookie']].flat()[0]).toMatch(/^dnr_/);
    const h2 = (await http(b2.board.port, '/api/health')).json() as { origin: string };
    expect(h2.origin).toBe(`http://127.0.0.1:${b2.board.port}`);
  });

  it("AUTH-02: host '127.0.0.1' skips the probe; --open lands on the order", async () => {
    const { board } = await start({ host: '127.0.0.1', openOrder: ID.approved });
    expect(board.launchHost).toBe(`127.0.0.1:${board.port}`);
    expect(board.origin).toBe(`http://127.0.0.1:${board.port}`);
    const launch = await http(board.port, pathOf(board.launchUrl));
    expect(probeOf(launch.body)).toBe('');
    expect(launch.body).not.toContain('.localhost');
    const s = await http(board.port, `/session?t=${ticketOf(launch.body)}`);
    expect(s.status).toBe(302);
    expect(s.headers.location).toBe(`/orders/${ID.approved}`);
    // No .localhost host is accepted at all in this mode.
    expect((await http(board.port, '/api/health', { host: `dnr-x.localhost:${board.port}` })).status).toBe(
      421,
    );
  });

  it('AUTH-03: a bad Host gets 421 on every route', async () => {
    const { board } = await start();
    const cookie = await login(board);
    const rand = board.launchHost.split('.')[0];
    const bad = [
      'evil.com',
      `evil.com:${board.port}`,
      `localhost:${board.port}`,
      `${rand}.localhost:${board.port + 1}`,
      `127.0.0.1:${board.port + 1}`,
      '127.0.0.1',
      `dnr-other.localhost:${board.port}`,
    ];
    for (const host of bad) {
      for (const path of [
        '/api/health',
        '/api/ping',
        '/api/orders',
        '/',
        pathOf(board.launchUrl),
        '/launch.js',
      ]) {
        const r = await http(board.port, path, { host, headers: { cookie } });
        expect(r.status, `${host} ${path}`).toBe(421);
        expect(r.json()).toMatchObject({ error: 'misdirected' });
      }
      const p = await http(board.port, `/api/orders/${ID.draft}`, {
        method: 'PATCH',
        host,
        headers: { cookie, origin: `http://${host}`, 'x-dnr-csrf': '1' },
        body: '{"status":"approved"}',
      });
      expect(p.status).toBe(421);
    }
    expect((await http(board.port, '/api/health', { host: board.launchHost })).status).toBe(200);
    expect((await http(board.port, '/api/health')).status).toBe(200);
  });

  it('AUTH-04: cookie name, attributes and per-launch rotation', async () => {
    const one = await start();
    const two = await start();
    const setCookie = async (b: BoardHandle) => {
      const l = await http(b.port, pathOf(b.launchUrl));
      const s = await http(b.port, `/session?t=${ticketOf(l.body)}`, { host: b.launchHost });
      return [s.headers['set-cookie']].flat()[0] ?? '';
    };
    const c1 = await setCookie(one.board);
    const c2 = await setCookie(two.board);
    for (const [c, b] of [
      [c1, one.board],
      [c2, two.board],
    ] as const) {
      const [pair, ...attrs] = c.split(';').map((s) => s.trim());
      const [name, value] = (pair ?? '').split('=');
      expect(name).toMatch(new RegExp(`^dnr_${b.port}_[a-z0-9]+$`));
      expect(value).toMatch(/^[0-9a-f]{64}$/);
      expect(attrs).toContain('HttpOnly');
      expect(attrs).toContain('SameSite=Strict');
      expect(attrs).toContain('Path=/api');
      expect(attrs.some((a) => /^domain=/i.test(a))).toBe(false);
    }
    expect(c1.split('=')[0]).not.toBe(c2.split('=')[0]);
    expect(c1.split(';')[0]?.split('=')[1]).not.toBe(c2.split(';')[0]?.split('=')[1]);
    // One launch's cookie does not open another launch's board (same name forced onto the other port).
    const forged = `${c2.split('=')[0]}=${c1.split(';')[0]?.split('=')[1]}`;
    expect((await http(two.board.port, '/api/orders', { headers: { cookie: forged } })).status).toBe(401);
  });

  it('AUTH-05: every /api route except health and ping needs the cookie', async () => {
    const { board } = await start();
    const cookie = await login(board);
    const name = cookie.split('=')[0];
    const routes: [string, string][] = [
      ['GET', '/api/orders'],
      ['GET', `/api/orders/${ID.approved}`],
      ['PATCH', `/api/orders/${ID.draft}`],
      ['POST', `/api/orders/${ID.approved}/allow-once`],
      ['POST', `/api/orders/${ID.stale}/reapprove`],
      ['GET', `/api/orders/${ID.approved}/diff`],
      ['GET', '/api/events'],
      ['GET', `/api/events?order=${ID.approved}`],
      ['GET', '/api/unknown'],
    ];
    const origin = `http://${board.launchHost}`;
    for (const [method, path] of routes) {
      for (const c of [
        undefined,
        `${name}=${'0'.repeat(64)}`,
        `${name}=short`,
        `dnr_1_x=${cookie.split('=')[1]}`,
      ]) {
        const headers: Record<string, string> = { origin, 'x-dnr-csrf': '1' };
        if (c) headers.cookie = c;
        const body = method === 'GET' ? undefined : '{}';
        const r = await http(board.port, path, {
          method,
          host: board.launchHost,
          headers,
          ...(body ? { body } : {}),
        });
        expect(r.status, `${method} ${path} ${c}`).toBe(401);
        expect(r.json()).toMatchObject({ error: 'unauthorized' });
        expect(typeof (r.json() as { message: unknown }).message).toBe('string');
      }
    }
    expect((await http(board.port, '/api/health')).status).toBe(200);
    expect((await http(board.port, '/api/ping')).status).toBe(200);
    // The valid cookie works on either allowed host.
    expect((await http(board.port, '/api/orders', { headers: { cookie } })).status).toBe(200);
  });

  it('AUTH-06: a mutating request with a missing or foreign Origin gets 403', async () => {
    const { board, store } = await start();
    const cookie = await login(board);
    const path = `/api/orders/${ID.draft}`;
    const body = '{"status":"approved"}';
    const base = mutating(board, cookie);
    const { origin: _o, ...noOrigin } = base.headers;
    const cases: Record<string, string>[] = [
      noOrigin,
      { ...base.headers, origin: 'http://evil.com' },
      { ...base.headers, origin: PLAYGROUND },
      { ...base.headers, origin: `http://127.0.0.1:${board.port}` }, // other allowed host, not this request's
      { ...base.headers, origin: `https://${board.launchHost}` },
      { ...base.headers, origin: 'null' },
    ];
    for (const headers of cases) {
      const r = await http(board.port, path, { method: 'PATCH', host: board.launchHost, headers, body });
      expect(r.status, JSON.stringify(headers.origin)).toBe(403);
      expect(r.json()).toMatchObject({ error: 'forbidden' });
    }
    for (const p of [`/api/orders/${ID.approved}/allow-once`, `/api/orders/${ID.stale}/reapprove`]) {
      const r = await http(board.port, p, {
        method: 'POST',
        host: board.launchHost,
        headers: noOrigin,
        body: '{}',
      });
      expect(r.status).toBe(403);
    }
    expect((await store.getOrder(ID.draft))?.order.status).toBe('draft');
    // The 127.0.0.1 host with its own origin is accepted.
    const ok = await http(board.port, path, {
      method: 'PATCH',
      headers: { ...base.headers, origin: `http://127.0.0.1:${board.port}` },
      body,
    });
    expect(ok.status).toBe(200);
  });

  it('AUTH-07: a mutating request without X-DNR-CSRF: 1 gets 403', async () => {
    const { board } = await start();
    const cookie = await login(board);
    const { 'x-dnr-csrf': _c, ...noCsrf } = mutating(board, cookie).headers;
    for (const headers of [noCsrf, { ...noCsrf, 'x-dnr-csrf': '0' }, { ...noCsrf, 'x-dnr-csrf': 'true' }]) {
      const r = await http(board.port, `/api/orders/${ID.draft}`, {
        method: 'PATCH',
        host: board.launchHost,
        headers,
        body: '{"status":"approved"}',
      });
      expect(r.status).toBe(403);
      expect(r.json()).toMatchObject({ error: 'forbidden' });
    }
    // Order of checks: no cookie beats missing CSRF (401 before 403).
    const { cookie: _k, ...anon } = noCsrf;
    const r = await http(board.port, `/api/orders/${ID.draft}`, {
      method: 'PATCH',
      host: board.launchHost,
      headers: anon,
    });
    expect(r.status).toBe(401);
  });

  it('AUTH-08: the launch nonce never reaches stdout or stderr', async () => {
    const written: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const errw = process.stderr.write.bind(process.stderr);
    const capture = (chunk: unknown) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return true;
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    let nonce = '';
    try {
      const { board } = await start();
      nonce = new URL(board.launchUrl).searchParams.get('n') ?? '';
      const cookie = await login(board);
      await http(board.port, pathOf(board.launchUrl)); // reuse → 403
      await http(board.port, '/api/orders', { headers: { cookie } });
      await http(board.port, '/', { host: 'evil.com' });
    } finally {
      process.stdout.write = out;
      process.stderr.write = errw;
    }
    expect(nonce.length).toBeGreaterThanOrEqual(32);
    for (const w of written) {
      expect(w).not.toContain(nonce);
      expect(w).not.toContain('n=');
    }
  });
});

describe('board API', () => {
  it('API-01: health and ping shape, CORS only for the Playground origin, PNA preflight', async () => {
    const { board } = await start();
    for (const path of ['/api/health', '/api/ping']) {
      const r = await http(board.port, path);
      expect(r.status).toBe(200);
      expect(r.json()).toEqual({ origin: board.origin, version: '1.2.3' });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.headers.vary).toMatch(/Origin/);
      expect(r.headers['cache-control']).toBe('no-store');

      const pg = await http(board.port, path, { headers: { origin: PLAYGROUND } });
      expect(pg.headers['access-control-allow-origin']).toBe(PLAYGROUND);
      expect(pg.headers.vary).toMatch(/Origin/);

      const evil = await http(board.port, path, { headers: { origin: 'https://evil.com' } });
      expect(evil.status).toBe(200);
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();

      const pre = await http(board.port, path, {
        method: 'OPTIONS',
        headers: {
          origin: PLAYGROUND,
          'access-control-request-method': 'GET',
          'access-control-request-private-network': 'true',
        },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers['access-control-allow-origin']).toBe(PLAYGROUND);
      expect(pre.headers['access-control-allow-methods']).toBe('GET');
      expect(pre.headers['access-control-allow-private-network']).toBe('true');

      const getPna = await http(board.port, path, {
        headers: { origin: PLAYGROUND, 'access-control-request-private-network': 'true' },
      });
      expect(getPna.headers['access-control-allow-private-network']).toBe('true');

      const preEvil = await http(board.port, path, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.com', 'access-control-request-private-network': 'true' },
      });
      expect(preEvil.headers['access-control-allow-origin']).toBeUndefined();
      expect(preEvil.headers['access-control-allow-private-network']).toBeUndefined();
    }
    // The 127.0.0.1 launch page may read ping, not health.
    const self = { origin: `http://127.0.0.1:${board.port}` };
    expect(
      (await http(board.port, '/api/ping', { headers: self })).headers['access-control-allow-origin'],
    ).toBe(self.origin);
    expect(
      (await http(board.port, '/api/health', { headers: self })).headers['access-control-allow-origin'],
    ).toBeUndefined();
    // Nothing else is CORS-enabled.
    const cookie = await login(board);
    const orders = await http(board.port, '/api/orders', { headers: { cookie, origin: PLAYGROUND } });
    expect(orders.headers['access-control-allow-origin']).toBeUndefined();
    const preOrders = await http(board.port, '/api/orders', {
      method: 'OPTIONS',
      headers: { origin: PLAYGROUND },
    });
    expect(preOrders.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('API-02: list, get, diff and events', async () => {
    const { board } = await start();
    const cookie = await login(board);
    const get = (p: string) => http(board.port, p, { host: board.launchHost, headers: { cookie } });

    const list = await get('/api/orders');
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    const { orders } = list.json() as { orders: OrderRow[] };
    expect(orders.map((r) => [r.order.id, r.effective, r.drift])).toEqual([
      [ID.draft, 'draft', false],
      [ID.approved, 'approved', false],
      [ID.retired, 'retired', false],
      [ID.stale, 'stale', false],
      [ID.drift, 'approved', true],
    ]);

    const detail = await get(`/api/orders/${ID.stale}`);
    expect(detail.json()).toMatchObject({
      order: { id: ID.stale },
      effective: 'stale',
      drift: false,
      grants: [],
    });

    const diff = await get(`/api/orders/${ID.drift}/diff`);
    expect(diff.status).toBe(200);
    const d = diff.json() as { file: Order; git: Order | null; unified: string };
    expect(d.file.id).toBe(ID.drift);
    expect(d.git?.id).toBe(ID.drift);
    expect(typeof d.unified).toBe('string');

    const all = (await get('/api/events')).json() as { events: EventRecord[] };
    expect(all.events.map((e) => e.event_id)).toEqual(['e1', 'e2']);
    const one = (await get(`/api/events?order=${ID.approved}`)).json() as { events: EventRecord[] };
    expect(one.events.map((e) => e.event_id)).toEqual(['e1']);

    for (const p of ['/api/orders/dnr-ffffffffff', '/api/orders/dnr-ffffffffff/diff', '/api/nope']) {
      const r = await get(p);
      expect(r.status).toBe(404);
      expect(r.json()).toMatchObject({ error: 'not_found' });
    }
  });

  it('API-03: invalid transitions are 409; draft → approved logs history', async () => {
    const { board } = await start();
    const cookie = await login(board);
    const patch = (id: string, body: string) =>
      http(board.port, `/api/orders/${id}`, { method: 'PATCH', ...mutating(board, cookie), body });

    for (const [id, status] of [
      [ID.approved, 'draft'],
      [ID.retired, 'approved'],
      [ID.draft, 'draft'],
    ] as const) {
      const r = await patch(id, JSON.stringify({ status }));
      expect(r.status, `${id} → ${status}`).toBe(409);
      expect(r.json()).toMatchObject({ error: 'invalid_transition' });
      expect((r.json() as { message: string }).message).toMatch(/Invalid transition/);
    }

    for (const bad of ['not json', '{"status":"stale"}', '{"status":1}', '{"extra":true}', '{}', '[]']) {
      const r = await patch(ID.draft, bad);
      expect(r.status, bad).toBe(400);
      expect(r.json()).toMatchObject({ error: 'bad_request' });
    }
    expect((await patch('dnr-ffffffffff', '{"status":"approved"}')).status).toBe(404);

    const ok = await patch(ID.draft, JSON.stringify({ status: 'approved', reason: '  Broke the parser  ' }));
    expect(ok.status).toBe(200);
    const row = ok.json() as OrderRow;
    expect(row.effective).toBe('approved');
    expect(row.order.status).toBe('approved');
    expect(row.order.reason).toBe('Broke the parser');
    expect(row.order.history.slice(-2)).toEqual([
      expect.objectContaining({ by: 'tester', action: 'approved' }),
      expect.objectContaining({ by: 'tester', action: 'edited_reason' }),
    ]);
    const again = await http(board.port, `/api/orders/${ID.draft}`, { headers: { cookie } });
    expect((again.json() as OrderRow).order.status).toBe('approved');
  });

  it('API-04: allow-once creates a grant; reapprove is 409 on approved and works on stale', async () => {
    const { board, now } = await start();
    const cookie = await login(board);
    const post = (p: string, body?: string) =>
      http(board.port, p, {
        method: 'POST',
        ...mutating(board, cookie),
        ...(body !== undefined ? { body } : {}),
      });

    const g = await post(`/api/orders/${ID.approved}/allow-once`, '{"ttl":120}');
    expect(g.status).toBe(200);
    expect(g.json()).toMatchObject({
      order_id: ID.approved,
      session_key: null,
      kind: 'allow_once',
      granted_by: 'tester',
      granted_at: new Date(now.t).toISOString(),
      expires_at: new Date(now.t + 120_000).toISOString(),
      used: [],
      blobs: [],
    });
    const dflt = await post(`/api/orders/${ID.approved}/allow-once`);
    expect(dflt.status).toBe(200);
    expect((dflt.json() as { expires_at: string }).expires_at).toBe(
      new Date(now.t + 3_600_000).toISOString(),
    );

    const detail = (await http(board.port, `/api/orders/${ID.approved}`, { headers: { cookie } })).json() as {
      grants: unknown[];
    };
    expect(detail.grants).toHaveLength(2);

    for (const bad of ['{"ttl":59}', '{"ttl":86401}', '{"ttl":1.5}', '{"ttl":"60"}']) {
      expect((await post(`/api/orders/${ID.approved}/allow-once`, bad)).status, bad).toBe(400);
    }
    expect((await post(`/api/orders/${ID.draft}/allow-once`, '{"ttl":60}')).status).toBe(409);
    expect((await post(`/api/orders/${ID.retired}/allow-once`, '{"ttl":60}')).status).toBe(409);

    const r409 = await post(`/api/orders/${ID.approved}/reapprove`);
    expect(r409.status).toBe(409);
    expect(r409.json()).toMatchObject({ error: 'invalid_transition' });

    const r = await post(`/api/orders/${ID.stale}/reapprove`);
    expect(r.status).toBe(200);
    const row = r.json() as OrderRow;
    expect(row.effective).toBe('approved');
    expect(row.order.history.at(-1)).toMatchObject({ by: 'tester', action: 'reapproved' });
    expect((await post(`/api/orders/${ID.stale}/reapprove`)).status).toBe(409);
  });

  it('STATIC: SPA fallback injects the api adapter meta; security headers; wasm type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnr-board-static-'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html><head><title>x</title></head><body></body></html>',
    );
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'tree-sitter.wasm'), new Uint8Array([0, 97, 115, 109]));
    const { board } = await start({ staticDir: dir });

    const idx = await http(board.port, '/orders/dnr-000000000a', { host: board.launchHost });
    expect(idx.status).toBe(200);
    expect(idx.body).toContain('<head><meta name="dnr-adapter" content="api">');
    expect(idx.headers['content-security-policy']).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(idx.headers['x-content-type-options']).toBe('nosniff');
    expect(idx.headers['referrer-policy']).toBe('no-referrer');
    expect((await http(board.port, '/')).body).toContain('dnr-adapter');

    const js = await http(board.port, '/app.js');
    expect(js.body).toBe('console.log(1)');
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect((await http(board.port, '/tree-sitter.wasm')).headers['content-type']).toBe('application/wasm');
    // No traversal out of staticDir.
    const trav = await http(board.port, '/..%2f..%2fetc%2fpasswd');
    expect(trav.body).toContain('dnr-adapter');

    const stub = await http(board.port, '/', { host: board.launchHost });
    expect(stub.status).toBe(200);
    const unbuilt = await start();
    const s = await http(unbuilt.board.port, '/graveyard');
    expect(s.status).toBe(200);
    expect(s.body).toContain('pnpm -F @dnr/playground build');
    expect(s.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    const e = await http(board.port, '/', { host: 'evil.com' });
    expect(e.headers['x-content-type-options']).toBe('nosniff');
  });
});
