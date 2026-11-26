/**
 * `dnr board [--port 4317] [--open <id>] [--host 127.0.0.1]` (§10): human-only (R6 guard). Starts
 * the ui teammate's board server (`startBoard` from @dnr/board), writes `$DNR_STATE_DIR/board.json`
 * for guard-shell R7, and opens the launch URL. The launch URL holds the nonce and is never printed.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DNR_VERSION } from '@dnr/hook';
import { parse, str } from '../args';
import { createBoardStore } from '../board-store';
import { repoContext, requireHuman } from '../context';
import { EXIT, missingDependency, usage } from '../errors';
import type { CliIO } from '../io';

function defaultOpen(target: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [target], { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

/**
 * Wave-2 H4: the launch URL carries the single-use nonce, so it must not appear in any argv
 * (`ps` shows argv to every same-user process). Write it into a 0600 HTML file in a 0700 temp
 * dir that redirects, open that file, and delete it after first use (or on exit).
 */
export function writeLaunchFile(launchUrl: string): { file: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dnr-board-'));
  const file = join(dir, 'open.html');
  const u = JSON.stringify(launchUrl);
  writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>DNR board</title><meta name="referrer" content="no-referrer"><script>location.replace(${u})</script><noscript>Enable JavaScript to open the DNR board.</noscript>\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function untilSignal(): Promise<void> {
  return new Promise((res) => {
    const done = () => res();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

export async function cmdBoard(argv: string[], io: CliIO): Promise<number> {
  const { values: v } = parse(argv, {
    port: { type: 'string' },
    open: { type: 'string' },
    host: { type: 'string' },
  });
  if (v.help) {
    io.out('dnr board [--port 4317] [--open <order_id>] [--host 127.0.0.1]\n');
    return EXIT.OK;
  }
  const host = str(v.host);
  if (host && host !== '127.0.0.1') throw usage('dnr board: --host only accepts 127.0.0.1');
  requireHuman(io, 'board');
  const ctx = await repoContext(io);
  const port = v.port ? Number(v.port) : ctx.config.board_port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw usage('dnr board: --port must be 0–65535');
  let start = io.boardStarter;
  let errors = {
    TransitionError: Error as new (m: string) => Error,
    NotFoundError: Error as new (m: string) => Error,
  };
  if (!start) {
    try {
      const mod = await import('@dnr/board');
      start = mod.startBoard as unknown as NonNullable<CliIO['boardStarter']>;
      errors = { TransitionError: mod.TransitionError, NotFoundError: mod.NotFoundError };
    } catch (e) {
      throw missingDependency(
        `DNR: the board is not available in this build (${String((e as Error).message)})`,
      );
    }
  }
  const store = createBoardStore(ctx, errors);
  const handle = await start({
    store,
    version: DNR_VERSION,
    port,
    host: host === '127.0.0.1' ? '127.0.0.1' : 'auto',
    ...(v.open ? { openOrder: str(v.open) as string } : {}),
    user: io.env.USER ?? 'human',
  });
  const boardFile = ctx.store.paths.boardFile;
  await mkdir(dirname(boardFile), { recursive: true });
  await writeFile(
    boardFile,
    `${JSON.stringify({ port: handle.port, origin: handle.origin, pid: process.pid })}\n`,
  );
  io.out(`DNR board on ${handle.origin} (Ctrl-C to stop)\n`);
  const launch = writeLaunchFile(handle.launchUrl);
  (io.openBrowser ?? defaultOpen)(launch.file);
  // The browser reads the file within a moment; the nonce itself expires after 60 s and is single-use.
  const timer = setTimeout(launch.remove, 15_000);
  timer.unref?.();
  try {
    await (io.untilExit ?? untilSignal)();
  } finally {
    clearTimeout(timer);
    launch.remove();
    await handle.close();
    await rm(boardFile, { force: true });
  }
  return EXIT.OK;
}
