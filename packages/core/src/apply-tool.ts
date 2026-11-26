/**
 * Tool adapters (§5.8): turn a write tool call into the proposed file text.
 * Field names follow the Kiro CLI tool schemas; spike S2 confirms them, and every lookup
 * below accepts the common aliases so a rename is a one-line change.
 */

export type ToolEffect =
  /** The write produces `text` for `path` (null text = the file is deleted). */
  | { kind: 'write'; tool: string; path: string; text: string | null }
  /** Let the call through without scoring (e.g. str_replace with zero or several matches: the tool fails anyway). */
  | { kind: 'passthrough'; tool: string; path: string | null; reason: string }
  /** A write-tagged tool DNR does not understand, with a path: warn tier (§5.8). */
  | { kind: 'unknown'; tool: string; path: string }
  /** Not a write (no path): nothing to check. */
  | { kind: 'none'; tool: string };

type Input = Record<string, unknown>;

const PATH_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'file'];
const CONTENT_KEYS = ['content', 'file_text', 'fileText', 'text', 'contents'];
const OLD_KEYS = ['old_str', 'oldStr', 'old_string', 'oldString', 'old'];
const NEW_KEYS = ['new_str', 'newStr', 'new_string', 'newString', 'new'];

function pick(input: Input, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function countOccurrences(hay: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    if (n > 1) return n;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

function strReplace(tool: string, path: string, current: string | null, input: Input): ToolEffect {
  const oldS = pick(input, OLD_KEYS);
  const newS = pick(input, NEW_KEYS) ?? '';
  if (current === null || oldS === undefined)
    return { kind: 'passthrough', tool, path, reason: 'str_replace target missing' };
  const n = countOccurrences(current, oldS);
  if (n !== 1)
    return {
      kind: 'passthrough',
      tool,
      path,
      reason: `str_replace with ${n === 0 ? 'zero' : 'several'} matches`,
    };
  const i = current.indexOf(oldS);
  return { kind: 'write', tool, path, text: current.slice(0, i) + newS + current.slice(i + oldS.length) };
}

function append(tool: string, path: string, current: string | null, content: string): ToolEffect {
  return { kind: 'write', tool, path, text: (current ?? '') + content };
}

function insertAfterLine(tool: string, path: string, current: string | null, input: Input): ToolEffect {
  const text = pick(input, NEW_KEYS) ?? pick(input, CONTENT_KEYS) ?? '';
  const raw = input.insert_line ?? input.insertLine ?? input.line;
  const line =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (current === null || !Number.isFinite(line))
    return { kind: 'passthrough', tool, path, reason: 'insert without a target' };
  const lines = current.split('\n');
  const at = Math.max(0, Math.min(lines.length, line));
  const ins = text.endsWith('\n') ? text.slice(0, -1) : text;
  lines.splice(at, 0, ins);
  return { kind: 'write', tool, path, text: lines.join('\n') };
}

/**
 * Compute the effect of a tool call. `readCurrent(path)` returns the file's current session
 * text, or null when it does not exist.
 */
export function applyTool(
  tool: string,
  rawInput: unknown,
  readCurrent: (path: string) => string | null,
): ToolEffect {
  const input: Input = rawInput && typeof rawInput === 'object' ? (rawInput as Input) : {};
  const path = pick(input, PATH_KEYS);
  if (!path) return { kind: 'none', tool };
  const current = () => readCurrent(path);
  switch (tool) {
    case 'fs_write': {
      const command = typeof input.command === 'string' ? input.command : undefined;
      // Legacy `command` dispatch (Kiro CLI fs_write: create | str_replace | append | insert).
      if (command === 'str_replace') return strReplace(tool, path, current(), input);
      if (command === 'append')
        return append(tool, path, current(), pick(input, NEW_KEYS) ?? pick(input, CONTENT_KEYS) ?? '');
      if (command === 'insert') return insertAfterLine(tool, path, current(), input);
      const content = pick(input, CONTENT_KEYS);
      if (content === undefined) return { kind: 'unknown', tool, path };
      return { kind: 'write', tool, path, text: content };
    }
    case 'str_replace':
      return strReplace(tool, path, current(), input);
    case 'fs_append':
      return append(tool, path, current(), pick(input, CONTENT_KEYS) ?? pick(input, NEW_KEYS) ?? '');
    case 'delete_file':
      return { kind: 'write', tool, path, text: null };
    default:
      return { kind: 'unknown', tool, path };
  }
}
