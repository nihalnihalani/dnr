/**
 * Minimal structural view of a tree-sitter syntax tree. `web-tree-sitter`'s `Tree`/`Node`
 * satisfy these interfaces, so core never imports the runtime (and stays isomorphic).
 */
import type { Grammar } from '@dnr/schemas';

export type GrammarId = Grammar;

export interface SyntaxPoint {
  row: number;
  column: number;
}

export interface SyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: SyntaxPoint;
  readonly endPosition: SyntaxPoint;
  readonly childCount: number;
  readonly isMissing: boolean;
  readonly isError: boolean;
  readonly hasError: boolean;
  child(index: number): SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
}

export interface SyntaxTree {
  readonly rootNode: SyntaxNode;
  delete?(): void;
}

/** Anything that can parse text with a named grammar (e.g. `@dnr/grammar`'s GrammarSet). */
export interface ParserProvider {
  parse(grammar: GrammarId, text: string): SyntaxTree;
}

/** Children of a node, as an array (avoids allocating web-tree-sitter's `children` getter repeatedly). */
export function childrenOf(n: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Grammar for a repo path (§5.15), or null when the file is not scored
 * (unknown extension, or a `.d.ts` declaration file).
 */
export function grammarForPath(path: string): GrammarId | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.py')) return 'python';
  if (/\.d\.(ts|mts|cts)$/.test(lower)) return null;
  if (/\.(ts|mts|cts)$/.test(lower)) return 'typescript';
  if (/\.(tsx|js|jsx|mjs|cjs)$/.test(lower)) return 'tsx';
  return null;
}
