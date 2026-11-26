/**
 * Session hooks: `dnr session start|confirm|shell-after|show|end|gc` (§5.7, §5.11).
 */
import { resolve } from 'node:path';
import { applyTool } from '@dnr/core';
import { snapshotTree, treeDiffNames } from '@dnr/git';
import type { EventRecord, Session } from '@dnr/schemas';
import { sessionIdle, sha256 } from '@dnr/store';
import {
  addTouched,
  appendEvents,
  baseDecision,
  type HookIO,
  type HookOptions,
  isoAt,
  keyOf,
  makeEvent,
  OK,
  openContext,
  withSession,
} from './context';
import { parseHookEvent } from './event';
import { failOpen } from './failopen';
import { postShellCheck, postShellReason } from './post-shell';
import { readWorktree, repoRelative } from './repo';

/** `dnr session start --stdin` (SessionStart). */
export function runSessionStart(stdin: string, opts: HookOptions = {}): Promise<HookIO> {
  return failOpen('session-start', stdin, opts, async () => {
    const env = opts.env ?? process.env;
    const ev = parseHookEvent(stdin, opts.cwd);
    const ctx = await openContext(ev.cwd, env);
    if (!ctx) return { ...OK };
    const key = keyOf(ev);
    const events: EventRecord[] = [];
    await withSession(ctx, key, 'session-start', async (prep) => {
      events.push(...prep.events);
      events.push(
        makeEvent(ctx, {
          hook: 'session-start',
          session_key: key.key,
          raw: ev.raw,
          target_rel: null,
          decision: baseDecision({ outcome: 'allow', tier: 'none', breakdown: [{ created: prep.created }] }),
        }),
      );
      return null;
    });
    await appendEvents(ctx, events);
    return { ...OK };
  });
}

/**
 * `dnr session confirm --stdin` (PostToolUse on write tools, §5.7). When the written file now
 * matches a pending ask's `proposed_sha256`, the human approved it: create an `ask` grant,
 * add the order to `grants_used`, record a `write` use with the blob, and log `ask_approved`.
 */
export function runSessionConfirm(stdin: string, opts: HookOptions = {}): Promise<HookIO> {
  return failOpen('post-write', stdin, opts, async () => {
    const env = opts.env ?? process.env;
    const ev = parseHookEvent(stdin, opts.cwd);
    const ctx = await openContext(ev.cwd, env);
    if (!ctx) return { ...OK };
    const key = keyOf(ev);
    const effect = applyTool(ev.tool_name ?? '', ev.tool_input, () => null);
    const rel =
      effect.kind === 'none' ? null : repoRelative(ctx.repoRoot, resolve(ev.cwd, effect.path ?? ''));
    const events: EventRecord[] = [];
    await withSession(ctx, key, 'post-write', async (prep) => {
      const s = prep.session;
      events.push(...prep.events);
      if (!rel) return null;
      addTouched(s, rel);
      const text = readWorktree(ctx.repoRoot, rel);
      const hash = sha256(text ?? '');
      const pending = s.pending_ask.find((p) => p.file === rel && p.proposed_sha256 === hash);
      if (!pending) {
        events.push(
          makeEvent(ctx, {
            hook: 'post-write',
            session_key: s.session_key,
            raw: ev.raw,
            target_rel: rel,
            decision: baseDecision({ outcome: 'allow', tier: 'none' }),
          }),
        );
        return null;
      }
      s.pending_ask = s.pending_ask.filter((p) => p !== pending);
      const now = ctx.now();
      const ev2 = makeEvent(ctx, {
        hook: 'post-write',
        session_key: s.session_key,
        raw: ev.raw,
        target_rel: rel,
        decision: baseDecision({ outcome: 'ask_approved', tier: 'match', order_id: pending.order_id }),
      });
      await ctx.store.grants.create({
        order_id: pending.order_id,
        kind: 'ask',
        session_key: s.session_key,
        granted_by: 'ask',
        at: now,
        origin: { via: 'ask', suspect: false, markers: [] },
      });
      await ctx.store.grants.recordUse(
        pending.order_id,
        s.session_key,
        { event_id: ev2.event_id, kind: 'write', at: isoAt(now) },
        [{ file: rel, sha256: hash }],
      );
      if (!s.grants_used.includes(pending.order_id)) s.grants_used.push(pending.order_id);
      events.push(ev2);
      return null;
    });
    await appendEvents(ctx, events);
    return { ...OK };
  });
}

/**
 * `dnr session shell-after --stdin` (PostToolUse on shell, §5.11): compare the tree taken at the
 * guard-shell PreToolUse with the tree now, and add every changed file to `touched`.
 */
export function runShellAfter(stdin: string, opts: HookOptions = {}): Promise<HookIO> {
  return failOpen('post-shell', stdin, opts, async () => {
    const env = opts.env ?? process.env;
    const ev = parseHookEvent(stdin, opts.cwd);
    const ctx = await openContext(ev.cwd, env);
    if (!ctx) return { ...OK };
    const key = keyOf(ev);
    const events: EventRecord[] = [];
    const io = await withSession(ctx, key, 'post-shell', async (prep): Promise<HookIO> => {
      const s = prep.session;
      events.push(...prep.events);
      const before = s.shell_snapshot ?? s.baseline_tree;
      const after = await snapshotTree(ctx.repoRoot);
      const changed = await treeDiffNames(ctx.repoRoot, before, after);
      const stateRel = repoRelative(ctx.repoRoot, ctx.store.paths.stateDir);
      for (const f of changed)
        if (!stateRel || !(f === stateRel || f.startsWith(`${stateRel}/`))) addTouched(s, f);
      s.shell_snapshot = null;
      const finding = await postShellCheck(ctx, s);
      const reduced = ctx.config.mode === 'warn-only' || ctx.config.mode === 'commit-enforce';
      const record = ctx.config.mode === 'record';
      const decision = finding
        ? baseDecision({
            outcome: record ? 'record' : reduced ? 'warn_block' : 'block',
            tier: 'match',
            order_id: finding.order.id,
            edit_score: finding.edit,
            fired_by: 'edit',
            breakdown: [
              {
                changed,
                post_shell: finding.kind,
                commit: finding.commit ?? null,
                qualnames: finding.qualnames,
              },
            ],
            reason_line: postShellReason(finding, reduced).split('\n')[0] ?? null,
          })
        : baseDecision({ outcome: 'allow', tier: 'none', breakdown: [{ changed }] });
      events.push(
        makeEvent(ctx, {
          hook: 'post-shell',
          session_key: s.session_key,
          raw: ev.raw,
          target_rel: null,
          decision,
        }),
      );
      if (!finding || record) return { ...OK };
      // PostToolUse: exit 2 sends stderr to the agent (provisional until spike S15).
      return { exitCode: 2, stdout: '', stderr: `${postShellReason(finding, reduced)}\n` };
    });
    await appendEvents(ctx, events);
    return io;
  });
}

/** `dnr session show`: the session for a session_id or this cwd's fallback key (or all sessions). */
export async function sessionShow(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionId?: string | null;
  all?: boolean;
}): Promise<Session[] | null> {
  const ctx = await openContext(input.cwd, input.env);
  if (!ctx) return null;
  if (input.all) return ctx.store.sessions.list();
  const key = keyOf({ session_id: input.sessionId ?? null, cwd: input.cwd } as never);
  const s = await ctx.store.sessions.get(key.key);
  return s ? [s] : [];
}

/** `dnr session end`: delete a session (from SessionEnd stdin, or the cwd fallback session). */
export async function sessionEnd(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionId?: string | null;
}): Promise<boolean> {
  const ctx = await openContext(input.cwd, input.env);
  if (!ctx) return false;
  const key = keyOf({ session_id: input.sessionId ?? null, cwd: input.cwd } as never);
  return ctx.store.sessions.delete(key.key);
}

/** `dnr session gc`: remove idle sessions and expired, unused grants. */
export async function sessionGc(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ sessions: number; grants: number }> {
  const ctx = await openContext(input.cwd, input.env);
  if (!ctx) return { sessions: 0, grants: 0 };
  const now = ctx.now();
  let n = 0;
  for (const s of await ctx.store.sessions.list()) {
    if (sessionIdle(s, ctx.config.session_ttl_minutes, now)) {
      await ctx.store.sessions.delete(s.session_key);
      n++;
    }
  }
  return { sessions: n, grants: await ctx.store.grants.gc(now) };
}
