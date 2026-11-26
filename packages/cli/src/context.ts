import { findRepoRoot } from '@dnr/git';
import { type HookContext, openContext } from '@dnr/hook';
import { CliError, EXIT } from './errors';
import type { CliIO } from './io';

/** Open the hook context for the repo containing `cwd`, with optional store overrides. */
export async function repoContext(
  io: CliIO,
  opts: { orders?: string; config?: string; cwd?: string } = {},
): Promise<HookContext> {
  const cwd = opts.cwd ?? io.cwd;
  const env = { ...io.env };
  if (opts.orders) env.DNR_ORDERS = opts.orders;
  if (opts.config) env.DNR_CONFIG = opts.config;
  if (!findRepoRoot(cwd)) throw new CliError(`DNR: ${cwd} is not inside a git repository`, EXIT.USAGE);
  const ctx = await openContext(cwd, env);
  if (!ctx) throw new CliError(`DNR: ${cwd} is not inside a git repository`, EXIT.USAGE);
  return ctx;
}

export function requireHuman(io: CliIO, what: string): void {
  const g = io.guard();
  if (!g.ok)
    throw new CliError(
      `DNR: \`dnr ${what}\` ${g.reason}. Only a human maintainer can run it, from their own terminal.`,
      EXIT.USAGE,
    );
}
