/**
 * Per-invocation hook context: repo root, store, config, clock, and the session bookkeeping that
 * every hook event performs (§5.7: any DNR hook event starts a session).
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot, runGit, snapshotTree } from '@dnr/git';
import type { Decision, DnrConfig, EventRecord, Session } from '@dnr/schemas';
import {
  hookLog,
  newEventId,
  newSession,
  nowMs,
  openStore,
  type SessionKey,
  type Store,
  sessionExpired,
  sessionKeyFor,
  withLock,
} from '@dnr/store';
import { createPatch } from 'diff';
import type { HookEvent } from './event';
import { loadTrusted, openTamper, type TrustedState, writeSessionOrders } from './trusted';
import { DNR_VERSION } from './version';

export type HookName = EventRecord['hook'];
export type Mode = DnrConfig['mode'];

export interface HookIO {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const OK: HookIO = { exitCode: 0, stdout: '', stderr: '' };

export interface HookOptions {
  env?: NodeJS.ProcessEnv;
  /** Process cwd (relative stdin `cwd` resolves against it). */
  cwd?: string;
}

export interface HookContext {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  store: Store;
  /** The trusted config (committed when the working copy differs; defaults when invalid). */
  config: DnrConfig;
  /** Effective orders and tamper signals (wave-2 C1). */
  trusted: TrustedState;
  /** The repo's filesystem is case-insensitive (wave-2 C2): compare paths case-folded. */
  fold: boolean;
  now: () => number;
}

const foldCache = new Map<string, boolean>();

/** Detect once per repo whether its filesystem is case-insensitive (`.git` vs `.GIT` resolve to one inode). */
export function caseInsensitive(repoRoot: string): boolean {
  const hit = foldCache.get(repoRoot);
  if (hit !== undefined) return hit;
  let ci = false;
  try {
    const a = statSync(join(repoRoot, '.git'));
    const upper = join(repoRoot, '.GIT');
    ci = existsSync(upper) && statSync(upper).ino === a.ino;
  } catch {}
  foldCache.set(repoRoot, ci);
  return ci;
}

export async function openContext(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionKey: string | null = null,
): Promise<HookContext | null> {
  const found = findRepoRoot(cwd);
  if (!found) return null;
  let repoRoot = found;
  try {
    repoRoot = realpathSync.native(found);
  } catch {}
  const store = openStore(repoRoot, { env });
  const trusted = await loadTrusted({
    repoRoot,
    ordersDir: store.paths.ordersDir,
    configFile: store.paths.configFile,
    stateDir: store.paths.stateDir,
    attestedFile: store.paths.attestedFile,
    env,
    sessionKey,
  });
  if (trusted.configIssue) hookLog(store.paths.hookLog, `config: ${trusted.configIssue}`);
  // Wave-3 N1/N3: weakened orders and a broken repository open the persistent tamper flag.
  const tamper = [
    ...trusted.weakened.map((id) => `order ${id} was removed or weakened without a human-attested change`),
    ...(trusted.gitBroken ? [`the git repository is unusable: ${trusted.gitBroken}`] : []),
  ];
  const held = trusted.weakened
    .map((id) => trusted.orders.get(id))
    .filter((o): o is NonNullable<typeof o> => !!o);
  const fresh = openTamper(store.paths.stateDir, tamper, new Date(nowMs(env)).toISOString(), held);
  for (const f of fresh) hookLog(store.paths.hookLog, `tamper: ${f}`);
  return {
    env,
    repoRoot,
    store,
    config: trusted.config,
    trusted,
    fold: caseInsensitive(repoRoot),
    now: () => nowMs(env),
  };
}

export function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

export function baseDecision(partial: Partial<Decision> & Pick<Decision, 'outcome' | 'tier'>): Decision {
  return {
    order_id: null,
    edit_score: null,
    prox_score: null,
    fired_by: null,
    scope: 'order',
    breakdown: [],
    reason_line: null,
    latency_ms: 0,
    fast_path: false,
    ...partial,
  };
}

export function makeEvent(
  ctx: Pick<HookContext, 'config' | 'now'>,
  input: {
    hook: HookName;
    session_key: string | null;
    raw: unknown;
    target_rel: string | null;
    decision: Decision;
    proposed_text?: string | null;
    session_patch?: string | null;
    event_id?: string;
  },
): EventRecord {
  return {
    event_id: input.event_id ?? newEventId(),
    at: isoAt(ctx.now()),
    mode: ctx.config.mode,
    hook: input.hook,
    session_key: input.session_key,
    raw: input.raw,
    target_rel: input.target_rel,
    proposed_text: input.proposed_text ?? null,
    session_patch: input.session_patch ?? null,
    decision: input.decision,
    dnr_version: DNR_VERSION,
    kiro_cli_version: null,
  };
}

export function keyOf(ev: HookEvent): SessionKey {
  return sessionKeyFor(ev.session_id, ev.cwd);
}

/** The committed tree (HEAD^{tree}), or null on an unborn HEAD. */
async function headTree(repoRoot: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], {
    cwd: repoRoot,
    okCodes: [0, 1, 128],
  });
  return r.code === 0 ? r.stdout.trim() : null;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Did this session key log events before (so a missing session file was deleted, not new)? */
function seenBefore(ctx: HookContext, key: string): boolean {
  try {
    return readFileSync(ctx.store.paths.eventsFile, 'utf8').includes(`"session_key":"${key}"`);
  } catch {
    return false;
  }
}

/**
 * Read the session, robust to tampering (wave-2 C1). A corrupt, unreadable or deleted session is
 * rebuilt with the committed tree as its baseline (the agent's edits are then scored, not
 * absorbed) and an `orders_hash` of `rebuilt:<why>`, so Stop reports it.
 */
async function readSessionChecked(
  ctx: HookContext,
  key: SessionKey,
): Promise<{ session: Session | null; rebuilt: string | null }> {
  const file = ctx.store.sessions.fileFor(key.key);
  let raw: string | null = null;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { session: null, rebuilt: 'unreadable' };
  }
  if (raw === null) return { session: null, rebuilt: seenBefore(ctx, key.key) ? 'deleted' : null };
  const s = await ctx.store.sessions.get(key.key).catch(() => null);
  return s ? { session: s, rebuilt: null } : { session: null, rebuilt: 'corrupt' };
}

/**
 * Create the session if needed (baseline = temp-index snapshot), expire an idle fallback session,
 * claim pending allow-once grants, and expire pending asks (each one logs `ask_denied`).
 * Returns the updated session and the events to append once the session lock is released.
 */
export async function prepareSession(
  ctx: HookContext,
  key: SessionKey,
  cur: Session | null,
  hook: HookName,
  rebuilt: string | null = null,
): Promise<{ session: Session; events: EventRecord[]; created: boolean }> {
  const now = ctx.now();
  const at = isoAt(now);
  let s = cur;
  let created = false;
  if (s && sessionExpired(s, ctx.config.session_ttl_minutes, now)) s = null;
  if (!s) {
    let baseline: string;
    if (rebuilt) {
      baseline = (await headTree(ctx.repoRoot)) ?? EMPTY_TREE;
      hookLog(
        ctx.store.paths.hookLog,
        `session ${key.key.slice(0, 12)} ${rebuilt}: rebuilt with the committed tree as baseline`,
      );
    } else {
      baseline = await snapshotTree(ctx.repoRoot).catch(
        async () => (await headTree(ctx.repoRoot)) ?? EMPTY_TREE,
      );
    }
    writeSessionOrders(
      ctx.store.paths.stateDir,
      key.key,
      ctx.trusted.headSha,
      ctx.trusted.orders.values(),
      [...ctx.trusted.sources.committed.values()].filter((o) => o.status === 'approved').map((o) => o.id),
    );
    s = newSession({
      key,
      baseline_tree: baseline,
      orders_hash: rebuilt ? `rebuilt:${rebuilt}` : ctx.store.ordersHash(),
      at,
    });
    created = true;
  }
  s.last_seen_at = at;
  await ctx.store.grants.claimPending(s.session_key, now).catch(() => []);
  const events: EventRecord[] = [];
  const keep: Session['pending_ask'] = [];
  for (const p of s.pending_ask) {
    if (Date.parse(p.expires_at) <= now) {
      events.push(
        makeEvent(ctx, {
          hook,
          session_key: s.session_key,
          raw: null,
          target_rel: p.file,
          decision: baseDecision({ outcome: 'ask_denied', tier: 'match', order_id: p.order_id }),
        }),
      );
    } else keep.push(p);
  }
  s.pending_ask = keep;
  return { session: s, events, created };
}

/**
 * Run `fn` on the prepared session under its lock and save the result. Tampered state (a lock
 * that never frees, an unwritable sessions dir) never stops the decision: the lock is broken
 * after its timeout, and a failed save is logged while the decision still stands.
 */
export async function withSession<T>(
  ctx: HookContext,
  key: SessionKey,
  hook: HookName,
  fn: (prep: { session: Session; events: EventRecord[]; created: boolean }) => Promise<T>,
): Promise<T> {
  const run = async () => {
    const { session, rebuilt } = await readSessionChecked(ctx, key);
    const prep = await prepareSession(ctx, key, session, hook, rebuilt);
    const result = await fn(prep);
    try {
      await ctx.store.sessions.put(prep.session);
    } catch (e) {
      hookLog(ctx.store.paths.hookLog, `session save failed (${String(e).slice(0, 120)}); decision kept`);
    }
    return result;
  };
  try {
    return await withLock(ctx.store.sessions.fileFor(key.key), run);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR' || code === 'EEXIST' || code === 'ENOENT')
      return run();
    throw e;
  }
}

export function addTouched(s: Session, rel: string): void {
  if (!s.touched.includes(rel)) s.touched.push(rel);
  s.touched.sort();
}

/** Unified diff of every given file, baseline vs proposed (EventRecord.session_patch). */
export function sessionPatch(
  files: readonly string[],
  baseline: (f: string) => string | null,
  proposed: (f: string) => string | null,
): string {
  const parts: string[] = [];
  for (const f of [...new Set(files)].sort()) {
    const a = baseline(f);
    const b = proposed(f);
    if (a === b) continue;
    parts.push(
      createPatch(
        f,
        a ?? '',
        b ?? '',
        a === null ? '(absent)' : 'baseline',
        b === null ? '(deleted)' : 'proposed',
      ),
    );
  }
  return parts.join('');
}

export async function appendEvents(ctx: HookContext, events: EventRecord[]): Promise<void> {
  for (const e of events) {
    try {
      await ctx.store.appendEvent(e, { record: ctx.config.mode === 'record' });
    } catch (err) {
      hookLog(ctx.store.paths.hookLog, `event append failed (${String(err).slice(0, 120)})`);
    }
  }
}
