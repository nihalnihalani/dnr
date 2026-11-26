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

// The running bundle's real path: the hook protects it from write tools (wave-3 N2).
process.env.DNR_SELF ??= fileURLToPath(import.meta.url);

/** Ask at the TTY (only when both stdin and stdout are terminals). */
async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return '';
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const code = await runCli(process.argv.slice(2), {
  prompt,
  env: process.env,
  cwd: process.cwd(),
  readStdin: () => readAll(process.stdin),
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  guard: () => humanGuardSync(),
  scriptPath: fileURLToPath(import.meta.url),
});
process.exitCode = code;
