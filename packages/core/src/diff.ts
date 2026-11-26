/**
 * Token diff: a thin wrapper over jsdiff's `diffArrays` (§5.3). A = tokens added, R = tokens removed.
 */
import { diffArrays } from 'diff';

export interface TokenDiff {
  /** Tokens the change added, in order. */
  A: string[];
  /** Tokens the change removed, in order. */
  R: string[];
}

export function diffTokens(before: readonly string[], after: readonly string[]): TokenDiff {
  const A: string[] = [];
  const R: string[] = [];
  if (before.length === 0) return { A: [...after], R };
  if (after.length === 0) return { A, R: [...before] };
  for (const part of diffArrays(before as string[], after as string[])) {
    if (part.added) A.push(...part.value);
    else if (part.removed) R.push(...part.value);
  }
  return { A, R };
}

export function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
