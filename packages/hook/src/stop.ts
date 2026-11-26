/**
 * `dnr check --worktree --hook stop --max-forced-turns N`: the Stop backstop (§5.11).
 *
 * 1. Tamper check first, in every mode (wave-2 C1/H1): an invalid or edited config, an order set
 *    changed outside a guarded `dnr` command, a session rebuilt after it was corrupted or deleted,
 *    or a grant flagged `suspect` forces one reporting turn per distinct finding. Tamper reports
 *    do not use up the forced-turn cap.
 * 2. Then the re-application check: only files the agent touched (pre-write targets plus files
 *    changed across shell calls) are scored, baseline_tree vs the working tree; untouched files keep
 *    their baseline text, so a human's edits between turns are never forced back. Orders whose
 *    grant applies are skipped. At most N turns are forced (1 in warn-only and commit-enforce).
 * Always exits 0, including on a crash (an exit 1 would force a turn).
 */
import { createHash } from 'node:crypto';
import { scoreOrder } from '@dnr/core';
import { headCommit, revList } from '@dnr/git';
import type { EventRecord, Grant, Order, Session } from '@dnr/schemas';
import { checkCommit } from './commit';
import {
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
  withSession,
} from './context';
import { createState, filesOf, loadParser, UnitCache } from './engine';
import { parseHookEvent } from './event';
import { failOpen } from './failopen';
import { installMismatch } from './install';
import { stopReason, tamperReason } from './messages';
import { loadEntries } from './orders';
import { BlobReader, readWorktree } from './repo';
import { readSessionOrders, readTamper } from './trusted';
import { readViolations, recordViolation } from './violations';

export interface TouchedMatch {
  order: Order;
  qualnames: string[];
  edit: number;
}

/**
 * Score the approved, ungranted orders over the files the agent touched (baseline vs worktree,
 * untouched files at their baseline text). Shared by Stop and post-shell (wave-2 H3).
 */
export async function scoreTouched(
  ctx: HookContext,
  s: Session,
  granted: Set<string>,
): Promise<TouchedMatch | null> {
  const touched = new Set(s.touched.map((f) => (ctx.fold ? f.toLowerCase() : f)));
  const has = (f: string) => touched.has(ctx.fold ? f.toLowerCase() : f);
  const ids = [...ctx.trusted.orders.values()]
    .filter((o) => o.status === 'approved' && !granted.has(o.id) && filesOf(o).some(has))
    .map((o) => o.id);
  if (ids.length === 0) return null;
  const parser = await loadParser();
  const cache = new UnitCache(parser);
  const reader = new BlobReader(ctx.repoRoot);
  const { entries } = await loadEntries(ctx, ids, reader, cache);
  const files = [...new Set(entries.flatMap((e) => filesOf(e.order)))];
  await reader.prefetch(files.map((f) => `${s.baseline_tree}:${f}`));
  const baseText = (f: string) => reader.get(s.baseline_tree, f);
  const baseline = createState(baseText, cache);
  const state = createState((f) => (has(f) ? readWorktree(ctx.repoRoot, f) : baseText(f)), cache);
  for (const e of entries) {
    if (e.stale || e.relanded) continue;
    const sc = scoreOrder(e.order, baseline, state, { config: ctx.config, searchFiles: s.touched });
    if (sc.matched) {
      const q = sc.units.filter((u) => u.iA + u.iR > 0).map((u) => u.qualname);
      return { order: e.order, qualnames: [...new Set(q)], edit: sc.edit };
    }
  }
  return null;
}

/** Tamper findings for this session (wave-2 C1, H1, C3). */
export function tamperFindings(ctx: HookContext, s: Session, grants: Grant[]): string[] {
  const out: string[] = [];
  if (ctx.trusted.configIssue) out.push(`DNR config: ${ctx.trusted.configIssue}.`);
  const hash = ctx.store.ordersHash();
  if (s.orders_hash.startsWith('rebuilt:'))
    out.push(`The DNR session file was ${s.orders_hash.slice(8)} and was rebuilt from the committed tree.`);
  else if (s.orders_hash !== hash)
    out.push(
      'The DNR order set, config or hook files changed during this session outside a guarded `dnr` command.',
    );
  for (const g of grants)
    if (g.origin?.suspect && !g.origin.confirmed_at)
      out.push(
        `The grant for ${g.order_id} is suspect (${g.origin.markers.join(', ') || 'agent markers'}): DNR cannot tell whether a human or an agent made it, so it does not apply until a human confirms it with \`dnr allow --confirm ${g.order_id}\`.`,
      );
  // Wave-3 N2: the bundle recorded at `dnr init` must be unchanged.
  const mismatch = installMismatch(ctx.repoRoot, ctx.store.paths.stateDir);
  if (mismatch) out.push(`DNR's installation was modified: ${mismatch}.`);
  if (ctx.trusted.gitBroken)
    out.push(
      `The git repository is unusable (${ctx.trusted.gitBroken}); DNR blocks writes to protected code until it is repaired.`,
    );
  // Wave-3 N1/N3: the persistent tamper flag (open until a human runs `dnr tamper accept`).
  for (const f of readTamper(ctx.store.paths.stateDir)?.findings ?? [])
    out.push(
      `Open tamper finding (${f.at}): ${f.what}; DNR keeps enforcing until a human runs \`dnr tamper accept\`.`,
    );
  // Wave-3 N4: violated orders are reported every session.
  for (const [id, v] of Object.entries(readViolations(ctx.store.paths.stateDir)))
    if (ctx.trusted.orders.get(id)?.status === 'approved')
      out.push(
        `Order ${id} is violated: commit ${v.commit.slice(0, 10)} re-applied it during an agent session without a human's approval. Revert it, and tell the user.`,
      );
  return out;
}

/** Commits made since the session started that cross an order without a grant are violations. */
async function scanSessionCommits(ctx: HookContext, s: Session): Promise<void> {
  try {
    const start = readSessionOrders(ctx.store.paths.stateDir, s.session_key).head;
    const head = await headCommit(ctx.repoRoot);
    if (!start || !head || start === head) return;
    const granted = new Set((await ctx.store.grants.applying(s, ctx.now())).map((g) => g.order_id));
    for (const sha of (await revList(ctx.repoRoot, `${start}..${head}`)).slice(0, 50)) {
      for (const f of await checkCommit(ctx, sha))
        if (f.crossing && !granted.has(f.order_id))
          recordViolation(ctx.store.paths.stateDir, f.order_id, {
            commit: sha,
            at: new Date(ctx.now()).toISOString(),
            session_key: s.session_key,
          });
    }
  } catch {}
}

export function runStop(
  stdin: string,
  opts: HookOptions & { maxForcedTurns?: number } = {},
): Promise<HookIO> {
  return failOpen('stop', stdin, opts, async () => {
    const env = opts.env ?? process.env;
    const ev = parseHookEvent(stdin, opts.cwd);
    const ctx = await openContext(ev.cwd, env, keyOf(ev).key);
    if (!ctx) return { ...OK };
    const key = keyOf(ev);
    const mode = ctx.config.mode;
    const reduced = mode === 'warn-only' || mode === 'commit-enforce';
    const maxTurns = reduced ? 1 : (opts.maxForcedTurns ?? ctx.config.stop_max_forced_turns);
    const events: EventRecord[] = [];
    const io = await withSession(ctx, key, 'stop', async (prep) => {
      const s = prep.session;
      events.push(...prep.events);
      const log = (d: ReturnType<typeof baseDecision>) =>
        events.push(
          makeEvent(ctx, {
            hook: 'stop',
            session_key: s.session_key,
            raw: ev.raw,
            target_rel: null,
            decision: d,
          }),
        );
      const block = (reason: string): HookIO => ({
        exitCode: 0,
        stdout: `${JSON.stringify({ decision: 'block', reason })}\n`,
        stderr: '',
      });

      // Wave-3 N4: a re-application committed during this session without a grant violates the order.
      await scanSessionCommits(ctx, s);

      // 1. Tamper check: every mode, once per distinct finding, outside the forced-turn cap.
      const grants = await ctx.store.grants.list().catch(() => [] as Grant[]);
      const mine = grants.filter((g) => g.session_key === s.session_key);
      const sigOf = (f: string) => `tamper:${createHash('sha256').update(f).digest('hex').slice(0, 16)}`;
      const fresh = tamperFindings(ctx, s, mine).filter((f) => !s.warned.includes(sigOf(f)));
      if (fresh.length) {
        for (const f of fresh) s.warned.push(sigOf(f));
        s.orders_hash = ctx.store.ordersHash(); // each finding is reported once
        log(baseDecision({ outcome: 'block', tier: 'protect', breakdown: [{ tamper: fresh }] }));
        return block(tamperReason(fresh));
      }

      // 2. Re-application check.
      if (s.stop_forced_turns >= maxTurns) {
        log(baseDecision({ outcome: 'allow', tier: 'none', breakdown: [{ capped: s.stop_forced_turns }] }));
        return { ...OK };
      }
      const now = ctx.now();
      const granted = new Set(
        (await ctx.store.grants.applying(s, now).catch(() => [] as Grant[])).map((g) => g.order_id),
      );
      const hit = await scoreTouched(ctx, s, granted);
      if (!hit) {
        log(baseDecision({ outcome: 'allow', tier: 'none' }));
        return { ...OK };
      }
      const d = baseDecision({
        outcome: reduced ? 'warn_block' : 'block',
        tier: 'match',
        order_id: hit.order.id,
        edit_score: hit.edit,
        fired_by: 'edit',
        breakdown: [{ qualnames: hit.qualnames, forced_turn: s.stop_forced_turns + 1, at: isoAt(now) }],
      });
      const reason = stopReason(hit.order, hit.qualnames, reduced);
      if (mode === 'record') {
        log({ ...d, outcome: 'record', breakdown: [{ would: d.outcome, reason }, ...d.breakdown] });
        return { ...OK };
      }
      s.stop_forced_turns += 1;
      log(d);
      return block(reason);
    });
    await appendEvents(ctx, events);
    return io;
  });
}
