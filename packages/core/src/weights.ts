/**
 * Token weights (§5.1, §5.15). Weight 0 for punctuation that carries no meaning on its own;
 * every other token (keywords included) has weight 1.
 */
import type { GrammarId } from './syntax';

/** Normalizer version per grammar (§5.15: keyed per grammar, stored on each OrderUnit). */
export const NORMALIZER_VERSION: Readonly<Record<GrammarId, number>> = { python: 1, typescript: 1, tsx: 1 };

/**
 * In TypeScript, `<` and `>` are weight 0 only inside type arguments/parameters. The tokenizer
 * gives those brackets the distinct keys `‹` and `›`, so a token's weight is a pure function of
 * its key and grammar, and stored A/R arrays can be re-weighted.
 */
export const TYPE_ARG_OPEN = '‹';
export const TYPE_ARG_CLOSE = '›';

const PY_W0 = new Set(['.', ',', ':', ';', '(', ')', '[', ']', '{', '}', '=', '->', ':=', '@', '\\']);
// `${` is the opening delimiter of a template substitution, the pair of `}` (weight 0); see core README.
const TS_W0 = new Set([
  '.',
  ',',
  ':',
  ';',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '=',
  '=>',
  TYPE_ARG_OPEN,
  TYPE_ARG_CLOSE,
  '@',
  '`',
  '${',
]);

export function weightSet(grammar: GrammarId): ReadonlySet<string> {
  return grammar === 'python' ? PY_W0 : TS_W0;
}

export function tokenWeight(key: string, grammar: GrammarId): 0 | 1 {
  return weightSet(grammar).has(key) ? 0 : 1;
}

/** w(tokens): the weighted size of a token list. */
export function weightOf(tokens: readonly string[], grammar: GrammarId): number {
  const w0 = weightSet(grammar);
  let n = 0;
  for (const t of tokens) if (!w0.has(t)) n++;
  return n;
}

/**
 * w(A) and w(R) of one order unit. Use this, not `A.length`: the token arrays include
 * weight-0 punctuation (§5.1), which never counts.
 */
export function unitWeights(u: {
  A: readonly string[];
  R: readonly string[];
  tokenizer: { grammar: GrammarId };
}): {
  wA: number;
  wR: number;
} {
  return { wA: weightOf(u.A, u.tokenizer.grammar), wR: weightOf(u.R, u.tokenizer.grammar) };
}

/** The whole order's w(A) + w(R), compared with `min_order_weight` (§5.5 small-order rule). */
export function orderWeight(order: {
  units: ReadonlyArray<{ A: readonly string[]; R: readonly string[]; tokenizer: { grammar: GrammarId } }>;
}): number {
  let n = 0;
  for (const u of order.units) {
    const w = unitWeights(u);
    n += w.wA + w.wR;
  }
  return n;
}
