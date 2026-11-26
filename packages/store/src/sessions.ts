/**
 * Sessions (§5.7): `<state>/sessions/<session_key>.json`. The key is `sha256(session_id)`; with
 * no session_id the fallback key is derived from `realpath(cwd)` and is cleared only by
 * SessionEnd or an idle timeout (`session_ttl_minutes`).
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Session } from '@dnr/schemas';
import { nowMs } from './clock';
import { readJsonOrNull, withLock, writeJsonAtomic } from './fsutil';

export interface SessionKey {
  key: string;
  source: 'hook' | 'fallback';
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * `sha256(session_id)` when the event carries one; otherwise `cwd-<sha256(realpath(cwd))>`.
 * The fallback is hashed (not the raw path) so it is safe in file names (grant files embed it).
 */
export function sessionKeyFor(sessionId: string | null | undefined, cwd: string): SessionKey {
  if (typeof sessionId === 'string' && sessionId.length > 0)
    return { key: sha256(sessionId), source: 'hook' };
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {}
  return { key: `cwd-${sha256(real)}`, source: 'fallback' };
}

export class SessionStore {
  constructor(readonly sessionsDir: string) {}

  fileFor(key: string): string {
    return join(this.sessionsDir, `${key}.json`);
  }

  async get(key: string): Promise<Session | null> {
    const raw = await readJsonOrNull(this.fileFor(key));
    if (raw === null) return null;
    const r = Session.safeParse(raw);
    return r.success ? r.data : null;
  }

  async put(s: Session): Promise<void> {
    await writeJsonAtomic(this.fileFor(s.session_key), Session.parse(s));
  }

  async delete(key: string): Promise<boolean> {
    const existed = (await readJsonOrNull(this.fileFor(key))) !== null;
    await rm(this.fileFor(key), { force: true });
    return existed;
  }

  async list(): Promise<Session[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.sessionsDir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: Session[] = [];
    for (const n of names.sort()) {
      const s = await this.get(n.slice(0, -5));
      if (s) out.push(s);
    }
    return out;
  }

  /** Read-modify-write a session under its lock. `fn` receives null when none exists. */
  async with<T>(
    key: string,
    fn: (s: Session | null) => Promise<{ session: Session | null; result: T }>,
  ): Promise<T> {
    return withLock(this.fileFor(key), async () => {
      const cur = await this.get(key);
      const { session, result } = await fn(cur ? structuredClone(cur) : null);
      if (session) await this.put(session);
      return result;
    });
  }

  /** Set orders_hash on every session (called after a guarded order mutation, §5.11). */
  async refreshOrdersHash(hash: string): Promise<void> {
    for (const s of await this.list()) {
      if (s.orders_hash === hash) continue;
      await this.with(s.session_key, async (cur) =>
        cur ? { session: { ...cur, orders_hash: hash }, result: null } : { session: null, result: null },
      );
    }
  }
}

/** A fallback session idle longer than the TTL is expired (§5.7). Hook-keyed sessions persist until end/gc. */
export function sessionExpired(s: Session, ttlMinutes: number, now = nowMs()): boolean {
  if (s.key_source !== 'fallback') return false;
  return now - Date.parse(s.last_seen_at) > ttlMinutes * 60_000;
}

/** gc: any session idle longer than the TTL. */
export function sessionIdle(s: Session, ttlMinutes: number, now = nowMs()): boolean {
  return now - Date.parse(s.last_seen_at) > ttlMinutes * 60_000;
}

export function newSession(input: {
  key: SessionKey;
  baseline_tree: string;
  orders_hash: string;
  at: string;
}): Session {
  return {
    session_key: input.key.key,
    key_source: input.key.source,
    baseline_tree: input.baseline_tree,
    orders_hash: input.orders_hash,
    started_at: input.at,
    last_seen_at: input.at,
    warned: [],
    pending_ask: [],
    grants_used: [],
    touched: [],
    shell_snapshot: null,
    stop_forced_turns: 0,
  };
}
