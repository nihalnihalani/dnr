#!/usr/bin/env node
// Loads each vendored grammar with the pinned web-tree-sitter and parses a sample (plan §4 pins).
// Exit 0 when every grammar loads and parses without ERROR nodes; exit 1 otherwise.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/grammar/package.json'));
const wtsCjs = require.resolve('web-tree-sitter'); // .../web-tree-sitter/web-tree-sitter.cjs
const wtsDir = dirname(wtsCjs);
const version = JSON.parse(readFileSync(join(wtsDir, 'package.json'), 'utf8')).version;
const { Parser, Language } = await import(pathToFileURL(join(wtsDir, 'web-tree-sitter.js')).href);

const samples = [
  ['tree-sitter-python.wasm', 'def f(): pass\n', 'function_definition'],
  [
    'tree-sitter-typescript.wasm',
    'function f(a: number): number { return a + 1; }\n',
    'function_declaration',
  ],
  [
    'tree-sitter-tsx.wasm',
    'export function F(p: { x: string }) { return <div>{p.x}</div>; }\n',
    'function_declaration',
  ],
];

await Parser.init();
let failed = false;
console.log(`web-tree-sitter ${version}`);
for (const [file, src, expect] of samples) {
  const path = join(root, 'vendor/grammars', file);
  try {
    const bytes = readFileSync(path);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const lang = await Language.load(new Uint8Array(bytes));
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(src);
    const sexp = tree.rootNode.toString();
    const ok = !tree.rootNode.hasError && sexp.includes(`(${expect}`);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${file} abi=${lang.abiVersion} sha256=${sha}\n     ${sexp}`);
    if (!ok) failed = true;
    tree.delete();
    parser.delete();
  } catch (e) {
    failed = true;
    console.log(`FAIL ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(failed ? 1 : 0);
