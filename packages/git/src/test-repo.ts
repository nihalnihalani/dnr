/** Test helper: small synthetic git repos in a temp dir with fixed identities and dates. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TestRepo {
  dir: string;
  git(...args: string[]): string;
  write(path: string, text: string): void;
  /** Commits all changes; returns the new SHA. `day` sets a deterministic date (2021-01-<day>). */
  commit(message: string, day?: number): string;
  cleanup(): void;
}

let clock = 0;

export function makeRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), 'dnr-git-test-'));
  const env = (date: string) => ({
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@invalid',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: dir,
  });
  const run = (args: string[], date = '2021-01-01T00:00:00Z') =>
    execFileSync('git', ['-C', dir, ...args], { env: env(date), encoding: 'utf8' });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'commit.gpgsign', 'false']);
  return {
    dir,
    git: (...args) => run(args),
    write(path, text) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    },
    commit(message, day) {
      clock++;
      const d = day ?? clock;
      const date = new Date(Date.UTC(2021, 0, 1, 0, 0, 0) + (d - 1) * 86400000 + clock * 1000).toISOString();
      run(['add', '-A']);
      run(['commit', '-q', '--allow-empty', '-m', message], date);
      return run(['rev-parse', 'HEAD']).trim();
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Commits `git revert --no-edit <sha>` with a custom message; returns the new SHA. */
export function revertCommit(r: TestRepo, sha: string, message: string): string {
  r.git('revert', '--no-commit', sha);
  return r.commit(message);
}

export function lines(n: number, f: (i: number) => string): string {
  return `${Array.from({ length: n }, (_, i) => f(i + 1)).join('\n')}\n`;
}
