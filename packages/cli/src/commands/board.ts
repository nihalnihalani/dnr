/**
 * `dnr board [--port 4317] [--open <id>] [--host 127.0.0.1]` (§10): human-only (R6 guard). Starts
 * the ui teammate's board server (`startBoard` from @dnr/board), writes `$DNR_STATE_DIR/board.json`
 * for guard-shell R7, and opens the launch URL. The launch URL holds the nonce and is never printed.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DNR_VERSION } from '@dnr/hook';
import { parse, str } from '../args';
import { createBoardStore } from '../board-store';
import { repoContext, requireHuman } from '../context';
import { EXIT, missingDependency, usage } from '../errors';
import type { CliIO } from '../io';

function defaultOpen(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {}
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
  (io.openBrowser ?? defaultOpen)(handle.launchUrl);
  try {
    await (io.untilExit ?? untilSignal)();
  } finally {
    await handle.close();
    await rm(boardFile, { force: true });
  }
  return EXIT.OK;
}
