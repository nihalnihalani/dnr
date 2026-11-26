/**
 * Fail open (§5.12, R7): every hook entry point allows on an internal error or timeout and logs
 * the error to `$DNR_STATE_DIR/hook.log`, plus an `error_open` event when the store is reachable.
 * Stop mode always exits 0 (an exit 1 would force a turn).
 */
import { findRepoRoot } from '@dnr/git';
import { appendEvent, hookLog, newEventId, nowIso, resolvePaths } from '@dnr/store';
import { baseDecision, type HookIO, type HookName, OK } from './context';
import { parseHookEvent } from './event';
import { DNR_VERSION } from './version';

export const DEFAULT_HOOK_TIMEOUT_MS = 8000;

export class HookTimeoutError extends Error {
  constructor(ms: number) {
    super(`DNR: hook exceeded its ${ms} ms budget`);
    this.name = 'HookTimeoutError';
  }
}

export async function failOpen(
  hook: HookName,
  stdin: string,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string },
  fn: () => Promise<HookIO>,
): Promise<HookIO> {
  const env = opts.env ?? process.env;
  const ms = Number(env.DNR_HOOK_TIMEOUT_MS) || DEFAULT_HOOK_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HookTimeoutError(ms)), ms);
      timer.unref?.();
    });
    return await Promise.race([fn(), timeout]);
  } catch (e) {
    await logErrorOpen(hook, stdin, opts, e);
    return { ...OK };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function logErrorOpen(
  hook: HookName,
  stdin: string,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string },
  err: unknown,
): Promise<void> {
  const env = opts.env ?? process.env;
  try {
    let cwd = opts.cwd ?? process.cwd();
    let raw: unknown = null;
    try {
      const ev = parseHookEvent(stdin, cwd);
      cwd = ev.cwd;
      raw = ev.raw;
    } catch {
      raw = stdin.slice(0, 2000);
    }
    const repo = findRepoRoot(cwd) ?? cwd;
    const paths = resolvePaths(repo, env);
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    hookLog(paths.hookLog, `error_open hook=${hook} ${msg}`);
    if (env.DNR_DEBUG) process.stderr.write(`DNR debug: ${msg}\n${err instanceof Error ? err.stack : ''}\n`);
    let mode: 'enforce' | 'record' | 'warn-only' | 'commit-enforce' = 'enforce';
    const m = env.DNR_MODE;
    if (m === 'record' || m === 'warn-only' || m === 'commit-enforce') mode = m;
    await appendEvent(mode === 'record' ? paths.recordFile : paths.eventsFile, {
      event_id: newEventId(),
      at: nowIso(env),
      mode,
      hook,
      session_key: null,
      raw,
      target_rel: null,
      proposed_text: null,
      session_patch: null,
      decision: baseDecision({
        outcome: 'error_open',
        tier: 'none',
        breakdown: [{ error: msg.slice(0, 500) }],
      }),
      dnr_version: DNR_VERSION,
      kiro_cli_version: null,
    });
  } catch {
    // Nothing else to do: fail open regardless.
  }
}
