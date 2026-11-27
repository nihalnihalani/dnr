/**
 * Drive the installed `dnr` from a real terminal, as a human would (the plan's P12-02 method): an
 * interactive shell runs under node-pty, a command is typed at its prompt, and prompts are
 * answered by typing. The R6 guard sees a TTY and an interactive shell as the nearest ancestor.
 */
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { IPty } from 'node-pty';

const require = createRequire(import.meta.url);

/** node-pty 1.1.0's macOS prebuilt `spawn-helper` can lose its exec bit on install; restore it. */
function fixSpawnHelper(): void {
  const root = dirname(require.resolve('node-pty/package.json'));
  const pre = join(root, 'prebuilds');
  if (!existsSync(pre)) return;
  for (const d of readdirSync(pre)) {
    const helper = join(pre, d, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

export function shQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface Terminal {
  pty: IPty;
  output(): string;
  /** Resolve when the output (after the typed command) matches `re`. */
  waitFor(re: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
  type(text: string): void;
  /** Resolve with the command's exit status (the shell exits with it). */
  exited: Promise<number>;
}

/** Start an interactive bash in `cwd` and type `argv` at its prompt; the shell exits with its status. */
export function terminal(argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Terminal {
  fixSpawnHelper();
  const pty = require('node-pty') as typeof import('node-pty');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) env[k] = v;
  env.PS1 = '$ ';
  env.TERM = 'xterm-256color';
  const p = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd: opts.cwd,
    env,
  });
  let buf = '';
  const waiters: Array<() => void> = [];
  p.onData((d) => {
    buf += d;
    for (const w of waiters.splice(0)) w();
  });
  const exited = new Promise<number>((res) => p.onExit((e) => res(e.exitCode)));
  // Type the command once the shell is up; `exit $?` hands its status back to us.
  p.write(`${argv.map(shQuote).join(' ')}; exit $?\r`);
  const t: Terminal = {
    pty: p,
    output: () => buf,
    type: (text) => p.write(text),
    exited,
    waitFor(re, timeoutMs = 60_000) {
      return new Promise((res, rej) => {
        const timer = setTimeout(
          () => rej(new Error(`timed out waiting for ${re} in terminal output:\n${buf}`)),
          timeoutMs,
        );
        const check = () => {
          const m = buf.match(re);
          if (m) {
            clearTimeout(timer);
            res(m);
          } else waiters.push(check);
        };
        check();
      });
    },
  };
  return t;
}

/** Run `argv` in a terminal, answering each prompt that matches with the paired text. */
export async function runInTerminal(
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; answers?: Array<[RegExp, string]>; timeoutMs?: number },
): Promise<{ code: number; output: string }> {
  const t = terminal(argv, opts);
  const answered = new Set<number>();
  const sub = t.pty.onData(() => {
    (opts.answers ?? []).forEach(([re, text], i) => {
      if (!answered.has(i) && re.test(t.output())) {
        answered.add(i);
        t.type(text);
      }
    });
  });
  const timer = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`terminal timed out:\n${t.output()}`)), opts.timeoutMs ?? 120_000).unref(),
  );
  const code = await Promise.race([t.exited, timer]);
  sub.dispose();
  return { code, output: t.output() };
}
