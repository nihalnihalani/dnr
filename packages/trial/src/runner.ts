/**
 * The agent runner: `KiroRunner` shells out to kiro-cli (§9.3 command) in its own process group
 * with the in-process 600 s timer. There is no simulated runner: a dry run skips the agent call
 * and records "agent not run" (AGENTS.md: no mocks, no seeded data).
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';

export interface AgentRunInput {
  workdir: string;
  home: string;
  agent: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  /** Extra environment for the agent process (DNR_* for hooks). */
  env: Record<string, string>;
}

export interface AgentRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  transcript: string;
  stderr: string;
  cliVersion: string;
  startedAt: string;
  endedAt: string;
  /** Spawn failed (binary missing, permission): always an infrastructure failure. */
  spawnError: string | null;
}

export interface AgentRunner {
  readonly name: string;
  version(home: string): Promise<string>;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

/** Environment passed to the agent: a small allowlist plus HOME and the run's DNR_* variables. */
export function agentEnv(
  base: NodeJS.ProcessEnv,
  home: string,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'KIRO_API_KEY', 'USER', 'LOGNAME', 'SHELL'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (base[k] !== undefined) env[k] = base[k];
  return { ...env, HOME: home, ...extra };
}

export interface SpawnResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  spawnError: string | null;
}

/**
 * Spawns `cmd` detached (its own process group) and kills the whole group when the timer fires:
 * SIGTERM, then SIGKILL 5 s later. No GNU `timeout` (§9.3).
 */
export function spawnGroup(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string; graceMs?: number },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const done = (r: SpawnResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      done({ code: null, signal: null, timedOut: false, stdout: '', stderr: '', spawnError: String(e) });
      return;
    }
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), opts.graceMs ?? 5000).unref();
    }, opts.timeoutMs);
    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.stderr?.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: null, signal: null, timedOut, stdout: out, stderr: err, spawnError: e.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Whatever the leader did, make sure no group member survives it.
      killGroup('SIGKILL');
      done({ code, signal, timedOut, stdout: out, stderr: err, spawnError: null });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** The real runner: `kiro-cli chat --v3 --no-interactive --trust-all-tools --model <pin> --agent trial-<arm> --output-format stream-json "<task>"`. */
export class KiroRunner implements AgentRunner {
  readonly name = 'kiro-cli';
  constructor(
    private readonly bin = 'kiro-cli',
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  args(i: Pick<AgentRunInput, 'model' | 'agent' | 'prompt'>): string[] {
    return [
      'chat',
      '--v3',
      '--no-interactive',
      '--trust-all-tools',
      '--model',
      i.model,
      '--agent',
      i.agent,
      '--output-format',
      'stream-json',
      i.prompt,
    ];
  }

  version(home: string): Promise<string> {
    return new Promise((resolve) => {
      execFile(this.bin, ['--version'], { env: agentEnv(this.baseEnv, home, {}), timeout: 30_000 }, (e, so) =>
        resolve(e ? `unavailable: ${(e as Error).message.split('\n')[0]}` : so.trim()),
      );
    });
  }

  async run(i: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    const r = await spawnGroup(this.bin, this.args(i), {
      cwd: i.workdir,
      env: agentEnv(this.baseEnv, i.home, i.env),
      timeoutMs: i.timeoutMs,
    });
    return {
      exitCode: r.code,
      signal: r.signal,
      timedOut: r.timedOut,
      transcript: r.stdout,
      stderr: r.stderr,
      cliVersion: '',
      startedAt,
      endedAt: new Date().toISOString(),
      spawnError: r.spawnError,
    };
  }
}
