/**
 * The hook's use of the match engine: parser loading, load-time derivation of stale and
 * re-landed (§5.9, cached by HEAD text), and a pure decision over in-memory states.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyTool,
  createState,
  type DecideConfig,
  type DecideResult,
  decide,
  isRelanded,
  type OrderEntry,
  overlayState,
  type StateView,
  staleReport,
  type ToolEffect,
  UnitCache,
} from '@dnr/core';
import type { GrammarSet } from '@dnr/grammar';
import type { DnrConfig, Order } from '@dnr/schemas';
import { writeJsonAtomic } from '@dnr/store';

let parserPromise: Promise<GrammarSet> | null = null;

/** Load the grammars once per process (only on the match path: the fast path never calls this). */
export function loadParser(): Promise<GrammarSet> {
  if (!parserPromise) parserPromise = import('@dnr/grammar/node').then((m) => m.loadGrammarsNode());
  return parserPromise;
}

export function filesOf(order: Order): string[] {
  return [...new Set(order.units.map((u) => u.file))].sort();
}

export type EffectiveStatus = 'draft' | 'approved' | 'retired' | 'stale' | 'relanded' | 'violated';

export interface Derived {
  stale: boolean;
  relanded: boolean;
}

/**
 * Stale and re-landed for one order, from snapshot and HEAD texts (§5.9). Never written back to
 * the order; cached in `<cache>/derived.json` keyed by the order content and the HEAD texts.
 */
export function deriveStatus(
  order: Order,
  snapshotText: (f: string) => string | null,
  headText: (f: string) => string | null,
  cache: UnitCache,
  config: Pick<
    DnrConfig,
    'threshold' | 'side_min' | 'min_order_weight' | 'prox_enabled' | 'prox_threshold' | 'fingerprint_floor'
  >,
  cacheDir?: string | null,
): Derived {
  const files = filesOf(order);
  const key = createHash('sha256')
    .update(JSON.stringify(order))
    .update(JSON.stringify(config))
    .update(JSON.stringify(files.map((f) => headText(f))))
    .digest('hex');
  const file = cacheDir ? join(cacheDir, 'derived.json') : null;
  let store: Record<string, Derived & { id: string }> = {};
  if (file) {
    try {
      store = JSON.parse(readFileSync(file, 'utf8'));
      const hit = store[key];
      if (hit) return { stale: hit.stale, relanded: hit.relanded };
    } catch {}
  }
  const snap = createState(snapshotText, cache);
  const head = createState(headText, cache);
  const stale = staleReport(order, snap, head, { fingerprintFloor: config.fingerprint_floor }).stale;
  const relanded = !stale && isRelanded(order, snap, head, { config });
  if (file) {
    // Keep the cache small: one entry per order id.
    for (const [k, v] of Object.entries(store)) if (v.id === order.id) delete store[k];
    store[key] = { id: order.id, stale, relanded };
    writeJsonAtomic(file, store).catch(() => {});
  }
  return { stale, relanded };
}

export function effectiveStatus(order: Order, d: Derived | null, violated = false): EffectiveStatus {
  if (order.status !== 'approved' || !d) return order.status;
  if (d.stale) return 'stale';
  if (d.relanded && violated) return 'violated';
  if (d.relanded) return 'relanded';
  return 'approved';
}

export interface WriteInput {
  target: string;
  effect: ToolEffect;
  entries: OrderEntry[];
  baseline: StateView;
  current: StateView;
  cache: UnitCache;
  searchFiles: readonly string[];
  warned: Iterable<string>;
  grantApplies: (id: string) => boolean;
  config: Partial<DecideConfig>;
  protected?: boolean;
}

export interface WriteResult extends DecideResult {
  proposed: StateView;
  proposedText: string | null;
}

/** Decide one write over in-memory states (used by pre-write, replay and `check --file`). */
export function decideWrite(input: WriteInput): WriteResult {
  const eff = input.effect;
  const overrides = new Map<string, string | null>();
  let proposedText: string | null = input.current.text(input.target);
  if (eff.kind === 'write') {
    overrides.set(input.target, eff.text);
    proposedText = eff.text;
  }
  const proposed = overlayState(input.current, overrides, input.cache);
  const r = decide({
    target: input.target,
    protected: !!input.protected,
    unknownTool: eff.kind === 'unknown',
    orders: input.entries,
    baseline: input.baseline,
    current: input.current,
    proposed,
    searchFiles: input.searchFiles,
    warned: input.warned,
    grantApplies: input.grantApplies,
    config: input.config,
  });
  return { ...r, proposed, proposedText };
}

export { applyTool, createState, UnitCache };

/** Qualnames of the order units that contributed to a score (for the stderr text). */
export function contributingQualnames(r: DecideResult, orderId: string | null): string[] {
  const s = r.scores.find((x) => x.order_id === orderId);
  if (!s) return [];
  const q = s.units.filter((u) => u.iA + u.iR > 0).map((u) => u.qualname);
  return [...new Set(q.length ? q : s.units.map((u) => u.qualname))];
}
