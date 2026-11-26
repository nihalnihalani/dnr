/**
 * Order scoring (§5.5 edit-overlap score, §5.6 state proximity, §5.16 relocation).
 *
 * Scope is always the whole order: `proposed` must be the full state (every file the order
 * touches) with the write applied, and `baseline` the session baseline (or, for the crossing
 * rule, the post-revert snapshot).
 */
import type { Order, OrderUnit } from '@dnr/schemas';
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from './config';
import { diffTokens } from './diff';
import { relocateUnit } from './fingerprint';
import { type OrderMaterial, unitKey } from './material';
import { intersectionWeight, jaccard, type Multiset, shingles3 } from './multiset';
import type { StateView } from './state';
import type { GrammarId } from './syntax';
import { weightOf } from './weights';

export type ProposedSource = 'present' | 'empty' | 'relocated' | 'missing';

export interface UnitScore {
  file: string;
  qualname: string;
  kind: OrderUnit['kind'];
  /** w(A), w(R) of the order unit. */
  wA: number;
  wR: number;
  /** w(A ∩ A′), w(R ∩ R′). */
  iA: number;
  iR: number;
  /**
   * Where the proposed unit came from: `present` (same file and qualname), `empty` (absent and
   * scored as `[]` per §5.5), `relocated` (found by the fingerprint index), `missing` (kind=modified,
   * absent and not relocated: the order can only warn).
   */
  proposed: ProposedSource;
  relocated_to: { file: string; qualname: string; similarity: number } | null;
  degraded: boolean;
  /** prox_u, or null when not computed. */
  prox: number | null;
}

export interface OrderScore {
  order_id: string;
  /** (w(A∩A′) + w(R∩R′)) / (w(A) + w(R)) over the whole order; 0 when the order has no weight. */
  edit: number;
  wA: number;
  wR: number;
  iA: number;
  iR: number;
  /** The two-sided rule holds (trivially when w(A) = 0 or w(R) = 0). */
  two_sided: boolean;
  /** w(A) + w(R) < min_order_weight: never reaches the match tier. */
  small: boolean;
  /** A proposed unit is parse-degraded. */
  degraded: boolean;
  /** A kind=modified unit is missing and was not relocated. */
  missing: boolean;
  /** Proximity score, or null (disabled, no material, or every unit removed). */
  prox: number | null;
  edit_fires: boolean;
  prox_fires: boolean;
  /** match(state): fires and is not capped by the small-order, degraded or missing rules. Stale is applied by the caller. */
  matched: boolean;
  fired_by: 'edit' | 'prox' | null;
  units: UnitScore[];
}

export interface ScoreOptions {
  config?: MatchConfig;
  /** C_u / PR_u per unit; needed for proximity and the fingerprint index. */
  material?: OrderMaterial;
  /** Files searched for relocated units (Session.touched plus files new relative to the baseline). */
  searchFiles?: readonly string[];
  /** Compute proximity even when `config.prox_enabled` is false (reporting/tuning). */
  computeProx?: boolean;
}

export function scoreOrder(
  order: Order,
  baseline: StateView,
  proposed: StateView,
  opts: ScoreOptions = {},
): OrderScore {
  const cfg = opts.config ?? DEFAULT_MATCH_CONFIG;
  const material = opts.material;
  const own = new Set(order.units.map((u) => unitKey(u.file, u.qualname)));
  const units: UnitScore[] = [];
  let wA = 0;
  let wR = 0;
  let iA = 0;
  let iR = 0;
  let degraded = false;
  let missing = false;
  const proxParts: Array<{ size: number; prox: number }> = [];
  const wantProx = (cfg.prox_enabled || opts.computeProx === true) && material !== undefined;

  for (const u of order.units) {
    const g = u.tokenizer.grammar;
    const baseFile = baseline.units(u.file);
    const baseUnit = baseFile?.units.get(u.qualname);
    const baseTokens = baseUnit?.tokens ?? [];
    const propFile = proposed.units(u.file);
    const propUnit = propFile?.units.get(u.qualname);
    let propTokens: string[] = [];
    let source: ProposedSource = 'present';
    let relocated: UnitScore['relocated_to'] = null;
    let unitDegraded = false;
    if (propUnit) {
      propTokens = propUnit.tokens;
      unitDegraded = propUnit.degraded;
    } else if (u.kind === 'removed') {
      source = 'empty';
    } else {
      const m = material?.get(unitKey(u.file, u.qualname));
      const rel =
        m && opts.searchFiles
          ? relocateUnit(u, m, proposed, opts.searchFiles, cfg.fingerprint_floor, own)
          : null;
      if (rel) {
        source = 'relocated';
        propTokens = rel.tokens;
        relocated = { file: rel.file, qualname: rel.qualname, similarity: rel.similarity };
        unitDegraded = proposed.units(rel.file)?.units.get(rel.qualname)?.degraded ?? false;
      } else if (u.kind === 'added') {
        source = 'empty';
      } else {
        source = 'missing';
      }
    }
    const d = diffTokens(baseTokens, propTokens);
    const uwA = weightOf(u.A, g);
    const uwR = weightOf(u.R, g);
    const uiA = intersectionWeight(u.A, d.A, g);
    const uiR = intersectionWeight(u.R, d.R, g);
    wA += uwA;
    wR += uwR;
    iA += uiA;
    iR += uiR;
    if (unitDegraded) degraded = true;
    if (source === 'missing') missing = true;

    let prox: number | null = null;
    if (wantProx && u.kind !== 'removed') {
      const m = material?.get(unitKey(u.file, u.qualname));
      if (m) {
        const candidates: string[][] = [];
        if (propUnit) candidates.push(propUnit.tokens);
        else if (source === 'relocated') candidates.push(propTokens);
        if (propFile) {
          for (const [q, pu] of propFile.units)
            if (q !== u.qualname && !baseFile?.units.has(q)) candidates.push(pu.tokens);
        }
        prox = proxUnit(m.C, u.kind === 'added' ? [] : m.PR, baseTokens, candidates, g);
        proxParts.push({ size: weightOf(m.C, g), prox });
      }
    }
    units.push({
      file: u.file,
      qualname: u.qualname,
      kind: u.kind,
      wA: uwA,
      wR: uwR,
      iA: uiA,
      iR: uiR,
      proposed: source,
      relocated_to: relocated,
      degraded: unitDegraded,
      prox,
    });
  }

  const total = wA + wR;
  const edit = total === 0 ? 0 : (iA + iR) / total;
  const two_sided = !(wA > 0 && wR > 0) || (iA / wA >= cfg.side_min && iR / wR >= cfg.side_min);
  const small = total < cfg.min_order_weight;
  let prox: number | null = null;
  if (wantProx) {
    const size = proxParts.reduce((s, p) => s + p.size, 0);
    prox = size === 0 ? null : proxParts.reduce((s, p) => s + p.size * p.prox, 0) / size;
  }
  const edit_fires = total > 0 && edit >= cfg.threshold && two_sided;
  const prox_fires = cfg.prox_enabled && prox !== null && prox >= cfg.prox_threshold;
  const capped = small || degraded || missing;
  const matched = !capped && (edit_fires || prox_fires);
  return {
    order_id: order.id,
    edit,
    wA,
    wR,
    iA,
    iR,
    two_sided,
    small,
    degraded,
    missing,
    prox,
    edit_fires,
    prox_fires,
    matched,
    fired_by: matched ? (edit_fires ? 'edit' : 'prox') : null,
    units,
  };
}

/**
 * prox_u (§5.6) for one order unit: the maximum over `candidates` of
 * max(0, (n⁺(x) − n⁺(baseline)) / (1 − n⁺(baseline))). Never negative (P17).
 */
export function proxUnit(
  C: readonly string[],
  PR: readonly string[],
  baseline: readonly string[],
  candidates: ReadonlyArray<readonly string[]>,
  grammar: GrammarId,
): number {
  const sC = shingles3(C, grammar);
  if (sC.size === 0) return 0; // fewer than 3 weight-1 tokens
  const sPR = shingles3(PR, grammar);
  const jCPR = jaccard(sC, sPR);
  if (jCPR >= 1) return 0; // C changed only weight-0 tokens
  const denom = 1 - jCPR;
  const nPlus = (x: Multiset) => Math.max(0, (jaccard(x, sC) - jaccard(x, sPR)) / denom);
  const nb = nPlus(shingles3(baseline, grammar));
  if (1 - nb <= 0) return 0;
  let best = 0;
  for (const c of candidates) {
    const v = Math.max(0, (nPlus(shingles3(c, grammar)) - nb) / (1 - nb));
    if (v > best) best = v;
  }
  return best;
}

/**
 * match(state) for the crossing rule (§5.5): score `state` against the post-revert snapshot.
 */
export function matchState(
  order: Order,
  snapshot: StateView,
  state: StateView,
  opts: ScoreOptions = {},
): OrderScore {
  return scoreOrder(order, snapshot, state, opts);
}

/**
 * Crossing (§5.5): match(next) holds and match(parent) does not. `dnr check --staged/--commit`
 * block only on a crossing.
 */
export function isCrossing(
  order: Order,
  snapshot: StateView,
  parent: StateView,
  next: StateView,
  opts: ScoreOptions = {},
): { crossing: boolean; parent: OrderScore; next: OrderScore } {
  const p = matchState(order, snapshot, parent, opts);
  const n = matchState(order, snapshot, next, opts);
  return { crossing: n.matched && !p.matched, parent: p, next: n };
}
