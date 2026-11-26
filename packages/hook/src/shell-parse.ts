/**
 * guard-shell parsing (§5.10): shell-quote tokens split into simple commands on
 * `; && || | & ( )`, with `$( … )` and backtick substitutions analysed as commands of their own,
 * and wrappers (`env`, `sh -c`, `npx`, `script`, `node …/cli.js`, …) unwrapped.
 */
import { parse } from 'shell-quote';

export interface SimpleCommand {
  /** argv after leading `VAR=value` assignments. */
  argv: string[];
  /** Redirect targets and sources (`> f`, `>> f`, `< f`). */
  redirects: Array<{ op: string; target: string }>;
  /** Glob patterns as written. */
  globs: string[];
  /** Leading `VAR=value` assignments. */
  assigns: string[];
  /** The wrappers this command was found inside (`sh -c`, `npx`, …). */
  via: string[];
  /** stdout goes into a pipe (`cmd | …`). */
  pipedTo?: boolean;
  /** stdin comes from a pipe; the previous command's argv. */
  pipedFromArgv?: string[];
}

const SPLIT_OPS = new Set([';', '&&', '||', '|', '&', '(', ')', '|&', ';;']);
const REDIRECT_OPS = new Set(['>', '>>', '<', '>&', '<&', '>|', '&>', '&>>', '<<<']);

/** Pull `$( … )` and backtick bodies out of a command string (nested ones too). */
export function substitutions(cmd: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) break;
      i = j;
      continue;
    }
    if (ch === '`') {
      const j = cmd.indexOf('`', i + 1);
      if (j < 0) break;
      out.push(cmd.slice(i + 1, j));
      i = j;
      continue;
    }
    if (ch === '$' && cmd[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < cmd.length && depth > 0; j++) {
        if (cmd[j] === '(') depth++;
        else if (cmd[j] === ')') depth--;
      }
      const body = cmd.slice(i + 2, j - 1);
      out.push(body, ...substitutions(body));
      i = j - 1;
    }
  }
  return out;
}

type Tok = ReturnType<typeof parse>[number];

function tokenize(cmd: string, env: Record<string, string | undefined>): Tok[] {
  try {
    // Expand HOME and variables assigned earlier in the same command line (`X=sha; git cherry-pick $X`).
    return parse(cmd, (k: string) => env[k] ?? `$${k}`) as Tok[];
  } catch {
    return cmd.split(/\s+/).filter(Boolean);
  }
}

const empty = (): SimpleCommand => ({ argv: [], redirects: [], globs: [], assigns: [], via: [] });

function splitSimple(tokens: Tok[]): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  let cur = empty();
  const flush = () => {
    if (cur.argv.length || cur.redirects.length || cur.globs.length || cur.assigns.length) out.push(cur);
    cur = empty();
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Tok;
    if (typeof t === 'string') {
      if (cur.argv.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) cur.assigns.push(t);
      else cur.argv.push(t);
      continue;
    }
    if (typeof t === 'object' && t !== null && 'op' in t) {
      const op = (t as { op: string }).op;
      if (op === 'glob') {
        const pattern = (t as unknown as { pattern: string }).pattern;
        cur.globs.push(pattern);
        cur.argv.push(pattern);
        continue;
      }
      if (REDIRECT_OPS.has(op)) {
        const next = tokens[i + 1];
        if (typeof next === 'string') {
          cur.redirects.push({ op, target: next });
          i++;
        } else if (
          next &&
          typeof next === 'object' &&
          'op' in next &&
          (next as { op: string }).op === 'glob'
        ) {
          cur.redirects.push({ op, target: (next as unknown as { pattern: string }).pattern });
          i++;
        }
        continue;
      }
      if (SPLIT_OPS.has(op)) {
        const prev = cur;
        flush();
        if (op === '|' || op === '|&') {
          prev.pipedTo = true;
          cur.pipedFromArgv = prev.argv;
        }
      }
    }
  }
  flush();
  return out;
}

/** `NAME=value` assignments made anywhere in a command line (assignment-only words). */
function assignmentsOf(cmd: string, env: Record<string, string | undefined>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const sc of splitSimple(tokenize(cmd, env)))
    for (const a of sc.assigns) {
      const i = a.indexOf('=');
      vars[a.slice(0, i)] = a.slice(i + 1);
    }
  return vars;
}

const base = (p: string) => p.split('/').pop() ?? p;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/**
 * Unwrap one level of wrapper. Returns the inner argv (or a nested command string for `sh -c`),
 * or null when argv is not a wrapper.
 */
function unwrapOnce(
  argv: string[],
): { inner: string[] | null; script?: string; via: string; assigns?: string[] } | null {
  const [a0 = '', ...rest] = argv;
  const b = base(a0);
  const at = (i: number) => rest[i] as string;
  if (b === 'env') {
    let i = 0;
    while (i < rest.length) {
      const t = at(i);
      if (['-u', '-C', '-S', '--unset', '--chdir', '-P'].includes(t)) {
        i += 2;
        continue;
      }
      if (t.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i++;
        continue;
      }
      break;
    }
    const assigns = rest.slice(0, i).filter((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    return { inner: rest.slice(i), via: 'env', assigns };
  }
  if (['nohup', 'exec', 'command', 'builtin', 'time', 'caffeinate', 'stdbuf', 'unbuffer'].includes(b)) {
    let i = 0;
    while (i < rest.length && at(i).startsWith('-')) i++;
    return { inner: rest.slice(i), via: b };
  }
  if (['nice', 'timeout', 'sudo', 'doas', 'xargs', 'watch'].includes(b)) {
    let i = 0;
    while (i < rest.length && at(i).startsWith('-')) {
      i += ['-n', '-u', '-g', '-k', '-s', '-I', '-L', '-P', '-d', '-E'].includes(at(i)) ? 2 : 1;
    }
    if (b === 'timeout' && i < rest.length) i++; // the duration
    return { inner: rest.slice(i), via: b };
  }
  if (b === 'eval') return { inner: null, script: rest.join(' '), via: 'eval' };
  if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(b))
    return { inner: [], via: b, assigns: rest.filter((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) };
  if (SHELLS.has(b)) {
    const ci = rest.findIndex((t) => /^-[a-z]*c[a-z]*$/.test(t));
    if (ci >= 0 && rest[ci + 1] !== undefined) return { inner: null, script: at(ci + 1), via: `${b} -c` };
    return null;
  }
  if (b === 'script') {
    // macOS: script [-aeFkqr] [-t time] [file [command ...]]; Linux: script [-q] -c "cmd" [file]
    const ci = rest.findIndex((t) => t === '-c' || t === '--command');
    if (ci >= 0 && rest[ci + 1] !== undefined) return { inner: null, script: at(ci + 1), via: 'script' };
    let i = 0;
    while (i < rest.length && at(i).startsWith('-')) i += at(i) === '-t' || at(i) === '-T' ? 2 : 1;
    return { inner: rest.slice(i + 1), via: 'script' };
  }
  if (b === 'npx' || b === 'bunx' || b === 'pnpx') {
    let i = 0;
    while (i < rest.length && at(i).startsWith('-'))
      i += ['-p', '--package', '-c', '--call'].includes(at(i)) ? 2 : 1;
    return { inner: rest.slice(i), via: b };
  }
  if (b === 'pnpm' || b === 'npm' || b === 'yarn' || b === 'bun') {
    let i = 0;
    while (i < rest.length && at(i).startsWith('-')) {
      i += ['-F', '--filter', '-C', '--dir', '-w', '--prefix'].includes(at(i)) ? 2 : 1;
    }
    const sub = rest[i];
    if (sub === 'exec' || sub === 'x' || sub === 'dlx' || sub === 'run') {
      let j = i + 1;
      while (j < rest.length && (at(j).startsWith('-') || at(j) === '--')) j++;
      return { inner: rest.slice(j), via: `${b} ${sub}` };
    }
    if (sub === 'dnr' || sub === 'dnr-guard') return { inner: rest.slice(i), via: b };
    return null;
  }
  if (b === 'node' || b === 'tsx' || b === 'deno') {
    let i = 0;
    while (i < rest.length && at(i).startsWith('-')) {
      const t = at(i);
      if (t === '-e' || t === '--eval' || t === '-p' || t === '--print') return null;
      i += ['-r', '--require', '--import', '--loader'].includes(t) ? 2 : 1;
    }
    const script = rest[i];
    if (script && /(^|\/)(cli|dnr)(\.[cm]?js|\.ts)?$/.test(script))
      return { inner: ['dnr', ...rest.slice(i + 1)], via: 'node' };
    return null;
  }
  return null;
}

/** Parse a command string into simple commands, recursing through substitutions and wrappers. */
export function parseCommands(
  cmd: string,
  env: Record<string, string | undefined> = {},
  depth = 0,
  via: string[] = [],
): SimpleCommand[] {
  if (depth > 8) return [];
  const out: SimpleCommand[] = [];
  const vars = { ...env, ...assignmentsOf(cmd, env) };
  for (const sc of splitSimple(tokenize(cmd, vars))) {
    let c: SimpleCommand | null = { ...sc, via: [...via] };
    // `echo "git cherry-pick X" | sh`: the piped text is a script.
    const b0 = base(c.argv[0] ?? '');
    if (SHELLS.has(b0) && c.pipedFromArgv && !c.argv.some((t) => /^-[a-z]*c/.test(t))) {
      const src = c.pipedFromArgv;
      if (['echo', 'printf'].includes(base(src[0] ?? ''))) {
        const text = src
          .slice(1)
          .filter((t) => !/^-[neE]+$/.test(t))
          .join(' ');
        out.push(...parseCommands(text, vars, depth + 1, [...via, `| ${b0}`]));
      }
    }
    for (let guard = 0; guard < 10 && c; guard++) {
      const u = unwrapOnce(c.argv);
      if (!u) break;
      out.push({ ...c });
      if (u.assigns?.length) c = { ...c, assigns: [...c.assigns, ...u.assigns] };
      if (u.script !== undefined) {
        out.push(...parseCommands(u.script, vars, depth + 1, [...c.via, u.via]));
        c = null;
        break;
      }
      c = { ...c, argv: u.inner ?? [], via: [...c.via, u.via] };
    }
    if (c && (c.argv.length || c.redirects.length || c.assigns.length)) out.push(c);
  }
  for (const sub of substitutions(cmd)) out.push(...parseCommands(sub, vars, depth + 1, [...via, '$()']));
  return out;
}

export function isDnr(argv0: string | undefined): boolean {
  if (!argv0) return false;
  const b = base(argv0);
  return b === 'dnr' || b === 'dnr-guard';
}
