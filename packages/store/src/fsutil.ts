/**
 * Filesystem primitives: atomic temp+rename writes and an O_EXCL lock file.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Write `data` to `path` atomically: write a sibling temp file, then rename over the target. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, data, { flag: 'wx' });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Read and JSON-parse a file, or return null when it does not exist. */
export async function readJsonOrNull(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export interface LockOptions {
  /** Give up after this many ms (default 3,000). */
  timeoutMs?: number;
  /** A lock file older than this is considered abandoned and removed (default 10,000). */
  staleMs?: number;
  /** Throw LockTimeoutError instead of breaking the lock at the timeout. */
  failOnTimeout?: boolean;
}

export class LockTimeoutError extends Error {
  constructor(readonly path: string) {
    super(`DNR: timed out waiting for lock ${path}`);
    this.name = 'LockTimeoutError';
  }
}

function tryAcquire(lockPath: string): boolean {
  try {
    // O_CREAT | O_EXCL: fails with EEXIST when another process holds the lock.
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

function lockIsStale(lockPath: string, staleMs: number): boolean {
  try {
    const st = statSync(lockPath);
    if (Date.now() - st.mtimeMs > staleMs) return true;
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }
    return false;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` while holding `<path>.lock` (created with O_EXCL). */
export async function withLock<T>(path: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const lockPath = `${path}.lock`;
  const timeout = opts.timeoutMs ?? 3000;
  const staleMs = opts.staleMs ?? 10_000;
  await mkdir(dirname(lockPath), { recursive: true });
  const start = Date.now();
  let delay = 2;
  while (!tryAcquire(lockPath)) {
    if (lockIsStale(lockPath, staleMs)) {
      try {
        unlinkSync(lockPath);
      } catch {}
      continue;
    }
    if (Date.now() - start > timeout) {
      // A lock held past the timeout is treated as abandoned or hostile (wave-2 C1): a lock file
      // must never be a way to make DNR fail open. Break it unless the caller asked to fail.
      if (opts.failOnTimeout) throw new LockTimeoutError(lockPath);
      try {
        unlinkSync(lockPath);
      } catch {}
      continue;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 50);
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}
