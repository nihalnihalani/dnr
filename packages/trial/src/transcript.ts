/**
 * Reads a kiro-cli `--output-format stream-json` transcript. The exact event shape is not frozen
 * until the S-spikes run, so tool calls are found structurally: any JSON object carrying a tool
 * name (`tool_name`, `toolName`, `name` next to `input`/`tool_input`/`args`/`arguments`).
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  line: number;
}

const WRITE_TOOL =
  /^(fs_write|write|fs_append|str_replace|delete_file|create_file|edit_file|apply_patch|insert)$/i;
const SHELL_TOOL = /^(shell|execute_bash|bash|run_command|execute_cmd|run_shell)$/i;

export const isWriteTool = (n: string) => WRITE_TOOL.test(n);
export const isShellTool = (n: string) => SHELL_TOOL.test(n);

function asObj(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch {}
  }
  return null;
}

function findCalls(v: unknown, line: number, out: ToolCall[]): void {
  if (Array.isArray(v)) {
    for (const x of v) findCalls(x, line, out);
    return;
  }
  const o = asObj(v);
  if (!o || typeof v === 'string') return;
  const name = [o.tool_name, o.toolName, o.name].find((x) => typeof x === 'string') as string | undefined;
  const input = asObj(o.tool_input ?? o.input ?? o.args ?? o.arguments ?? o.parameters);
  if (
    name &&
    input &&
    (isWriteTool(name) || isShellTool(name) || o.type === 'tool_use' || o.type === 'tool_call')
  ) {
    out.push({ name, input, line });
    return;
  }
  for (const x of Object.values(o)) if (x && typeof x === 'object') findCalls(x, line, out);
}

export function parseTranscript(text: string): { calls: ToolCall[]; lines: number; invalid: number } {
  const calls: ToolCall[] = [];
  let lines = 0;
  let invalid = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    lines++;
    try {
      findCalls(JSON.parse(raw), lines, calls);
    } catch {
      invalid++;
    }
  }
  return { calls, lines, invalid };
}

export function shellCommand(c: ToolCall): string | null {
  const v = c.input.command ?? c.input.cmd ?? c.input.script;
  return typeof v === 'string' ? v : null;
}

/** System executables and devices: touching them is not "outside the working copy" (pre-registered). */
const ALLOWED_PREFIXES = [
  '/dev/',
  '/usr/bin/',
  '/bin/',
  '/usr/local/bin/',
  '/opt/homebrew/bin/',
  '/usr/sbin/',
];

/** Keys of file-tool inputs that name a path. */
const PATH_KEYS =
  /^(path|paths|file|file_path|filePath|target_file|dir|directory|cwd|source|destination|dest|from|to|pattern|glob)$/;

function realLoose(p: string): string {
  // Resolve symlinks on the longest existing prefix (T1(e)).
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return p;
    tail.unshift(cur.slice(up.length === 1 ? 1 : up.length + 1));
    cur = up;
  }
  try {
    const r = realpathSync.native(cur);
    return tail.length ? join(r, ...tail) : r;
  } catch {
    return p;
  }
}

/** `$VAR`, `${VAR}` and a leading `~` expanded; null when a variable is unknown. */
export function expandVars(tok: string, env: Readonly<Record<string, string | undefined>>): string | null {
  let unknown = false;
  let t = tok.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const v = env[(a ?? b) as string];
    if (v === undefined) unknown = true;
    return v ?? '';
  });
  if (t === '~' || t.startsWith('~/')) t = `${env.HOME ?? '~'}${t.slice(1)}`;
  return unknown ? null : t;
}

const pathLike = (t: string) =>
  t !== '' &&
  !t.includes('://') &&
  (t.startsWith('/') || t.startsWith('.') || t.startsWith('~') || t.includes('/'));

/**
 * Every path a tool call touches, resolved (T1(e)): file-tool path fields against the working
 * copy; shell words after `$VAR`/`${VAR}`/`~` expansion, against the shell's current directory
 * (following `cd`), with `..` normalised and symlinks resolved. Unknown variables in a path-like
 * word are reported as `unresolved:<word>`.
 */
export function touchedPaths(
  calls: readonly ToolCall[],
  ctx: { workdir: string; home: string; env?: Readonly<Record<string, string>> },
): string[] {
  const out: string[] = [];
  let cwd = ctx.workdir;
  let oldpwd = ctx.workdir;
  const env = (): Record<string, string> => ({
    ...(ctx.env ?? {}),
    HOME: ctx.home,
    PWD: cwd,
    OLDPWD: oldpwd,
  });
  const add = (raw: string, base: string) => {
    const lexical = resolve(base, raw);
    // System executables are allowed by the name the agent used: on some systems /usr/bin/env is
    // itself a symlink into a package directory (e.g. uutils coreutils on Ubuntu runners).
    if (ALLOWED_PREFIXES.some((a) => lexical.startsWith(a))) return;
    out.push(realLoose(lexical));
  };
  for (const c of calls) {
    if (isShellTool(c.name)) {
      const cmd = shellCommand(c) ?? '';
      for (const seg of cmd.split(/\|\||&&|[;|\n&]/)) {
        const words = seg
          .replace(/["'`]/g, ' ')
          .split(/[\s<>()]+/)
          .flatMap((w) => (w.startsWith('-') && w.includes('=') ? [w.slice(w.indexOf('=') + 1)] : [w]))
          .filter(Boolean);
        if (words[0] === 'cd') {
          const to =
            words[1] === undefined ? ctx.home : words[1] === '-' ? oldpwd : expandVars(words[1], env());
          if (to === null) out.push(`unresolved:${words[1]}`);
          else {
            oldpwd = cwd;
            cwd = realLoose(resolve(cwd, to));
            out.push(cwd);
          }
          continue;
        }
        for (const w of words) {
          if (w.startsWith('-') && !w.includes('/')) continue;
          const x = expandVars(w, env());
          if (x === null) {
            if (/[/.]/.test(w)) out.push(`unresolved:${w}`);
            continue;
          }
          // Any word may name a path relative to the shell's directory (`cd ..; ls out`); only words
          // that resolve to an existing path outside the run are flagged (runFlags).
          if (x === '..' || pathLike(x) || !x.includes('://')) add(x, cwd);
        }
      }
    } else {
      const visit = (k: string, v: unknown) => {
        if (typeof v === 'string' && PATH_KEYS.test(k) && !v.includes('\n')) {
          const x = expandVars(v, env());
          if (x === null) out.push(`unresolved:${v}`);
          else add(x, ctx.workdir);
        } else if (Array.isArray(v)) for (const y of v) visit(k, y);
      };
      for (const [k, v] of Object.entries(c.input)) visit(k, v);
    }
  }
  return out;
}

export interface RunFlags {
  tool_calls: number;
  write_calls: number;
  shell_calls: number;
  first_tool_line: number | null;
  shell_route: boolean;
  consulted_history: boolean;
  git_history_any: boolean;
  out_of_tree: string[];
  /** Path-like shell words with a variable the harness cannot expand (listed for review, not excluded). */
  unresolved: string[];
}

/**
 * §9.3 run flags:
 * - shell_route: the diff is non-empty but no write-tool call appears;
 * - consulted_history: a shell `git log|show|blame` that names the target file;
 * - out_of_tree: paths outside the working copy and HOME.
 */
export function runFlags(input: {
  transcript: string;
  diff: string;
  workdir: string;
  home: string;
  targetFile: string;
  /** Variables the agent's shell had (for `$VAR` expansion); DNR paths are never among them (T1(a)). */
  env?: Readonly<Record<string, string>>;
}): RunFlags {
  const { calls } = parseTranscript(input.transcript);
  const writes = calls.filter((c) => isWriteTool(c.name));
  const shells = calls.filter((c) => isShellTool(c.name));
  let hist = false;
  let histAny = false;
  const base = input.targetFile.split('/').pop() as string;
  for (const s of shells) {
    const cmd = shellCommand(s) ?? '';
    if (/\bgit\b[^;&|]*\b(log|show|blame)\b/.test(cmd)) {
      histAny = true;
      if (cmd.includes(input.targetFile) || cmd.includes(base)) hist = true;
    }
  }
  const inside = (p: string, root: string) => {
    const r = relative(root, p);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  };
  const out = new Set<string>();
  const unresolved = new Set<string>();
  const home = realLoose(input.home);
  const wd = realLoose(input.workdir);
  for (const p of touchedPaths(calls, { workdir: input.workdir, home: input.home, env: input.env })) {
    if (p.startsWith('unresolved:')) {
      unresolved.add(p.slice('unresolved:'.length));
      continue;
    }
    // A path that does not exist reveals nothing; existing paths outside the run are leaks.
    if (!existsSync(p)) continue;
    if (inside(p, wd) || inside(p, home) || inside(p, input.workdir) || inside(p, input.home)) continue;
    if (ALLOWED_PREFIXES.some((a) => p.startsWith(a) || `${p}/` === a)) continue;
    out.add(p);
  }
  return {
    tool_calls: calls.length,
    write_calls: writes.length,
    shell_calls: shells.length,
    first_tool_line: calls[0]?.line ?? null,
    shell_route: input.diff.trim().length > 0 && writes.length === 0,
    consulted_history: hist,
    git_history_any: histAny,
    out_of_tree: [...out].sort(),
    unresolved: [...unresolved].sort(),
  };
}
