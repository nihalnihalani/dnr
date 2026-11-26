/**
 * Session plumbing for the hook (plan §5.7, §5.11): repo discovery without spawning git, the
 * temp-index baseline snapshot, tree diffs and batched blob reads.
 * Added by the hook/CLI workstream; nothing here edits the real index or the working tree.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { git, runGit } from './exec';

/** Walk up from `cwd` to the directory holding `.git` (dir or file). No git process. */
export function findRepoRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** `git rev-parse --git-path <name>` resolved to an absolute path. */
export async function gitPath(repo: string, name: string): Promise<string> {
  const out = (await git(['rev-parse', '--git-path', name], { cwd: repo })).trim();
  return resolve(repo, out);
}

/**
 * Snapshot the working tree (tracked + untracked, respecting .gitignore) as a tree object, without
 * touching the real index (§5.7). The temp index is seeded from the real one so git only
 * rehashes changed files; an unborn HEAD (no index yet) starts from an empty index.
 */
export async function snapshotTree(repo: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'dnr-idx-'));
  const tmp = join(d, 'index');
  try {
    const real = await gitPath(repo, 'index');
    if (existsSync(real) && statSync(real).size > 0) await copyFile(real, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    await runGit(['add', '-A'], { cwd: repo, env });
    return (await git(['write-tree'], { cwd: repo, env })).trim();
  } finally {
    await rm(d, { recursive: true, force: true });
  }
}

/** Paths that differ between two tree-ish objects (no rename detection). */
export async function treeDiffNames(repo: string, a: string, b: string): Promise<string[]> {
  const out = await git(['diff-tree', '-r', '--no-renames', '-z', '--name-only', a, b], { cwd: repo });
  return out.split('\0').filter((p) => p.length > 0);
}

/** Paths staged relative to HEAD (or to the empty tree on an unborn HEAD). */
export async function stagedPaths(repo: string): Promise<string[]> {
  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd: repo,
    okCodes: [0, 1, 128],
  });
  const base = head.code === 0 ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const out = await git(['diff', '--cached', '--no-renames', '-z', '--name-only', base], { cwd: repo });
  return out.split('\0').filter((p) => p.length > 0);
}

/**
 * Read many blobs in one `git cat-file --batch` process. Each spec is `<rev>:<path>` (or
 * `:<path>` for the index). Returns spec → UTF-8 text, or null when missing.
 */
export function catBlobs(repo: string, specs: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unique = [...new Set(specs)];
  if (unique.length === 0) return Promise.resolve(out);
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      ['-C', repo, 'cat-file', '--batch'],
      {
        encoding: 'buffer',
        maxBuffer: 1024 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' },
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const buf = stdout as Buffer;
        let pos = 0;
        for (const spec of unique) {
          const nl = buf.indexOf(10, pos);
          if (nl < 0) {
            out.set(spec, null);
            continue;
          }
          const header = buf.subarray(pos, nl).toString('utf8');
          pos = nl + 1;
          const parts = header.split(' ');
          if (parts.length === 3 && /^\d+$/.test(parts[2] as string)) {
            const size = Number(parts[2]);
            const type = parts[1];
            out.set(spec, type === 'blob' ? buf.subarray(pos, pos + size).toString('utf8') : null);
            pos += size + 1;
          } else {
            out.set(spec, null); // "<spec> missing" / "ambiguous"
          }
        }
        resolvePromise(out);
      },
    );
    // git can exit before reading stdin (a missing repo, a bad object store): EPIPE is then
    // reported through the exec callback, never as an unhandled stream error.
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${unique.join('\n')}\n`);
  });
}

/** Full SHA of HEAD, or null on an unborn branch. */
export async function headCommit(repo: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
    cwd: repo,
    okCodes: [0, 1, 128],
  });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Resolve a revision to a full commit SHA without throwing (null when it does not resolve). */
export async function tryResolve(repo: string, rev: string): Promise<string | null> {
  if (rev.startsWith('-')) return null;
  // `:/<regex>` takes the rest of the string as the regex, so `^{commit}` cannot be appended.
  const spec = rev.startsWith(':/') ? rev : `${rev}^{commit}`;
  const r = await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', spec], {
    cwd: repo,
    okCodes: [0, 1, 128],
  });
  const s = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(s) ? s : null;
}

/** Commits in a revision range (`A..B`, `A...B`), newest first. Empty when the range does not resolve. */
export async function revList(repo: string, range: string): Promise<string[]> {
  const r = await runGit(['rev-list', '--end-of-options', range], { cwd: repo, okCodes: [0, 128] });
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/** `git log -1 --format=...` fields of a commit. */
export async function commitInfo(
  repo: string,
  sha: string,
): Promise<{ sha: string; committed_at: string; subject: string; body: string }> {
  const out = await git(['log', '-1', '--format=%H%x1f%cI%x1f%s%x1f%b', sha], { cwd: repo });
  const [h, at, subject, body] = out.replace(/\n$/, '').split('\x1f');
  return { sha: h ?? sha, committed_at: at ?? '', subject: subject ?? '', body: body ?? '' };
}

/** `remote.origin.url` as an https GitHub base (`https://github.com/o/r`), or null. */
export async function githubBase(repo: string): Promise<string | null> {
  const r = await runGit(['config', '--get', 'remote.origin.url'], { cwd: repo, okCodes: [0, 1] });
  const url = r.stdout.trim();
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

const gitMemo = new Map<string, ReturnType<typeof runGit>>();

/**
 * Run a read-only git command once per process: a caller can start it early (the write hook
 * starts `ls-tree HEAD` before its modules load) and a later caller gets the same promise.
 */
export function memoGit(
  repo: string,
  args: readonly string[],
  okCodes: number[] = [0],
): ReturnType<typeof runGit> {
  const k = `${repo}\0${args.join('\0')}\0${okCodes.join(',')}`;
  let p = gitMemo.get(k);
  if (!p) {
    p = runGit(args, { cwd: repo, okCodes });
    p.catch(() => {});
    gitMemo.set(k, p);
  }
  return p;
}

/** The `ls-tree` arguments DNR uses to read committed orders and config (shared by prefetch and loader). */
export function committedStateArgs(scope: readonly string[]): string[] {
  return ['ls-tree', '-r', '-z', 'HEAD', '--', ...scope];
}
