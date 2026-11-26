/**
 * Reads a kiro-cli `--output-format stream-json` transcript. The exact event shape is not frozen
 * until the S-spikes run, so tool calls are found structurally: any JSON object carrying a tool
 * name (`tool_name`, `toolName`, `name` next to `input`/`tool_input`/`args`/`arguments`).
 */
import { isAbsolute, relative, resolve } from 'node:path';

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

/** Every string in a tool input that looks like a path (absolute, `~`, or with a `/`). */
export function pathsIn(c: ToolCall): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      if (c.name && isShellTool(c.name)) {
        for (const tok of v.split(/[\s;|&<>()'"`=]+/)) if (/^(\/|~)/.test(tok)) out.push(tok);
      } else if (/^(\/|~)/.test(v) && !v.includes('\n')) out.push(v);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  for (const [k, v] of Object.entries(c.input))
    if (!/^(content|text|new_str|old_str|file_text)$/.test(k)) visit(v);
  return out;
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

export interface RunFlags {
  tool_calls: number;
  write_calls: number;
  shell_calls: number;
  first_tool_line: number | null;
  shell_route: boolean;
  consulted_history: boolean;
  git_history_any: boolean;
  out_of_tree: string[];
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
  for (const c of calls)
    for (const raw of pathsIn(c)) {
      const p = raw.startsWith('~')
        ? resolve(input.home, raw.slice(raw.startsWith('~/') ? 2 : 1))
        : resolve(raw);
      if (inside(p, input.workdir) || inside(p, input.home)) continue;
      if (ALLOWED_PREFIXES.some((a) => p.startsWith(a))) continue;
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
  };
}
