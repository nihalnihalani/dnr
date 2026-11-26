import { spawn } from 'node:child_process';
import { git } from './exec';

function firstId(out: string): string | null {
  const line = out.split('\n').find((l) => l.trim().length > 0);
  return line ? (line.split(/\s+/)[0] ?? null) : null;
}

async function patchIdOfDiff(repo: string, from: string, to: string): Promise<string | null> {
  const diff = await git(['diff', '--no-renames', '--no-ext-diff', '--no-prefix', '--full-index', from, to], {
    cwd: repo,
  });
  if (diff.trim().length === 0) return null;
  return firstId(await git(['patch-id', '--stable'], { cwd: repo, input: diff }));
}

/** Stable patch-id of the change `sha` introduces (first parent to sha). Null for empty diffs. */
export async function patchId(repo: string, sha: string): Promise<string | null> {
  return patchIdOfDiff(repo, `${sha}^`, sha);
}

/** Stable patch-id of the inverse of `sha` (sha to its first parent), as `git show -R` would produce. */
export async function inversePatchId(repo: string, sha: string): Promise<string | null> {
  return patchIdOfDiff(repo, sha, `${sha}^`);
}

export interface PatchIdIndex {
  /** commit sha to forward patch-id */
  forward: Map<string, string>;
  /** commit sha to inverse patch-id */
  inverse: Map<string, string>;
}

function parseStream(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [pid, sha] = line.trim().split(/\s+/);
    if (pid && sha) m.set(sha, pid);
  }
  return m;
}

function pipePatchIds(repo: string, logArgs: string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, LC_ALL: 'C', GIT_PAGER: 'cat', GIT_CONFIG_NOSYSTEM: '1' };
    const log = spawn('git', ['-C', repo, '-c', 'color.ui=false', ...logArgs], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = spawn('git', ['-C', repo, 'patch-id', '--stable'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    log.stdout.pipe(pid.stdin);
    let out = '';
    let err = '';
    pid.stdout.setEncoding('utf8').on('data', (d: string) => {
      out += d;
    });
    log.stderr.setEncoding('utf8').on('data', (d: string) => {
      err += d;
    });
    let pending = 2;
    let failed = false;
    const done = (code: number | null, who: string) => {
      if (code !== 0 && !failed) {
        failed = true;
        reject(new Error(`${who} exited ${code}: ${err.slice(0, 500)}`));
      }
      if (--pending === 0 && !failed) resolve(parseStream(out));
    };
    log.on('error', reject);
    pid.on('error', reject);
    log.on('close', (c) => done(c, 'git log'));
    pid.on('close', (c) => done(c, 'git patch-id'));
  });
}

/**
 * Forward and inverse stable patch-ids for every non-merge commit reachable from `ref`,
 * computed in two streaming passes (`git log -p | git patch-id --stable`), never buffering the log.
 */
export async function patchIdIndex(repo: string, ref: string): Promise<PatchIdIndex> {
  // --no-prefix: with -R git swaps the a/ b/ prefixes, which changes the patch-id.
  const base = [
    'log',
    '--no-merges',
    '-p',
    '--no-renames',
    '--no-ext-diff',
    '--no-prefix',
    '--full-index',
    '--format=commit %H',
  ];
  const forward = await pipePatchIds(repo, [...base, ref]);
  const inverse = await pipePatchIds(repo, [...base, '-R', ref]);
  return { forward, inverse };
}
