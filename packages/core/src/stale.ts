/**
 * Stale and re-landed orders (§5.9). Both are derived when an order loads, never stored.
 */
import type { Order } from '@dnr/schemas';
import { DEFAULT_MATCH_CONFIG } from './config';
import { diffTokens } from './diff';
import { relocateUnit } from './fingerprint';
import { type OrderMaterial, unitKey } from './material';
import { matchState, type OrderScore, type ScoreOptions } from './score';
import type { StateView } from './state';

export interface StaleReport {
  stale: boolean;
  /** Snapshot tokens that differ at HEAD, over all non-added units. */
  differing: number;
  total: number;
  /** `file\0qualname` of modified/removed units present in the snapshot, missing at HEAD and not relocated. */
  lost: string[];
  relocated: Array<{
    from: { file: string; qualname: string };
    to: { file: string; qualname: string };
    similarity: number;
  }>;
}

export interface StaleOptions {
  /** Needed to relocate a unit missing at HEAD (§5.16 load-time relocation). */
  material?: OrderMaterial;
  /** Files searched for relocations (product mode: files changed since the snapshot; trial: the seeded cache). */
  searchFiles?: readonly string[];
  fingerprintFloor?: number;
}

/**
 * An order is stale when more than half of the snapshot tokens differ at HEAD, or when a
 * `modified` or `removed` unit that exists in the post-revert snapshot is missing at HEAD and
 * cannot be relocated. `kind=added` units never make an order stale.
 */
export function staleReport(
  order: Order,
  snapshot: StateView,
  head: StateView,
  opts: StaleOptions = {},
): StaleReport {
  const floor = opts.fingerprintFloor ?? DEFAULT_MATCH_CONFIG.fingerprint_floor;
  const own = new Set(order.units.map((u) => unitKey(u.file, u.qualname)));
  let differing = 0;
  let total = 0;
  const lost: string[] = [];
  const relocated: StaleReport['relocated'] = [];
  for (const u of order.units) {
    if (u.kind === 'added') continue;
    const snap = snapshot.units(u.file)?.units.get(u.qualname);
    if (!snap) continue;
    total += snap.tokens.length;
    let headTokens = head.units(u.file)?.units.get(u.qualname)?.tokens;
    if (!headTokens) {
      const m = opts.material?.get(unitKey(u.file, u.qualname));
      const rel = m && opts.searchFiles ? relocateUnit(u, m, head, opts.searchFiles, floor, own) : null;
      if (!rel) {
        lost.push(unitKey(u.file, u.qualname));
        differing += snap.tokens.length;
        continue;
      }
      relocated.push({
        from: { file: u.file, qualname: u.qualname },
        to: { file: rel.file, qualname: rel.qualname },
        similarity: rel.similarity,
      });
      headTokens = rel.tokens;
    }
    differing += diffTokens(snap.tokens, headTokens).R.length;
  }
  const stale = lost.length > 0 || (total > 0 && differing / total > 0.5);
  return { stale, differing, total, lost, relocated };
}

export function isStale(
  order: Order,
  snapshot: StateView,
  head: StateView,
  opts: StaleOptions = {},
): boolean {
  return staleReport(order, snapshot, head, opts).stale;
}

/**
 * Re-landed (§5.9): match(HEAD) holds against the post-revert snapshot (or match(X^) in a scan).
 * A re-landed order only warns until it is re-approved.
 */
export function relandedScore(
  order: Order,
  snapshot: StateView,
  head: StateView,
  opts: ScoreOptions = {},
): OrderScore {
  return matchState(order, snapshot, head, opts);
}

export function isRelanded(
  order: Order,
  snapshot: StateView,
  head: StateView,
  opts: ScoreOptions = {},
): boolean {
  return relandedScore(order, snapshot, head, opts).matched;
}
