/**
 * Grant provenance (wave-2 C3/H4, wave-3 N5; lead decisions). A same-OS-user agent cannot be fully
 * stopped from forging a human approval, so every grant records how it was made and what the
 * creating process looked like. Suspicion is about **how that process was launched**, not about
 * whether some Kiro session happens to be open, so a human in their own terminal is not flagged:
 *  - an ancestor is kiro-cli or another agent host;
 *  - a Kiro agent-context variable is set;
 *  - there is no controlling TTY;
 *  - the interactive shell above `dnr` was not started by a known terminal host, login, sshd,
 *    tmux/screen or a pty host (a double-forked daemon that opened its own pty shows up here);
 *  - the environment looks cleared (no HOME, USER or TERM).
 * A suspect grant does not apply until a human confirms it (`dnr allow --confirm`, the board).
 */
import type { Grant } from '@dnr/schemas';
import type { Store } from '@dnr/store';
import { isAgentHost, KIRO_AGENT_VARS, type Proc, processChain } from './ancestry';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh', 'csh', 'nu', 'pwsh']);
/** Processes that legitimately start a human's interactive shell. */
const TERMINAL_HOSTS =
  /^(login|sshd|tmux|tmux: server|screen|Terminal|iTerm2|iTermServer.*|Warp|wezterm.*|alacritty|kitty|ghostty|Hyper|Code Helper.*|Cursor Helper.*|Kiro Helper.*|Electron|gnome-terminal.*|konsole|xterm|urxvt|foot|terminator|tilix|mosh-server|node)$/;

function name(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return (first.split('/').pop() ?? first).replace(/^-/, '');
}

/** Agent markers for the creating process (pure; the chain is parent-first). */
export function launchMarkers(input: { chain: Proc[]; env: NodeJS.ProcessEnv; isTTY: boolean }): string[] {
  const markers: string[] = [];
  for (const k of KIRO_AGENT_VARS) if (input.env[k]) markers.push(`env:${k}`);
  for (const p of input.chain) if (isAgentHost(p.command)) markers.push(`ancestor:${name(p.command)}`);
  if (!input.isTTY) markers.push('no-tty');
  if (!input.env.HOME || !input.env.USER || !input.env.TERM) markers.push('cleared-env');
  const shellAt = input.chain.findIndex(
    (p) => SHELLS.has(name(p.command)) && !/\s-[a-z]*c[a-z]*(\s|$)/.test(p.command),
  );
  if (shellAt >= 0) {
    const host = input.chain[shellAt + 1];
    // pid 1 directly above the shell means it was re-parented (double fork), unless it is a
    // login shell started by launchd itself (macOS Terminal's login sessions go through `login`).
    if (!host) markers.push('shell-without-parent');
    else if (host.pid === 1 || !TERMINAL_HOSTS.test(name(host.command)))
      markers.push(`shell-host:${name(host.command)}`);
  }
  return [...new Set(markers)];
}

export async function grantOrigin(input: {
  via: NonNullable<Grant['origin']>['via'];
  store?: Store;
  env: NodeJS.ProcessEnv;
  now?: number;
  sessionTtlMinutes?: number;
  isTTY?: boolean;
  chain?: Proc[];
}): Promise<NonNullable<Grant['origin']>> {
  if (input.via === 'ask') return { via: 'ask', suspect: false, markers: [] };
  const markers = launchMarkers({
    chain: input.chain ?? processChain(),
    env: input.env,
    isTTY: input.isTTY ?? (!!process.stdin.isTTY && !!process.stdout.isTTY),
  });
  return { via: input.via, suspect: markers.length > 0, markers };
}

/**
 * Known test harnesses that drive `dnr` through a pty (node-pty under vitest, Playwright, or a
 * tsx-run demo script). A pty they spawn passes the R6 guard like a human terminal, so approvals
 * record which harness it was: an approval made that way is never a maintainer's.
 */
const HARNESSES: Array<[string, RegExp]> = [
  ['vitest', /(^|[/\s])vitest([/\s.]|$)/],
  ['playwright', /(^|[/\s])(playwright|@playwright)([/\s]|$)/],
  ['jest', /(^|[/\s])jest([/\s.]|$)/],
  ['tsx', /(^|[/\s])tsx([/\s]|$)/],
  ['node-pty', /node-pty/],
];

/** The first known test harness among the ancestors above the interactive shell, else null. */
export function testHarness(chain: readonly Proc[]): string | null {
  for (const p of chain) for (const [label, re] of HARNESSES) if (re.test(p.command)) return label;
  return null;
}

/** Provenance of a CLI approval (order history `origin`). */
export function approvalOrigin(input: { env: NodeJS.ProcessEnv; isTTY?: boolean; chain?: Proc[] }): {
  via: 'cli';
  markers: string[];
  harness: string | null;
} {
  const chain = input.chain ?? processChain();
  const markers = launchMarkers({
    chain,
    env: input.env,
    isTTY: input.isTTY ?? (!!process.stdin.isTTY && !!process.stdout.isTTY),
  });
  const harness = testHarness(chain);
  if (harness) markers.push(`harness:${harness}`);
  return { via: 'cli', markers, harness };
}
