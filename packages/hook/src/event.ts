/**
 * Kiro hook stdin (plan §1, docs/kiro hooks types): `hook_event_name`, `cwd`, `session_id`,
 * `tool_name`, `tool_input` (PreToolUse), plus `tool_response` on PostToolUse.
 * Field names are provisional until spike S2 freezes them, so aliases are accepted.
 */
import { isAbsolute, resolve } from 'node:path';

export interface HookEvent {
  hook_event_name: string | null;
  cwd: string;
  session_id: string | null;
  tool_name: string | null;
  tool_input: unknown;
  tool_response: unknown;
  raw: unknown;
}

export class StdinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StdinError';
  }
}

function str(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** Parse hook stdin. A relative `cwd` resolves against the process cwd (portable fixtures use "."). */
export function parseHookEvent(text: string, processCwd = process.cwd()): HookEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new StdinError(`stdin is not JSON: ${String(e).slice(0, 200)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new StdinError('stdin is not a JSON object');
  const o = raw as Record<string, unknown>;
  const cwdRaw = str(o, 'cwd', 'workspace', 'workspace_root');
  const cwd = cwdRaw ? (isAbsolute(cwdRaw) ? cwdRaw : resolve(processCwd, cwdRaw)) : processCwd;
  let toolInput = o.tool_input ?? o.toolInput ?? o.input ?? null;
  if (typeof toolInput === 'string') {
    try {
      toolInput = JSON.parse(toolInput);
    } catch {}
  }
  return {
    hook_event_name: str(o, 'hook_event_name', 'hookEventName', 'event'),
    cwd,
    session_id: str(o, 'session_id', 'sessionId', 'conversation_id'),
    tool_name: str(o, 'tool_name', 'toolName', 'tool'),
    tool_input: toolInput,
    tool_response: o.tool_response ?? o.toolResponse ?? null,
    raw,
  };
}

/** Shell command text from a shell tool's input (spike S12 confirms the field). */
export function shellCommandOf(ev: HookEvent): string | null {
  const ti = ev.tool_input;
  if (typeof ti === 'string') return ti;
  if (ti && typeof ti === 'object') {
    const o = ti as Record<string, unknown>;
    for (const k of ['command', 'cmd', 'script', 'commandLine']) {
      const v = o[k];
      if (typeof v === 'string') return v;
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(' ');
    }
  }
  return null;
}
