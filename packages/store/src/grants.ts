/**
 * Grants (§5.4, §5.7, §7): `<state>/grants/<order_id>.<session_key>.json`. A next-session grant
 * (allow-once from a terminal) is `<order_id>.pending.json` until a session claims it.
 *
 * A grant applies to its order while it is unexpired, or for the rest of its session once it has
 * been used (R9). Pre-commit has no session: it allows a crossing commit when every staged blob
 * of the order's files equals a blob recorded in a used grant, from any session.
 */
import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Grant, type Session } from '@dnr/schemas';
import { nowIso, nowMs } from './clock';
import { readJsonOrNull, withLock, writeJsonAtomic } from './fsutil';

export const DEFAULT_GRANT_TTL_MS = 3_600_000;
export const ASK_PENDING_TTL_MS = 10 * 60_000;

export function grantApplies(
  g: Grant,
  session: Pick<Session, 'session_key' | 'grants_used'>,
  now = nowMs(),
): boolean {
  if (g.session_key !== session.session_key) return false;
  // Wave-3 N5: a suspect grant does not apply until a human confirms it.
  if (g.origin?.suspect && !g.origin.confirmed_at) return false;
  if (now < Date.parse(g.expires_at)) return true;
  return g.used.length > 0 && session.grants_used.includes(g.order_id);
}

export class GrantStore {
  constructor(readonly grantsDir: string) {}

  fileFor(orderId: string, sessionKey: string | null): string {
    return join(this.grantsDir, `${orderId}.${sessionKey ?? 'pending'}.json`);
  }

  async list(orderId?: string): Promise<Grant[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.grantsDir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: Grant[] = [];
    for (const n of names.sort()) {
      if (orderId && !n.startsWith(`${orderId}.`)) continue;
      const raw = await readJsonOrNull(join(this.grantsDir, n));
      const r = Grant.safeParse(raw);
      if (r.success) out.push(r.data);
    }
    return out;
  }

  async get(orderId: string, sessionKey: string | null): Promise<Grant | null> {
    const r = Grant.safeParse(await readJsonOrNull(this.fileFor(orderId, sessionKey)));
    return r.success ? r.data : null;
  }

  async put(g: Grant): Promise<void> {
    await writeJsonAtomic(this.fileFor(g.order_id, g.session_key), Grant.parse(g));
  }

  /** Create (or replace) a grant. `sessionKey` null = pending for the current or next session. */
  async create(input: {
    order_id: string;
    kind: Grant['kind'];
    session_key: string | null;
    granted_by: string;
    ttl_ms?: number;
    at?: number;
    /** How the grant was made and whether agent markers were seen (wave-2 C3/H4). */
    origin?: Grant['origin'];
  }): Promise<Grant> {
    const at = input.at ?? nowMs();
    const g: Grant = {
      order_id: input.order_id,
      session_key: input.session_key,
      kind: input.kind,
      granted_by: input.granted_by,
      granted_at: new Date(at).toISOString(),
      expires_at: new Date(at + (input.ttl_ms ?? DEFAULT_GRANT_TTL_MS)).toISOString(),
      used: [],
      blobs: [],
      ...(input.origin ? { origin: input.origin } : {}),
    };
    await withLock(this.fileFor(g.order_id, g.session_key), () => this.put(g));
    return g;
  }

  /** Bind unexpired pending grants to this session (the "current or next session" of allow-once). */
  async claimPending(sessionKey: string, now = nowMs()): Promise<Grant[]> {
    const claimed: Grant[] = [];
    for (const g of await this.list()) {
      if (g.session_key !== null) continue;
      if (now >= Date.parse(g.expires_at)) continue;
      const from = this.fileFor(g.order_id, null);
      const bound: Grant = { ...g, session_key: sessionKey };
      await writeJsonAtomic(this.fileFor(g.order_id, sessionKey), bound);
      await rm(from, { force: true });
      claimed.push(bound);
    }
    return claimed;
  }

  /** Grants of this session that currently apply. */
  async applying(session: Pick<Session, 'session_key' | 'grants_used'>, now = nowMs()): Promise<Grant[]> {
    return (await this.list()).filter((g) => grantApplies(g, session, now));
  }

  /** Record a use (`write`, `commit`, `backstop`) and the blobs it produced. */
  async recordUse(
    orderId: string,
    sessionKey: string | null,
    use: { event_id: string; kind: Grant['used'][number]['kind']; at?: string },
    blobs: Grant['blobs'] = [],
  ): Promise<Grant | null> {
    const file = this.fileFor(orderId, sessionKey);
    return withLock(file, async () => {
      const g = await this.get(orderId, sessionKey);
      if (!g) return null;
      g.used.push({ at: use.at ?? nowIso(), event_id: use.event_id, kind: use.kind });
      for (const b of blobs) {
        if (!g.blobs.some((x) => x.file === b.file && x.sha256 === b.sha256)) g.blobs.push(b);
      }
      await this.put(g);
      return g;
    });
  }

  /** Confirm suspect grants of an order (guarded `dnr allow --confirm`, the board). Returns them. */
  async confirm(
    orderId: string,
    sessionKey: string | null | undefined,
    by: string,
    at = nowIso(),
  ): Promise<Grant[]> {
    const done: Grant[] = [];
    for (const g of await this.list(orderId)) {
      if (g.order_id !== orderId) continue;
      if (sessionKey !== undefined && g.session_key !== sessionKey) continue;
      if (!g.origin?.suspect || g.origin.confirmed_at) continue;
      const next: Grant = { ...g, origin: { ...g.origin, confirmed_by: by, confirmed_at: at } };
      await withLock(this.fileFor(g.order_id, g.session_key), () => this.put(next));
      done.push(next);
    }
    return done;
  }

  /** Pre-commit rule (§5.7): a used grant (any session) whose blobs cover every staged blob. */
  async commitGrant(orderId: string, staged: Grant['blobs']): Promise<Grant | null> {
    for (const g of await this.list(orderId)) {
      if (g.order_id !== orderId || g.used.length === 0) continue;
      if (g.origin?.suspect && !g.origin.confirmed_at) continue;
      if (staged.every((s) => g.blobs.some((b) => b.file === s.file && b.sha256 === s.sha256))) return g;
    }
    return null;
  }

  /** gc: remove grants that are expired and were never used, and stale pending grants. */
  async gc(now = nowMs()): Promise<number> {
    let n = 0;
    for (const g of await this.list()) {
      if (now >= Date.parse(g.expires_at) && g.used.length === 0) {
        await rm(this.fileFor(g.order_id, g.session_key), { force: true });
        n++;
      }
    }
    return n;
  }

  async rename(orderId: string, from: string | null, to: string | null): Promise<void> {
    await rename(this.fileFor(orderId, from), this.fileFor(orderId, to));
  }
}
