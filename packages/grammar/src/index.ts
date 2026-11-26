/**
 * @dnr/grammar: browser-safe loader for the vendored tree-sitter grammars.
 *
 * The node loader is in `@dnr/grammar/node` (it reads the `.wasm` files with node:fs).
 * Both loaders return a {@link GrammarSet}, which satisfies `@dnr/core`'s `ParserProvider`.
 */
import { Language, Parser, type Tree } from 'web-tree-sitter';

export type GrammarId = 'python' | 'typescript' | 'tsx';
export const GRAMMAR_IDS: readonly GrammarId[] = ['python', 'typescript', 'tsx'];
export const GRAMMAR_FILES: Record<GrammarId, string> = {
  python: 'tree-sitter-python.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
};

export interface GrammarSet {
  readonly languages: Readonly<Record<GrammarId, Language>>;
  /** Parse `text` with `grammar`. The caller owns the tree and should `tree.delete()` it when done. */
  parse(grammar: GrammarId, text: string): Tree;
}

/** Build a GrammarSet from loaded languages. Each grammar keeps one reusable Parser. */
export function createGrammarSet(languages: Record<GrammarId, Language>): GrammarSet {
  const parsers = new Map<GrammarId, Parser>();
  return {
    languages,
    parse(grammar, text) {
      let p = parsers.get(grammar);
      if (!p) {
        p = new Parser();
        p.setLanguage(languages[grammar]);
        parsers.set(grammar, p);
      }
      const tree = p.parse(text);
      if (!tree) throw new Error(`tree-sitter returned no tree for ${grammar}`);
      return tree;
    },
  };
}

export interface BrowserGrammarUrls {
  /** URL of `web-tree-sitter.wasm` (the runtime). */
  runtime: string;
  python: string;
  typescript: string;
  tsx: string;
}

let initPromise: Promise<void> | null = null;
/** Initialise the web-tree-sitter runtime once. `locateRuntime` overrides where `web-tree-sitter.wasm` is fetched from. */
export function initRuntime(locateRuntime?: string): Promise<void> {
  if (!initPromise) {
    initPromise = locateRuntime ? Parser.init({ locateFile: () => locateRuntime }) : Parser.init();
  }
  return initPromise;
}

/** Load the three grammars from URLs (browser, worker, or any environment with fetch). */
export async function loadGrammarsBrowser(urls: BrowserGrammarUrls): Promise<GrammarSet> {
  await initRuntime(urls.runtime);
  const [python, typescript, tsx] = await Promise.all([
    Language.load(urls.python),
    Language.load(urls.typescript),
    Language.load(urls.tsx),
  ]);
  return createGrammarSet({ python, typescript, tsx });
}

/** Load the three grammars from raw `.wasm` bytes (works everywhere). */
export async function loadGrammarsFromBytes(bytes: Record<GrammarId, Uint8Array>): Promise<GrammarSet> {
  await initRuntime();
  const [python, typescript, tsx] = await Promise.all([
    Language.load(bytes.python),
    Language.load(bytes.typescript),
    Language.load(bytes.tsx),
  ]);
  return createGrammarSet({ python, typescript, tsx });
}

export type { Language, Node, Tree } from 'web-tree-sitter';
