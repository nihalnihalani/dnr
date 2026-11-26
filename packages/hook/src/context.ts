/**
 * Per-invocation hook context: repo root, store, config, clock, and the session bookkeeping that
 * every hook event performs (§5.7: any DNR hook event starts a session).
 */

import { findRepoRoot, snapshotTree } from '@dnr/git';
import type { Decision, DnrConfig, EventRecord, Session } from '@dnr/schemas';
import {
  newEventId,
  newSession,
  nowMs,
  openStore,
  type SessionKey,
  type Store,
  sessionExpired,
  sessionKeyFor,
} from '@dnr/store';
import { createPatch } from 'diff';
import type { HookEvent } from './event';
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
  config: DnrConfig;
  now: () => number;
}

export async function openContext(cwd: string, env: NodeJS.ProcessEnv): Promise<HookContext | null> {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return null;
  const store = openStore(repoRoot, { env });
  const { config } = await store.loadConfig();
  return { env, repoRoot, store, config, now: () => nowMs(env) };
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
): Promise<{ session: Session; events: EventRecord[]; created: boolean }> {
  const now = ctx.now();
  const at = isoAt(now);
  let s = cur;
  let created = false;
  if (s && sessionExpired(s, ctx.config.session_ttl_minutes, now)) s = null;
  if (!s) {
    s = newSession({
      key,
      baseline_tree: await snapshotTree(ctx.repoRoot),
      orders_hash: ctx.store.ordersHash(),
      at,
    });
    created = true;
  }
  s.last_seen_at = at;
  await ctx.store.grants.claimPending(s.session_key, now);
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
  for (const e of events) await ctx.store.appendEvent(e, { record: ctx.config.mode === 'record' });
}
