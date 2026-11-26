/**
 * Weighted multisets (§5.5): counts with repeats, weights from the grammar's weight-0 set.
 */
import type { GrammarId } from './syntax';
import { weightSet } from './weights';

export type Multiset = Map<string, number>;

export function multiset(items: Iterable<string>): Multiset {
  const m: Multiset = new Map();
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

/** w(X ∩ Y): Σ over keys of min(count) × weight. */
export function intersectionWeight(x: readonly string[], y: readonly string[], grammar: GrammarId): number {
  if (x.length === 0 || y.length === 0) return 0;
  const w0 = weightSet(grammar);
  const my = multiset(y);
  let total = 0;
  for (const [k, c] of multiset(x)) {
    if (w0.has(k)) continue;
    total += Math.min(c, my.get(k) ?? 0);
  }
  return total;
}

/** Weighted multiset Jaccard: Σ min / Σ max. Defined as 0 when both are empty. */
export function jaccard(x: Multiset, y: Multiset): number {
  let num = 0;
  let den = 0;
  for (const [k, cx] of x) {
    const cy = y.get(k) ?? 0;
    num += Math.min(cx, cy);
    den += Math.max(cx, cy);
  }
  for (const [k, cy] of y) if (!x.has(k)) den += cy;
  return den === 0 ? 0 : num / den;
}

/** S3(x): multiset of 3-token shingles built from weight-1 tokens only (§5.6). */
export function shingles3(tokens: readonly string[], grammar: GrammarId): Multiset {
  const w0 = weightSet(grammar);
  const t = tokens.filter((k) => !w0.has(k));
  const m: Multiset = new Map();
  for (let i = 0; i + 2 < t.length; i++) {
    const key = `${t[i]}\u0000${t[i + 1]}\u0000${t[i + 2]}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}
