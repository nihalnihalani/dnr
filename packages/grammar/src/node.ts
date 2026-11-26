/**
 * Node loader for the vendored grammars. Looks in, in order: `opts.dir`,
 * `$DNR_GRAMMAR_DIR`, then `<repo>/vendor/grammars` relative to this file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAMMAR_FILES, type GrammarId, type GrammarSet, loadGrammarsFromBytes } from './index';

export function vendorGrammarDir(): string {
  return fileURLToPath(new URL('../../../vendor/grammars/', import.meta.url));
}

export function resolveGrammarDir(dir?: string): string {
  const candidates = [dir, process.env.DNR_GRAMMAR_DIR, vendorGrammarDir()].filter(
    (d): d is string => typeof d === 'string' && d.length > 0,
  );
  for (const d of candidates) {
    if (existsSync(join(d, GRAMMAR_FILES.python))) return d;
  }
  throw new Error(`DNR: vendored grammars not found (looked in ${candidates.join(', ')})`);
}

let cached: Promise<GrammarSet> | null = null;

/** Load (once per process, unless `dir` is given) the python, typescript and tsx grammars. */
export function loadGrammarsNode(opts: { dir?: string } = {}): Promise<GrammarSet> {
  if (opts.dir) return load(opts.dir);
  if (!cached) cached = load(undefined);
  return cached;
}

async function load(dir: string | undefined): Promise<GrammarSet> {
  const d = resolveGrammarDir(dir);
  const read = (g: GrammarId) => new Uint8Array(readFileSync(join(d, GRAMMAR_FILES[g])));
  return loadGrammarsFromBytes({ python: read('python'), typescript: read('typescript'), tsx: read('tsx') });
}

export * from './index';
