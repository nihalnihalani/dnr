import { execFile } from 'node:child_process';

export interface GitOptions {
  /** Repository directory (passed as `git -C <dir>`). */
  cwd: string;
  /** Text written to stdin. */
  input?: string;
  /** Exit codes treated as success (default `[0]`). */
  okCodes?: number[];
  env?: NodeJS.ProcessEnv;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} exited ${code}: ${stderr.trim().slice(0, 500)}`);
    this.name = 'GitError';
  }
}

const MAX_BUFFER = 1024 * 1024 * 1024;

/**
 * Runs git with execFile (never a shell). The environment pins locale, disables
 * pagers, prompts and user/system config hooks that could change output.
 */
export function runGit(args: readonly string[], opts: GitOptions): Promise<GitResult> {
  const okCodes = opts.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', opts.cwd, '-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args],
      {
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...opts.env,
          LC_ALL: 'C',
          GIT_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
      (err, stdout, stderr) => {
        const errCode: unknown = err ? (err as { code?: unknown }).code : 0;
        if (errCode === 'ENOENT') {
          reject(new Error('git executable not found'));
          return;
        }
        const code = typeof errCode === 'number' ? errCode : err ? 1 : 0;
        if (!okCodes.includes(code)) {
          reject(new GitError(args, code, String(stderr)));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Runs git and returns stdout; throws GitError on a non-zero exit. */
export async function git(args: readonly string[], opts: GitOptions): Promise<string> {
  return (await runGit(args, opts)).stdout;
}
