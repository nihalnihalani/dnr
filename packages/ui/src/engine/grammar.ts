/**
 * Lazy browser grammar loader. Only the grammars a case needs are fetched (python is 448 KB,
 * typescript and tsx 1.4 MB each), so /play for a Django case never downloads the TS grammars.
 */
import type { GrammarId, ParserProvider, SyntaxTree } from '@dnr/core';
import { Language, Parser } from 'web-tree-sitter';

export interface GrammarUrls {
  runtime: string;
  python: string;
  typescript: string;
  tsx: string;
}

export interface LazyProvider extends ParserProvider {
  ensure(grammars: readonly GrammarId[]): Promise<void>;
  loaded(): GrammarId[];
}

export function createLazyProvider(urls: GrammarUrls): LazyProvider {
  let init: Promise<void> | null = null;
  const languages = new Map<GrammarId, Promise<Language>>();
  const parsers = new Map<GrammarId, Parser>();
  return {
    async ensure(grammars) {
      if (!init) init = Parser.init({ locateFile: () => urls.runtime });
      await init;
      // typescript and tsx share one fingerprint vocabulary (§5.16), but each file is parsed
      // only with its own grammar, so load exactly what is asked for.
      await Promise.all(
        grammars.map(async (g) => {
          let p = languages.get(g);
          if (!p) {
            p = Language.load(urls[g]);
            languages.set(g, p);
          }
          const lang = await p;
          if (!parsers.has(g)) {
            const parser = new Parser();
            parser.setLanguage(lang);
            parsers.set(g, parser);
          }
        }),
      );
    },
    loaded() {
      return [...parsers.keys()];
    },
    parse(grammar, text): SyntaxTree {
      const p = parsers.get(grammar);
      if (!p) throw new Error(`grammar ${grammar} not loaded`);
      const tree = p.parse(text);
      if (!tree) throw new Error(`tree-sitter returned no tree for ${grammar}`);
      return tree as unknown as SyntaxTree;
    },
  };
}
