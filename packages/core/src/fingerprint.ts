/**
 * Fingerprint index lookup (§5.16): find where a missing order unit went (move or rename).
 */
import type { OrderUnit } from '@dnr/schemas';
import { type UnitMaterial, unitKey } from './material';
import { jaccard, shingles3 } from './multiset';
import type { StateView } from './state';
import { grammarForPath } from './syntax';

export interface Relocation {
  file: string;
  qualname: string;
  /** max(J(candidate, C_u), J(candidate, PR_u)). */
  similarity: number;
  tokens: string[];
}

/**
 * Search `searchFiles` in `state` for the unit most similar to the order unit `u`. Returns the best
 * candidate at or above `floor`, or null. `exclude` lists `unitKey(file, qualname)` locations
 * that must not be used (the order's own unit locations).
 */
export function relocateUnit(
  u: OrderUnit,
  material: UnitMaterial,
  state: StateView,
  searchFiles: readonly string[],
  floor: number,
  exclude: ReadonlySet<string> = new Set(),
): Relocation | null {
  if (u.kind === 'removed') return null;
  const g = u.tokenizer.grammar;
  const fpC = shingles3(material.C, g);
  const fpPR = u.kind === 'added' ? null : shingles3(material.PR, g);
  let best: Relocation | null = null;
  for (const file of [...new Set(searchFiles)].sort()) {
    const fg = grammarForPath(file);
    if (!fg || (fg === 'python') !== (g === 'python')) continue; // typescript and tsx share one token vocabulary
    const fu = state.units(file);
    if (!fu) continue;
    for (const unit of fu.units.values()) {
      if (exclude.has(unitKey(file, unit.qualname))) continue;
      const s = shingles3(unit.tokens, g);
      if (s.size === 0) continue;
      const sim = Math.max(jaccard(s, fpC), fpPR ? jaccard(s, fpPR) : 0);
      if (sim >= floor && (!best || sim > best.similarity)) {
        best = { file, qualname: unit.qualname, similarity: sim, tokens: unit.tokens };
      }
    }
  }
  return best;
}
