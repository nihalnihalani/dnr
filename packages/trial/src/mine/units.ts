import type { Hunk } from '@dnr/git';
import { pyLineQualnames, pyQualnameSet } from './py-units';

export interface UnitFile {
  path: string;
  before: string | null;
  after: string | null;
  hunks: Hunk[];
}

/**
 * Resolves the units C changed (for E4/E7) and the whole-order weight (for E5).
 * The fallback analyzer has no §5.3 weights, so E5 stays pending until the engine's
 * analyzer is plugged in.
 */
export interface UnitAnalyzer {
  readonly source: 'engine' | 'fallback-indent';
  changedUnits(file: UnitFile): string[];
  unitExists(path: string, text: string, qualname: string): boolean;
  /** w(A)+w(R) over the whole order, or null when weights are unavailable. */
  orderWeight(files: UnitFile[]): Promise<number | null>;
}

function linesOf(start: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(start + i);
  return out;
}

export const fallbackAnalyzer: UnitAnalyzer = {
  source: 'fallback-indent',
  changedUnits(file) {
    const names = new Set<string>();
    const beforeQ = file.before === null ? null : pyLineQualnames(file.before);
    const afterQ = file.after === null ? null : pyLineQualnames(file.after);
    for (const h of file.hunks) {
      if (beforeQ) for (const l of linesOf(h.oldStart, h.removed.length)) names.add(beforeQ[l] ?? '<module>');
      if (afterQ) for (const l of linesOf(h.newStart, h.added.length)) names.add(afterQ[l] ?? '<module>');
    }
    return [...names].sort();
  },
  unitExists(_path, text, qualname) {
    if (qualname === '<module>') return true;
    return pyQualnameSet(text).has(qualname);
  },
  async orderWeight() {
    return null;
  },
};
