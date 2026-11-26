/**
 * Tokenizer (§5.1, §5.15). Each leaf node's text becomes a token; comments and zero-width
 * (MISSING) tokens are dropped; each string literal is one token; identifiers are kept as written.
 */
import { childrenOf, type GrammarId, type ParserProvider, type SyntaxNode } from './syntax';
import { TYPE_ARG_CLOSE, TYPE_ARG_OPEN } from './weights';

export interface Token {
  /** The token's key: its source text, except TS type-argument brackets (`‹`/`›`) and `\` for a line continuation. */
  key: string;
  start: number;
  end: number;
  /** 0-based row of the token's first character. */
  row: number;
  /** True when the token sits under an ERROR node. */
  inError: boolean;
}

const COMMENT_TYPES = new Set(['comment', 'html_comment']);
/** Nodes emitted whole, as one token. */
const ATOMIC_PY = new Set(['string']);
const ATOMIC_TS = new Set(['string', 'regex']);
const TYPE_ARG_PARENTS = new Set(['type_arguments', 'type_parameters']);
const TEMPLATE_TEXT = new Set(['string_fragment', 'escape_sequence']);

/** Tokenize a whole parse tree. `text` must be the text the tree was parsed from. */
export function tokenizeTree(root: SyntaxNode, grammar: GrammarId, text: string): Token[] {
  const out: Token[] = [];
  const atomic = grammar === 'python' ? ATOMIC_PY : ATOMIC_TS;
  const rowStarts = lineStarts(text);
  const rowOf = (idx: number) => rowAt(rowStarts, idx);

  const push = (key: string, start: number, end: number, inError: boolean) => {
    if (end <= start || key.length === 0) return; // zero-width tokens are dropped
    out.push({ key, start, end, row: rowOf(start), inError });
  };

  const walk = (n: SyntaxNode, parentType: string, inError: boolean): void => {
    const t = n.type;
    if (COMMENT_TYPES.has(t)) return;
    if (n.isMissing) return;
    const err = inError || n.isError;
    if (atomic.has(t)) {
      push(text.slice(n.startIndex, n.endIndex), n.startIndex, n.endIndex, err);
      return;
    }
    if (grammar !== 'python' && t === 'template_string') {
      walkTemplate(n, err);
      return;
    }
    if (n.childCount === 0) {
      let key = text.slice(n.startIndex, n.endIndex);
      if (t === 'line_continuation') key = '\\';
      else if (grammar !== 'python' && TYPE_ARG_PARENTS.has(parentType)) {
        if (key === '<') key = TYPE_ARG_OPEN;
        else if (key === '>') key = TYPE_ARG_CLOSE;
      }
      push(key, n.startIndex, n.endIndex, err);
      return;
    }
    for (const c of childrenOf(n)) walk(c, t, err);
  };

  // A template literal without substitutions is one token. With substitutions, each fixed text
  // chunk is one token (adjacent fragments and escapes merged), and each substitution is tokenized normally.
  const walkTemplate = (n: SyntaxNode, inError: boolean): void => {
    const kids = childrenOf(n);
    if (!kids.some((k) => k.type === 'template_substitution')) {
      push(text.slice(n.startIndex, n.endIndex), n.startIndex, n.endIndex, inError);
      return;
    }
    let chunkStart = -1;
    let chunkEnd = -1;
    const flush = () => {
      if (chunkStart >= 0) push(text.slice(chunkStart, chunkEnd), chunkStart, chunkEnd, inError);
      chunkStart = -1;
    };
    for (const k of kids) {
      if (TEMPLATE_TEXT.has(k.type)) {
        if (chunkStart < 0) chunkStart = k.startIndex;
        chunkEnd = k.endIndex;
        continue;
      }
      flush();
      if (k.type === 'template_substitution') {
        for (const c of childrenOf(k)) walk(c, k.type, inError || k.isError);
      } else walk(k, n.type, inError);
    }
    flush();
  };

  walk(root, '', false);
  return out;
}

/** Parse and tokenize `text`. */
export function tokenize(provider: ParserProvider, grammar: GrammarId, text: string): Token[] {
  const tree = provider.parse(grammar, text);
  try {
    return tokenizeTree(tree.rootNode, grammar, text);
  } finally {
    tree.delete?.();
  }
}

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 0-based row containing UTF-16 offset `idx` (tree-sitter's web binding reports UTF-16 indices). */
export function rowAt(starts: readonly number[], idx: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
