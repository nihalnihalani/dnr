/**
 * Unit extraction (§5.2–5.3): split a file into scorable units and assign each token to the
 * smallest unit that contains it.
 */
import { MODULE_UNIT, type UnitSpan, unitSpans } from './qualname';
import { type GrammarId, grammarForPath, type ParserProvider, type SyntaxNode } from './syntax';
import { type Token, tokenizeTree } from './tokenize';
import { weightOf } from './weights';

/** Share of a unit's token text under ERROR nodes above which the unit is `parse-degraded` (§5.1). */
export const DEGRADED_ERROR_SHARE = 0.2;

export interface Unit {
  qualname: string;
  /** Token keys, in source order. */
  tokens: string[];
  /** w(tokens). */
  weight: number;
  /** More than 20% of the unit's token text sits under ERROR nodes (§5.1). */
  degraded: boolean;
  /** 1-based inclusive line span (for `<module>`, the whole file). */
  startLine: number;
  endLine: number;
}

export interface FileUnits {
  path: string;
  grammar: GrammarId;
  /** Units by qualname, in source order (`<module>` first). */
  units: Map<string, Unit>;
  /** Spans, for line → qualname mapping. */
  spans: UnitSpan[];
  /** True when the tree has any ERROR or MISSING node. */
  hasError: boolean;
}

/** Tokenize and split a parsed tree into units. */
export function unitsFromTree(path: string, grammar: GrammarId, root: SyntaxNode, text: string): FileUnits {
  const tokens = tokenizeTree(root, grammar, text);
  const spans = unitSpans(root, grammar);
  const owner = assignOwners(tokens, spans);
  const buckets = spans.map(() => [] as Token[]);
  tokens.forEach((t, i) => {
    buckets[owner[i] as number]?.push(t);
  });
  const units = new Map<string, Unit>();
  spans.forEach((s, i) => {
    const toks = buckets[i] as Token[];
    const keys = toks.map((t) => t.key);
    let total = 0;
    let bad = 0;
    for (const t of toks) {
      const len = t.end - t.start;
      total += len;
      if (t.inError) bad += len;
    }
    units.set(s.qualname, {
      qualname: s.qualname,
      tokens: keys,
      weight: weightOf(keys, grammar),
      degraded: total > 0 && bad / total > DEGRADED_ERROR_SHARE,
      startLine: s.startRow + 1,
      endLine: s.endRow + 1,
    });
  });
  return { path, grammar, units, spans, hasError: root.hasError };
}

/**
 * Parse `text` and extract its units. Returns null when the path is not a scored source file
 * (§5.15 extension table).
 */
export function extractUnits(provider: ParserProvider, path: string, text: string): FileUnits | null {
  const grammar = grammarForPath(path);
  if (!grammar) return null;
  const tree = provider.parse(grammar, text);
  try {
    return unitsFromTree(path, grammar, tree.rootNode, text);
  } finally {
    tree.delete?.();
  }
}

/** Index into `spans` of the smallest span containing each token (spans nest; index 0 is `<module>`). */
function assignOwners(tokens: readonly Token[], spans: readonly UnitSpan[]): number[] {
  const ranges: Array<{ start: number; end: number; idx: number }> = [];
  spans.forEach((s, idx) => {
    if (idx === 0) return;
    ranges.push({ start: s.start, end: s.end, idx });
    for (const e of s.extra) ranges.push({ start: e.start, end: e.end, idx });
  });
  return tokens.map((t) => {
    let best = 0;
    let bestLen = Number.POSITIVE_INFINITY;
    for (const r of ranges) {
      if (t.start >= r.start && t.end <= r.end && r.end - r.start < bestLen) {
        best = r.idx;
        bestLen = r.end - r.start;
      }
    }
    return best;
  });
}

/**
 * `qualnames(text, lineRanges)` (§5.2): map each changed line (1-based) to the smallest unit
 * containing it. Returns the distinct qualnames, in first-seen order.
 */
export function qualnamesForLines(file: FileUnits, lines: Iterable<number>): string[] {
  const seen = new Set<string>();
  for (const line of lines) seen.add(qualnameAtLine(file, line));
  return [...seen];
}

export function qualnameAtLine(file: FileUnits, line: number): string {
  const row = line - 1;
  let best = MODULE_UNIT;
  let bestLen = Number.POSITIVE_INFINITY;
  file.spans.forEach((s, i) => {
    if (i === 0) return;
    const ranges = [
      { startRow: s.startRow, endRow: s.endRow, len: s.end - s.start },
      ...s.extra.map((e) => ({ startRow: e.startRow, endRow: e.endRow, len: e.end - e.start })),
    ];
    for (const r of ranges) {
      if (row >= r.startRow && row <= r.endRow && r.len < bestLen) {
        best = s.qualname;
        bestLen = r.len;
      }
    }
  });
  return best;
}

/** Convenience: `qualnames(text, lineRanges)` with ranges as `[start, end]` 1-based inclusive pairs. */
export function qualnames(
  provider: ParserProvider,
  path: string,
  text: string,
  lineRanges: ReadonlyArray<readonly [number, number]>,
): string[] {
  const file = extractUnits(provider, path, text);
  if (!file) return [];
  const lines: number[] = [];
  for (const [a, b] of lineRanges) for (let l = a; l <= b; l++) lines.push(l);
  return qualnamesForLines(file, lines);
}
