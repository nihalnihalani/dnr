/**
 * Order material: the unit states C_u (after C) and PR_u (at the revert snapshot) that the
 * order file does not store. Proximity (§5.6) and the fingerprint index (§5.16) need them.
 * Callers re-tokenize them from `c_state_ref` / `snapshot_sha` (or a cache); `buildOrder`
 * returns them directly.
 */
import type { Order } from '@dnr/schemas';
import { type Multiset, shingles3 } from './multiset';
import type { GrammarId } from './syntax';

export interface UnitMaterial {
  /** Unit tokens after C (empty for kind=removed). */
  C: string[];
  /** Unit tokens at the post-revert snapshot (empty when absent there, e.g. kind=added). */
  PR: string[];
}

export type OrderMaterial = ReadonlyMap<string, UnitMaterial>;

export function unitKey(file: string, qualname: string): string {
  return `${file}\u0000${qualname}`;
}

/** Fingerprints of one order unit (§5.16): weighted 3-shingle multisets of C_u and PR_u. */
export interface UnitFingerprint {
  file: string;
  qualname: string;
  grammar: GrammarId;
  C: Multiset;
  /** Absent for kind=added. */
  PR: Multiset | null;
}

/** The fingerprint index of an order: every unit except kind=removed. */
export function fingerprintsOf(order: Order, material: OrderMaterial): UnitFingerprint[] {
  const out: UnitFingerprint[] = [];
  for (const u of order.units) {
    if (u.kind === 'removed') continue;
    const m = material.get(unitKey(u.file, u.qualname));
    if (!m) continue;
    const g = u.tokenizer.grammar;
    out.push({
      file: u.file,
      qualname: u.qualname,
      grammar: g,
      C: shingles3(m.C, g),
      PR: u.kind === 'added' ? null : shingles3(m.PR, g),
    });
  }
  return out;
}
