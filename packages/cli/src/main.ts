/** `dnr` command dispatch (§8). Exit codes: 0 clean, 1 findings, 64 usage, 65 invalid data, 69 dependency missing, 70 internal. */

import { DNR_VERSION } from '@dnr/hook/version';
import { CliError, EXIT } from './errors';
import type { CliIO } from './io';

export const HELP = `dnr ${DNR_VERSION}: blocks agent writes that re-apply reverted changes

  dnr init [repo] [--mode …] [--decision-format deny|ask] [--hooks pre-write|all] [--crew] [--force]
  dnr doctor
  dnr scan [--branch] [--since] [--until] [--lang py,ts] [--fetch-tickets] [--out]
  dnr orders build|add|list|show|approve|retire|unretire|edit|reapprove|verify|refresh|relocate
  dnr draft [--order <id>|--all] [--orders <dir>] [--trial]
  dnr steering generate [--orders <dir>] [--out <path>]
  dnr check --stdin --hook kiro | --worktree [--hook stop] | --staged | --commit <sha> | --file <rel> --proposed <p> | --replay <events>
  dnr guard-shell --stdin
  dnr session start|confirm|shell-after|show|end|gc
  dnr allow <order_id> [--ttl 1h]
  dnr board [--port 4317] [--open <order_id>] [--host 127.0.0.1]
  dnr mcp
  dnr explain <file> <qualname>
  dnr export-case <revert> [--orders] [--git-dir] [--out]
  dnr demo
  dnr trial <subcommand>
`;

type Cmd = (argv: string[], io: CliIO) => Promise<number>;

// Commands load lazily so a hook invocation only evaluates the modules it needs (latency, R8).
const COMMANDS: Record<string, () => Promise<Cmd>> = {
  check: async () => (await import('./commands/check')).cmdCheck,
  'guard-shell': async () => (await import('./commands/session')).cmdGuardShell,
  session: async () => (await import('./commands/session')).cmdSession,
  allow: async () => (await import('./commands/session')).cmdAllow,
  orders: async () => (await import('./commands/orders')).cmdOrders,
  init: async () => (await import('./commands/init')).cmdInit,
  doctor: async () => (await import('./commands/doctor')).cmdDoctor,
  scan: async () => (await import('./commands/scan')).cmdScan,
  draft: async () => (await import('./commands/draft')).cmdDraft,
  steering: async () => (await import('./commands/steering')).cmdSteering,
  board: async () => (await import('./commands/board')).cmdBoard,
  mcp: async () => (await import('./commands/mcp')).cmdMcp,
  explain: async () => (await import('./commands/explain')).cmdExplain,
  'export-case': async () => (await import('./commands/export-case')).cmdExportCase,
  demo: async () => (await import('./commands/demo')).cmdDemo,
  trial: async () => (await import('./commands/trial')).cmdTrial,
};

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    io.out(HELP);
    return cmd ? EXIT.OK : EXIT.USAGE;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    io.out(`${DNR_VERSION}\n`);
    return EXIT.OK;
  }
  const load = COMMANDS[cmd];
  if (!load) {
    io.err(`dnr: unknown command ${cmd}\n${HELP}`);
    return EXIT.USAGE;
  }
  try {
    const fn = await load();
    return await fn(rest, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`${e.message}\n`);
      return e.code;
    }
    if ((e as Error)?.name === 'ZodError') {
      io.err(
        `DNR: invalid data: ${(e as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues?.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}\n`,
      );
      return EXIT.DATA;
    }
    if ((e as Error)?.name === 'ConfigError') {
      io.err(`${(e as Error).message}\n`);
      return EXIT.DATA;
    }
    if (/git executable not found|ENOENT.*git/.test(String((e as Error)?.message))) {
      io.err('DNR: git is not installed\n');
      return EXIT.DEPENDENCY;
    }
    io.err(`DNR: internal error: ${(e as Error)?.stack ?? String(e)}\n`);
    return EXIT.INTERNAL;
  }
}
