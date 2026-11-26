/**
 * `dnr check --stdin --hook kiro`: the PreToolUse write hook (§5.4–5.8, §6).
 *
 * protect → match → warn → allow. A write to a file no approved order covers takes the fast
 * path: no grammar is loaded and nothing is parsed. Output follows `decision_format`: `deny`
 * exits 2 with the reason on stderr; `ask` exits 0 with `hookSpecificOutput` JSON on stdout.
 */
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyTool, isProtected, normalizePath, protectedGlobs } from '@dnr/core';
import type { Decision, EventRecord, Order } from '@dnr/schemas';
import { ASK_PENDING_TTL_MS, sha256 } from '@dnr/store';
import {
  addTouched,
  appendEvents,
  baseDecision,
  type HookContext,
  type HookIO,
  type HookOptions,
  isoAt,
  keyOf,
  makeEvent,
  OK,
  openContext,
  sessionPatch,
  withSession,
} from './context';
import { contributingQualnames, createState, decideWrite, filesOf, loadParser, UnitCache } from './engine';
import { parseHookEvent } from './event';
import { failOpen } from './failopen';
import { blockText, protectMessage, warnMessage } from './messages';
import { loadEntries } from './orders';
import { BlobReader, readWorktree, realpathLoose, repoRelative } from './repo';
import { coverageOf } from './trusted';

/**
 * The git hooks directory (`.git/hooks`, or `core.hooksPath`) without spawning git. Protected so an
 * agent cannot delete or edit the pre-commit shim (review M3; an addition to the §5.4 globs).
 */
export function gitHooksDirs(repoRoot: string): string[] {
  let gitDir = join(repoRoot, '.git');
  try {
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (m?.[1]) gitDir = resolve(repoRoot, m[1].trim());
    }
  } catch {}
  const out = [join(gitDir, 'hooks')];
  for (const cfg of [join(gitDir, 'config'), join(gitDir, 'commondir')]) {
    try {
      const m = /^\s*hooksPath\s*=\s*(.+)$/im.exec(readFileSync(cfg, 'utf8'));
      if (m?.[1]) out.push(resolve(repoRoot, m[1].trim().replace(/^~(?=\/)/, process.env.HOME ?? '~')));
    } catch {}
  }
  return out;
}

/** `.git` (or the worktree's gitdir) for the git-config protection (wave-2 H2). */
export function gitDirOf(repoRoot: string): string {
  const g = join(repoRoot, '.git');
  try {
    if (statSync(g).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'));
      if (m?.[1]) return resolve(repoRoot, m[1].trim());
    }
  } catch {}
  return g;
}

export function protectRoots(ctx: HookContext, env: NodeJS.ProcessEnv): string[] {
  const p = ctx.store.paths;
  const hooks = gitHooksDirs(ctx.repoRoot).map((d) => `${realpathLoose(d)}/**`);
  const gitDir = realpathLoose(gitDirOf(ctx.repoRoot));
  return [
    ...hooks,
    // Additions beyond §5.4 (wave-2 H2): git config can disable hooks or alias commands, and the
    // shipped steering tells the agent not to route around blocks.
    `${gitDir}/config`,
    `${gitDir}/config.worktree`,
    `${realpathLoose(ctx.repoRoot)}/.kiro/steering/dnr.md`,
    ...protectedGlobs({
      repoRoot: realpathLoose(ctx.repoRoot),
      home: env.HOME ? realpathLoose(env.HOME) : null,
      ordersDir: realpathLoose(p.ordersDir),
      stateDir: realpathLoose(p.stateDir),
      configFile: realpathLoose(p.configFile),
    }),
  ];
}

export function isProtectedPath(ctx: HookContext, env: NodeJS.ProcessEnv, absPath: string): boolean {
  return isProtected(realpathLoose(absPath), protectRoots(ctx, env));
}

/**
 * True when removing or replacing `absPath` would remove a protected path: the path is protected,
 * or it is a directory that contains one (`.kiro`, `.git`, `.dnr`, the repo root). Wave-2 H2.
 */
export function wouldRemoveProtected(ctx: HookContext, env: NodeJS.ProcessEnv, absPath: string): boolean {
  if (isProtectedPath(ctx, env, absPath)) return true;
  const fold = (s: string) => s.toLowerCase();
  const p = fold(normalizePath(realpathLoose(absPath)));
  for (const raw of protectRoots(ctx, env)) {
    const target = fold(normalizePath(raw.endsWith('/**') ? raw.slice(0, -3) : raw));
    if (target === p || target.startsWith(p === '/' ? '/' : `${p}/`)) return true;
  }
  return false;
}

/** Render a decision as hook output for the configured format (§6, §8 exit codes). */
export function renderDecision(
  ctx: HookContext,
  decision: Decision,
  order: Order | null,
  text: string,
): HookIO {
  const o = decision.outcome;
  const stops = o === 'block' || o === 'ask' || o === 'warn_block' || o === 'deny_protected';
  if (!stops) return { ...OK };
  if (ctx.config.decision_format === 'ask') {
    const permissionDecision = o === 'deny_protected' ? 'deny' : 'ask';
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ hookSpecificOutput: { permissionDecision, permissionDecisionReason: text } })}\n`,
      stderr: '',
    };
  }
  void order;
  return { exitCode: 2, stdout: '', stderr: `${text}\n` };
}

export function decideConfig(ctx: HookContext) {
  const c = ctx.config;
  const reduced = c.mode === 'warn-only' || c.mode === 'commit-enforce';
  return {
    threshold: c.threshold,
    side_min: c.side_min,
    min_order_weight: c.min_order_weight,
    prox_enabled: c.prox_enabled,
    prox_threshold: c.prox_threshold,
    fingerprint_floor: c.fingerprint_floor,
    decision_format: c.decision_format,
    mode: reduced ? ('warn-only' as const) : ('enforce' as const),
  };
}

export async function preWrite(stdin: string, opts: HookOptions = {}): Promise<HookIO> {
  const env = opts.env ?? process.env;
  const t0 = performance.now();
  const ev = parseHookEvent(stdin, opts.cwd);
  const ctx = await openContext(ev.cwd, env);
  if (!ctx) return { ...OK }; // not in a git repo: nothing to protect
  const tool = ev.tool_name ?? '';
  const record = ctx.config.mode === 'record';
  const key = keyOf(ev);

  const toAbs = (p: string) => resolve(ev.cwd, p);
  const relOf = (p: string) => repoRelative(ctx.repoRoot, toAbs(p));
  const effect = applyTool(tool, ev.tool_input, (p) => {
    const rel = relOf(p);
    return rel === null ? null : readWorktree(ctx.repoRoot, rel);
  });
  const rawPath = effect.kind === 'none' ? null : effect.path;
  const absTarget = rawPath ? toAbs(rawPath) : null;
  const deleting = effect.kind === 'write' && effect.text === null;
  const isProt = absTarget
    ? deleting
      ? wouldRemoveProtected(ctx, env, absTarget)
      : isProtectedPath(ctx, env, absTarget)
    : false;
  const coverage = coverageOf(ctx.trusted.orders, ctx.fold);
  const relRaw = rawPath ? relOf(rawPath) : null;
  // On a case-insensitive filesystem, use the spelling the orders use (wave-2 C2).
  const rel = relRaw && ctx.fold ? (canonicalSpelling(ctx.trusted.orders, relRaw) ?? relRaw) : relRaw;

  const events: EventRecord[] = [];
  const io = await withSession(ctx, key, 'pre-write', async (prep) => {
    const s = prep.session;
    events.push(...prep.events);
    const finish = (
      decision: Decision,
      extra: { proposed_text?: string | null; session_patch?: string | null } = {},
    ) => {
      decision.latency_ms = Math.max(0, performance.now() - t0);
      const shown = record
        ? {
            ...decision,
            outcome: 'record' as const,
            breakdown: [{ would: decision.outcome }, ...decision.breakdown],
          }
        : decision;
      events.push(
        makeEvent(ctx, {
          hook: 'pre-write',
          session_key: s.session_key,
          raw: ev.raw,
          target_rel: rel,
          decision: shown,
          ...extra,
        }),
      );
      return shown;
    };

    if (isProt && absTarget) {
      const d = baseDecision({
        outcome: 'deny_protected',
        tier: 'protect',
        reason_line: `DNR: ${rel ?? absTarget} is protected`,
        fast_path: true,
      });
      const shown = finish(d, record ? { proposed_text: effect.kind === 'write' ? effect.text : null } : {});
      return renderDecision(ctx, shown, null, protectMessage(rel ?? absTarget));
    }
    if (rel === null || effect.kind === 'none') {
      finish(baseDecision({ outcome: 'allow', tier: 'none', fast_path: true }));
      return { ...OK };
    }
    addTouched(s, rel);
    if (effect.kind === 'passthrough') {
      finish(
        baseDecision({
          outcome: 'allow',
          tier: 'none',
          fast_path: true,
          breakdown: [{ passthrough: effect.reason }],
        }),
      );
      return { ...OK };
    }

    // Fast path: no approved order covers the target (no grammar load, no parse).
    const covering = coverage.get(ctx.fold ? rel.toLowerCase() : rel) ?? [];
    if (covering.length === 0) {
      let extra = {};
      if (record) {
        const reader = new BlobReader(ctx.repoRoot);
        const base = await reader.read(s.baseline_tree, rel);
        const proposedText = effect.kind === 'write' ? effect.text : readWorktree(ctx.repoRoot, rel);
        extra = {
          proposed_text: proposedText,
          session_patch: sessionPatch(
            [rel],
            () => base,
            () => proposedText,
          ),
        };
      }
      finish(baseDecision({ outcome: 'allow', tier: 'none', fast_path: true }), extra);
      return { ...OK };
    }

    const parser = await loadParser();
    const cache = new UnitCache(parser);
    const reader = new BlobReader(ctx.repoRoot);
    const { entries, orders } = await loadEntries(ctx, covering, reader, cache);
    const files = [...new Set(orders.flatMap(filesOf))];
    await reader.prefetch(files.map((f) => `${s.baseline_tree}:${f}`));
    const baseline = createState((f) => reader.get(s.baseline_tree, f), cache);
    const current = createState((f) => readWorktree(ctx.repoRoot, f), cache);
    const grants = await ctx.store.grants.applying(s, ctx.now());
    const granted = new Set(grants.map((g) => g.order_id));
    const r = decideWrite({
      target: rel,
      effect,
      entries,
      baseline,
      current,
      cache,
      searchFiles: [...new Set([...s.touched, rel])],
      warned: s.warned,
      grantApplies: (id) => granted.has(id),
      config: decideConfig(ctx),
    });
    const d = r.decision;
    const order = orders.find((o) => o.id === d.order_id) ?? null;
    const recordText = ['block', 'warn_block', 'ask'].includes(d.outcome) || record;
    const extra = recordText
      ? {
          proposed_text: r.proposedText,
          session_patch: sessionPatch(
            order ? filesOf(order) : files,
            (f) => baseline.text(f),
            (f) => r.proposed.text(f),
          ),
        }
      : {};
    const shown = finish(d, extra);
    if (record) {
      if (r.effects.warn && !s.warned.includes(r.effects.warn)) s.warned.push(r.effects.warn);
      return { ...OK };
    }

    // Apply effects to the session (§5.4, §5.7).
    if (r.effects.warn && !s.warned.includes(r.effects.warn)) s.warned.push(r.effects.warn);
    const eventId = events[events.length - 1]?.event_id ?? '';
    for (const id of r.effects.grantsUsed) {
      if (!s.grants_used.includes(id)) s.grants_used.push(id);
      await ctx.store.grants.recordUse(
        id,
        s.session_key,
        { event_id: eventId, kind: 'write', at: isoAt(ctx.now()) },
        [{ file: rel, sha256: sha256(r.proposedText ?? '') }],
      );
    }
    if (d.outcome === 'ask' && order) {
      const now = ctx.now();
      s.pending_ask = s.pending_ask.filter((p) => p.file !== rel);
      s.pending_ask.push({
        order_id: order.id,
        file: rel,
        proposed_sha256: sha256(r.proposedText ?? ''),
        at: isoAt(now),
        expires_at: isoAt(now + ASK_PENDING_TTL_MS),
      });
    }
    let text = '';
    if (order && (shown.outcome === 'block' || shown.outcome === 'ask')) {
      text = blockText(order, shown, {
        qualnames: contributingQualnames(r, order.id),
        threshold: ctx.config.threshold,
        proxThreshold: ctx.config.prox_threshold,
      });
    } else if (order && shown.outcome === 'warn_block') {
      const downgraded = shown.fired_by !== null;
      text = warnMessage(order, shown, {
        qualnames: contributingQualnames(r, order.id),
        threshold: ctx.config.threshold,
        downgraded,
        file: rel,
      });
    }
    return renderDecision(ctx, shown, order, text);
  });
  await appendEvents(ctx, events);
  return io;
}

/** Entry point with fail-open. */
export function runPreWrite(stdin: string, opts: HookOptions = {}): Promise<HookIO> {
  return failOpen('pre-write', stdin, opts, () => preWrite(stdin, opts));
}

/** The spelling an effective order uses for `rel`, compared case-insensitively. */
export function canonicalSpelling(orders: Map<string, Order>, rel: string): string | null {
  const low = rel.toLowerCase();
  for (const o of orders.values()) for (const u of o.units) if (u.file.toLowerCase() === low) return u.file;
  return null;
}
