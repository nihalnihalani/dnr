/**
 * `dnr board [--port 4317] [--open <id>] [--host 127.0.0.1]` (§10): human-only (R6 guard). Starts
 * the ui teammate's board server (`startBoard` from @dnr/board), writes `$DNR_STATE_DIR/board.json`
 * for guard-shell R7, and opens the launch URL. The launch URL holds the nonce and is never printed.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DNR_VERSION } from '@dnr/hook';
import { parse, str } from '../args';
import { packagePath } from '../assets';
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
 * Wave-2 H4 / wave-3 N7: the launch URL carries the single-use nonce, so it never goes in any
 * argv (`ps` shows argv to every same-user process). `dnr board` opens a 0600 HTML file in a 0700
 * temp dir. The file holds a one-shot loopback URL served by this process, not the nonce. The
 * first request to it redirects to the launch URL, then the file is deleted and the redirect
 * stops. Residual risk (documented): a same-user process that reads the file and requests the
 * one-shot URL before the browser does gets the nonce; the browser then shows an expired launch.
 */
export async function oneShotLaunch(
  launchUrl: string,
  ttlMs = 60_000,
): Promise<{ file: string; used: Promise<void>; remove: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'dnr-board-'));
  chmodSync(dir, 0o700);
  const file = join(dir, 'open.html');
  const token = randomBytes(24).toString('base64url');
  let resolveUsed: () => void = () => {};
  const used = new Promise<void>((r) => {
    resolveUsed = r;
  });
  let done = false;
  const server = createServer((req, res) => {
    if (!done && req.method === 'GET' && req.url === `/go/${token}`) {
      done = true;
      res.writeHead(302, {
        Location: launchUrl,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end();
      remove();
      resolveUsed();
      return;
    }
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const go = JSON.stringify(`http://127.0.0.1:${port}/go/${token}`);
  writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>DNR board</title><meta name="referrer" content="no-referrer"><script>location.replace(${go})</script><noscript>Enable JavaScript to open the DNR board.</noscript>\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  function remove(): void {
    rmSync(dir, { recursive: true, force: true });
    server.close();
    server.closeAllConnections();
  }
  const t = setTimeout(remove, ttlMs);
  t.unref?.();
  return { file, used, remove };
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
    'no-open': { type: 'boolean' },
  });
  if (v.help) {
    io.out('dnr board [--port 4317] [--open <order_id>] [--host 127.0.0.1] [--no-open]\n');
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
  // The built UI ships in the package at dist/ui (scripts-copy-assets.mjs). A missing build fails
  // loudly rather than serving the "UI not built" stub.
  const staticDir = io.boardStaticDir ?? packagePath('dist/ui');
  if (!existsSync(join(staticDir, 'index.html')))
    throw missingDependency(
      `DNR: the board UI is missing from this install (${join(staticDir, 'index.html')}). Reinstall dnr-guard, or run \`pnpm build\` in a checkout.`,
    );
  const handle = await start({
    staticDir,
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
  const launch = await oneShotLaunch(handle.launchUrl);
  // --no-open (SSH, headless): print the launch file's path instead. The file holds only the
  // one-shot loopback URL, never the nonce, so printing its path keeps N7.
  if (v['no-open']) io.out(`Open this file in your browser to sign in: ${launch.file}\n`);
  else (io.openBrowser ?? defaultOpen)(launch.file);
  try {
    await (io.untilExit ?? untilSignal)();
  } finally {
    launch.remove();
    await handle.close();
    await rm(boardFile, { force: true });
  }
  return EXIT.OK;
}
