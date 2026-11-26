/**
 * The human-only guard for R6 subcommands (§5.10): `allow`, `board`, `init`, `orders
 * approve|retire|unretire|edit|reapprove`, `orders build` into the live order dir, `draft`,
 * `session end|gc`. It refuses when:
 *  - stdin or stdout is not a TTY;
 *  - a Kiro agent-context variable is set (provisional list until spike S8);
 *  - any ancestor process is `kiro-cli` (or the agent host);
 *  - the chain between this process and the nearest interactive shell holds a wrapper
 *    (`script`, `sh -c`, `bash -c`, `npx`, `npm`/`pnpm exec`, `env`, `node`, `xargs`, …).
 * A human terminal (login shell → dnr), including one spawned under node-pty, passes.
 */
import { execFileSync } from 'node:child_process';

export interface Proc {
  pid: number;
  ppid: number;
  command: string;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Variables present in an agent's hook/shell context but not in a human terminal. PROVISIONAL:
 * spike S8 freezes this list in hook-contracts.md (the Kiro IDE integrated terminal must pass).
 */
export const KIRO_AGENT_VARS = [
  'KIRO_SESSION_ID',
  'KIRO_AGENT',
  'KIRO_AGENT_ID',
  'KIRO_HOOK_EVENT',
  'KIRO_CLI_SESSION',
];

/** Ancestors that mean "an agent launched this" wherever they appear in the chain. */
const AGENT_HOSTS = [/(^|\/)kiro-cli([-\w]*)?(\s|$)/i, /(^|\/)kiro-agent(\s|$)/i];

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh', 'csh', 'nu', 'pwsh', 'login']);
const WRAPPERS = new Set([
  'script',
  'env',
  'npx',
  'npm',
  'pnpm',
  'pnpx',
  'yarn',
  'bunx',
  'bun',
  'node',
  'tsx',
  'deno',
  'xargs',
  'nohup',
  'timeout',
  'sudo',
  'doas',
  'expect',
  'python',
  'python3',
  'osascript',
  'make',
]);

function argv0(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return (first.split('/').pop() ?? first).replace(/^-/, '');
}

export function isAgentHost(command: string): boolean {
  return AGENT_HOSTS.some((re) => re.test(command));
}

/** A shell started with `-c` runs a command string: a wrapper, not an interactive shell. */
function shellWithC(command: string): boolean {
  return /\s-[a-z]*c[a-z]*(\s|$)/.test(command);
}

/** Pure check over a process chain (index 0 = the parent of this process). */
export function checkHuman(input: { chain: Proc[]; env: NodeJS.ProcessEnv; isTTY: boolean }): GuardResult {
  if (!input.isTTY)
    return { ok: false, reason: 'needs an interactive terminal (no TTY): run it yourself from a terminal' };
  const v = KIRO_AGENT_VARS.find((k) => input.env[k] !== undefined && input.env[k] !== '');
  if (v) return { ok: false, reason: `refused inside an agent session (${v} is set)` };
  const host = input.chain.find((p) => isAgentHost(p.command));
  if (host) return { ok: false, reason: `refused: an ancestor process is an agent (${argv0(host.command)})` };
  for (const p of input.chain) {
    const name = argv0(p.command);
    if (SHELLS.has(name)) {
      if (shellWithC(p.command)) return { ok: false, reason: `refused under a wrapper (${name} -c)` };
      return { ok: true }; // the nearest interactive shell: a human terminal
    }
    if (WRAPPERS.has(name))
      return { ok: false, reason: `refused under a wrapper (${name}); run \`dnr\` directly from a terminal` };
    return { ok: false, reason: `refused: launched by ${name}, not by an interactive shell` };
  }
  return { ok: false, reason: 'refused: no interactive shell among the ancestor processes' };
}

/** The ancestor chain of `pid` (parent first) from one `ps` call. */
export function processChain(pid = process.pid): Proc[] {
  let out = '';
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const byPid = new Map<number, Proc>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) byPid.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? '' });
  }
  const chain: Proc[] = [];
  let cur = byPid.get(pid)?.ppid ?? process.ppid;
  const seen = new Set<number>();
  while (cur > 1 && !seen.has(cur)) {
    seen.add(cur);
    const p = byPid.get(cur);
    if (!p) break;
    chain.push(p);
    cur = p.ppid;
  }
  return chain;
}

/** The real guard used by the CLI. */
export function humanGuard(env: NodeJS.ProcessEnv = process.env): GuardResult {
  return checkHuman({
    chain: processChain(),
    env,
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
  });
}
