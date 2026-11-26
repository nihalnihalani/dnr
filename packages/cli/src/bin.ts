#!/usr/bin/env node
/** The `dnr` executable. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readAll } from './io';
import { runCli } from './main';

const { humanGuard } = await import('@dnr/hook/ancestry');
const humanGuardSync = () => humanGuard(process.env);

// The npm package ships the grammars in <pkg>/vendor/grammars (next to dist/).
const bundled = fileURLToPath(new URL('../vendor/grammars/', import.meta.url));
if (!process.env.DNR_GRAMMAR_DIR && existsSync(`${bundled}tree-sitter-python.wasm`))
  process.env.DNR_GRAMMAR_DIR = bundled;

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  readStdin: () => readAll(process.stdin),
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  guard: () => humanGuardSync(),
  scriptPath: fileURLToPath(import.meta.url),
});
process.exitCode = code;
