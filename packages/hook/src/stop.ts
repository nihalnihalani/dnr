/**
 * `dnr check --worktree --hook stop --max-forced-turns N`: the Stop backstop (§5.11).
 *
 * Scores only files the agent touched (pre-write targets plus files changed across shell calls),
 * comparing `baseline_tree` with the working tree; files the agent did not touch keep their
 * baseline text, so a human's edits between turns are never forced back. Orders whose grant
 * applies are skipped. At most N turns are forced per session (1 in warn-only and
 * commit-enforce). A changed order set (orders, config, DNR hook files) forces a reporting turn.
 * Always exits 0, including on a crash (an exit 1 would force a turn).
 */
import { scoreOrder } from '@dnr/core';
import type { EventRecord, Order } from '@dnr/schemas';
import {
  appendEvents,
  baseDecision,
  type HookIO,
  type HookOptions,
  isoAt,
  keyOf,
  makeEvent,
  OK,
  openContext,
  prepareSession,
} from './context';
import { createState, filesOf, loadParser, UnitCache } from './engine';
import { parseHookEvent } from './event';
import { failOpen } from './failopen';
import { ordersChangedReason, stopReason } from './messages';
import { loadEntries } from './orders';
import { BlobReader, readWorktree } from './repo';

export function runStop(
  stdin: string,
  opts: HookOptions & { maxForcedTurns?: number } = {},
): Promise<HookIO> {
  return failOpen('stop', stdin, opts, async () => {
    const env = opts.env ?? process.env;
    const ev = parseHookEvent(stdin, opts.cwd);
    const ctx = await openContext(ev.cwd, env);
    if (!ctx) return { ...OK };
    const key = keyOf(ev);
    const mode = ctx.config.mode;
    const reduced = mode === 'warn-only' || mode === 'commit-enforce';
    const maxTurns = reduced ? 1 : (opts.maxForcedTurns ?? ctx.config.stop_max_forced_turns);
    const events: EventRecord[] = [];
    const io = await ctx.store.sessions.with(key.key, async (cur) => {
      const prep = await prepareSession(ctx, key, cur, 'stop');
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
      const force = (reason: string, d: ReturnType<typeof baseDecision>): HookIO => {
        if (mode === 'record') {
          log({ ...d, outcome: 'record', breakdown: [{ would: d.outcome, reason }, ...d.breakdown] });
          return { ...OK };
        }
        s.stop_forced_turns += 1;
        log(d);
        return { exitCode: 0, stdout: `${JSON.stringify({ decision: 'block', reason })}\n`, stderr: '' };
      };
      if (s.stop_forced_turns >= maxTurns) {
        log(baseDecision({ outcome: 'allow', tier: 'none', breakdown: [{ capped: s.stop_forced_turns }] }));
        return { session: s, result: { ...OK } };
      }
      const hash = ctx.store.ordersHash();
      if (hash !== s.orders_hash) {
        s.orders_hash = hash; // report once
        return {
          session: s,
          result: force(
            ordersChangedReason(),
            baseDecision({ outcome: 'block', tier: 'protect', breakdown: [{ orders_hash_changed: true }] }),
          ),
        };
      }
      const grants = await ctx.store.grants.applying(s, ctx.now());
      const granted = new Set(grants.map((g) => g.order_id));
      const touched = new Set(s.touched);
      const all = await ctx.store.orders.list();
      const ids = all
        .filter(
          (o) => o.status === 'approved' && !granted.has(o.id) && filesOf(o).some((f) => touched.has(f)),
        )
        .map((o) => o.id);
      if (ids.length === 0) {
        log(baseDecision({ outcome: 'allow', tier: 'none' }));
        return { session: s, result: { ...OK } };
      }
      const parser = await loadParser();
      const cache = new UnitCache(parser);
      const reader = new BlobReader(ctx.repoRoot);
      const { entries } = await loadEntries(ctx, ids, reader, cache);
      const files = [...new Set(entries.flatMap((e) => filesOf(e.order)))];
      await reader.prefetch(files.map((f) => `${s.baseline_tree}:${f}`));
      const baseText = (f: string) => reader.get(s.baseline_tree, f);
      const baseline = createState(baseText, cache);
      const state = createState((f) => (touched.has(f) ? readWorktree(ctx.repoRoot, f) : baseText(f)), cache);
      let hit: { order: Order; qualnames: string[]; edit: number } | null = null;
      for (const e of entries) {
        if (e.stale || e.relanded) continue;
        const sc = scoreOrder(e.order, baseline, state, { config: ctx.config, searchFiles: [...touched] });
        if (sc.matched) {
          const q = sc.units.filter((u) => u.iA + u.iR > 0).map((u) => u.qualname);
          hit = { order: e.order, qualnames: [...new Set(q)], edit: sc.edit };
          break;
        }
      }
      if (!hit) {
        log(baseDecision({ outcome: 'allow', tier: 'none' }));
        return { session: s, result: { ...OK } };
      }
      const d = baseDecision({
        outcome: reduced ? 'warn_block' : 'block',
        tier: 'match',
        order_id: hit.order.id,
        edit_score: hit.edit,
        fired_by: 'edit',
        breakdown: [{ qualnames: hit.qualnames, forced_turn: s.stop_forced_turns + 1, at: isoAt(ctx.now()) }],
      });
      return { session: s, result: force(stopReason(hit.order, hit.qualnames, reduced), d) };
    });
    await appendEvents(ctx, events);
    return io;
  });
}
