/**
 * Session-less checks: `dnr check --staged` (pre-commit), `--commit <sha>`, `--worktree` and
 * `--file <rel> --proposed <path>` (§5.5 crossing rule, §5.7 blob-matched grants).
 */
import { readFileSync } from 'node:fs';
import { applyTool, isCrossing, type OrderEntry, type OrderScore } from '@dnr/core';
import { headCommit, parents, stagedPaths } from '@dnr/git';
import type { Decision, Order } from '@dnr/schemas';
import { sha256 } from '@dnr/store';
import { appendEvents, baseDecision, type HookContext, keyOf, makeEvent } from './context';
import {
  contributingQualnames,
  createState,
  decideWrite,
  deriveStatus,
  filesOf,
  loadParser,
  UnitCache,
} from './engine';
import { decideConfig } from './prewrite';
import { BlobReader, readWorktree } from './repo';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface CrossingFinding {
  order_id: string;
  crossing: boolean;
  /** match(parent) held: the re-application is already in history (§5.9). */
  relanded: boolean;
  stale: boolean;
  edit: number;
  parent_edit: number;
  qualnames: string[];
  /** A used grant covers every staged blob (pre-commit only). */
  granted: boolean;
}

function qualnamesOf(s: OrderScore): string[] {
  const q = s.units.filter((u) => u.iA + u.iR > 0).map((u) => u.qualname);
  return [...new Set(q)];
}

/**
 * Crossing check of every approved order between a parent state and a next state, both given
 * as git revs (`HEAD`, `<sha>`, or `:` for the index) or `worktree`.
 */
export async function crossingCheck(
  ctx: HookContext,
  parentRev: string,
  nextRev: string | 'worktree',
  opts: { orders?: Order[]; searchFiles?: string[]; staleRev?: string } = {},
): Promise<CrossingFinding[]> {
  const orders = (opts.orders ?? (await ctx.store.orders.list())).filter((o) => o.status === 'approved');
  if (orders.length === 0) return [];
  const parser = await loadParser();
  const cache = new UnitCache(parser);
  const reader = new BlobReader(ctx.repoRoot);
  const specOf = (rev: string, f: string) => (rev === ':' ? `:${f}` : `${rev}:${f}`);
  const getRev = (rev: string, f: string) => (rev === ':' ? reader.get('', f) : reader.get(rev, f));
  const staleRev = opts.staleRev ?? parentRev;
  const specs: string[] = [];
  for (const o of orders)
    for (const f of filesOf(o)) {
      specs.push(`${o.snapshot_sha}:${f}`, specOf(parentRev, f), specOf(staleRev, f));
      if (nextRev !== 'worktree') specs.push(specOf(nextRev, f));
    }
  await reader.prefetch(specs);
  const out: CrossingFinding[] = [];
  for (const o of orders) {
    const snap = createState((f) => reader.get(o.snapshot_sha, f), cache);
    const parent = createState((f) => getRev(parentRev, f), cache);
    const next = createState(
      (f) => (nextRev === 'worktree' ? readWorktree(ctx.repoRoot, f) : getRev(nextRev, f)),
      cache,
    );
    const d = deriveStatus(
      o,
      (f) => reader.get(o.snapshot_sha, f),
      (f) => getRev(staleRev, f),
      cache,
      ctx.config,
      null,
    );
    const r = isCrossing(o, snap, parent, next, { config: ctx.config, searchFiles: opts.searchFiles ?? [] });
    out.push({
      order_id: o.id,
      crossing: r.crossing && !d.stale,
      relanded: r.parent.matched,
      stale: d.stale,
      edit: r.next.edit,
      parent_edit: r.parent.edit,
      qualnames: qualnamesOf(r.next),
      granted: false,
    });
  }
  return out;
}

/** `dnr check --staged`: HEAD vs the index; a crossing is allowed when a used grant covers its staged blobs. */
export async function checkStaged(ctx: HookContext): Promise<CrossingFinding[]> {
  const head = (await headCommit(ctx.repoRoot)) ?? EMPTY_TREE;
  const staged = await stagedPaths(ctx.repoRoot);
  const orders = await ctx.store.orders.list();
  const findings = await crossingCheck(ctx, head, ':', { orders, searchFiles: staged });
  const reader = new BlobReader(ctx.repoRoot);
  const events = [];
  for (const f of findings) {
    if (!f.crossing) continue;
    const order = orders.find((o) => o.id === f.order_id) as Order;
    const files = filesOf(order).filter((x) => staged.includes(x));
    await reader.prefetch(files.map((x) => `:${x}`));
    const blobs = files.map((x) => ({ file: x, sha256: sha256(reader.get('', x) ?? '') }));
    const g = await ctx.store.grants.commitGrant(order.id, blobs);
    const decision = baseDecision({
      outcome: g ? 'allow_grant' : ctx.config.mode === 'record' ? 'record' : 'block',
      tier: 'match',
      order_id: order.id,
      edit_score: f.edit,
      fired_by: 'edit',
      breakdown: [{ crossing: true, parent_edit: f.parent_edit, qualnames: f.qualnames }],
    });
    const ev = makeEvent(ctx, {
      hook: 'pre-commit',
      session_key: g?.session_key ?? null,
      raw: null,
      target_rel: null,
      decision,
    });
    if (g) {
      f.granted = true;
      await ctx.store.grants.recordUse(
        order.id,
        g.session_key,
        { event_id: ev.event_id, kind: 'commit' },
        blobs,
      );
    }
    events.push(ev);
  }
  await appendEvents(ctx, events);
  return findings;
}

/** `dnr check --commit <sha>`: X^ vs X (stale and re-landed measured at X^). */
export async function checkCommit(ctx: HookContext, sha: string): Promise<CrossingFinding[]> {
  const ps = await parents(ctx.repoRoot, sha);
  const parent = ps[0] ?? EMPTY_TREE;
  return crossingCheck(ctx, parent, sha, { staleRev: parent });
}

/** `dnr check --worktree` without `--hook stop`: HEAD vs the working tree. */
export async function checkWorktree(ctx: HookContext): Promise<CrossingFinding[]> {
  const head = (await headCommit(ctx.repoRoot)) ?? EMPTY_TREE;
  return crossingCheck(ctx, head, 'worktree');
}

/**
 * `dnr check --file <rel> --proposed <path>`: decide a write of `proposed` to `rel` with the
 * full tier logic. The baseline is this cwd's fallback session baseline when one exists, else
 * HEAD; the session state is the working tree.
 */
export async function checkFile(
  ctx: HookContext,
  rel: string,
  proposedPath: string,
  cwd: string,
): Promise<{ decision: Decision; order: Order | null; qualnames: string[] }> {
  const proposedText = readFileSync(proposedPath, 'utf8');
  const session = await ctx.store.sessions.get(keyOf({ session_id: null, cwd } as never).key);
  const baseRev = session?.baseline_tree ?? (await headCommit(ctx.repoRoot)) ?? EMPTY_TREE;
  const parser = await loadParser();
  const cache = new UnitCache(parser);
  const reader = new BlobReader(ctx.repoRoot);
  const orders = (await ctx.store.orders.list()).filter((o) => o.status === 'approved');
  const specs: string[] = [];
  for (const o of orders)
    for (const f of filesOf(o)) specs.push(`${o.snapshot_sha}:${f}`, `HEAD:${f}`, `${baseRev}:${f}`);
  await reader.prefetch(specs);
  const entries: OrderEntry[] = orders.map((order) => ({
    order,
    ...deriveStatus(
      order,
      (f) => reader.get(order.snapshot_sha, f),
      (f) => reader.get('HEAD', f),
      cache,
      ctx.config,
      ctx.store.paths.cacheDir,
    ),
  }));
  const r = decideWrite({
    target: rel,
    effect: applyTool('fs_write', { path: rel, content: proposedText }, () => null),
    entries,
    baseline: createState((f) => reader.get(baseRev, f), cache),
    current: createState((f) => readWorktree(ctx.repoRoot, f), cache),
    cache,
    searchFiles: [rel],
    warned: session?.warned ?? [],
    grantApplies: () => false,
    config: decideConfig(ctx),
  });
  const order = orders.find((o) => o.id === r.decision.order_id) ?? null;
  return { decision: r.decision, order, qualnames: contributingQualnames(r, r.decision.order_id) };
}
