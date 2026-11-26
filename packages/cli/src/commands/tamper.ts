/**
 * `dnr tamper show` and `dnr tamper accept` (wave-3 N3). The persistent tamper flag opens when an
 * order is removed or weakened by anything other than a human-guarded command, or when the git
 * repository becomes unusable. It stays open across sessions. `accept` (human-only, R6) shows the
 * findings and the difference between the enforced union and the working copy, then makes the
 * working copy the new human-attested record and closes the flag.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { readTamper } from '@dnr/hook';
import { nowIso, writeAttested } from '@dnr/store';
import { parse, str } from '../args';
import { repoContext, requireHuman } from '../context';
import { EXIT, usage } from '../errors';
import type { CliIO } from '../io';

export async function cmdTamper(argv: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = argv;
  const { values: v } = parse(sub?.startsWith('-') ? [] : rest, {
    by: { type: 'string' },
    yes: { type: 'boolean' },
  });
  if (!sub || sub.startsWith('-')) {
    io.out(
      'dnr tamper show            list open tamper findings\ndnr tamper accept [--by]   accept the current working-copy orders as the human-attested record (humans only)\n',
    );
    return sub ? EXIT.OK : EXIT.USAGE;
  }
  if (sub === 'accept') requireHuman(io, 'tamper accept');
  const ctx = await repoContext(io);
  const flag = readTamper(ctx.store.paths.stateDir);
  const enforced = [...ctx.trusted.orders.values()];
  const working = ctx.trusted.sources.working;
  const diff: string[] = [];
  for (const o of enforced) {
    const w = working.get(o.id);
    if (!w) diff.push(`  ${o.id}: enforced as ${o.status}, missing from the working copy`);
    else if (w.status !== o.status)
      diff.push(`  ${o.id}: enforced as ${o.status}, working copy says ${w.status}`);
  }
  if (sub === 'show') {
    if (!flag && diff.length === 0) {
      io.out('DNR: no open tamper findings.\n');
      return EXIT.OK;
    }
    for (const f of flag?.findings ?? []) io.out(`${f.at}  ${f.what}\n`);
    if (diff.length) io.out(`Enforced union vs working copy:\n${diff.join('\n')}\n`);
    return flag ? EXIT.FINDINGS : EXIT.OK;
  }
  if (sub !== 'accept') throw usage(`dnr tamper: unknown subcommand ${sub}`);
  io.out(
    flag
      ? `Open tamper findings:\n${flag.findings.map((f) => `  ${f.at}  ${f.what}`).join('\n')}\n`
      : 'No open tamper findings.\n',
  );
  io.out(
    diff.length
      ? `Accepting makes the working copy authoritative:\n${diff.join('\n')}\n`
      : 'The working copy already matches the enforced orders.\n',
  );
  writeAttested(
    ctx.store.paths.attestedFile,
    [...working.values()],
    str(v.by) ?? io.env.USER ?? 'human',
    nowIso(io.env),
  );
  rmSync(join(ctx.store.paths.stateDir, 'tamper.json'), { force: true });
  await ctx.store.sessions.refreshOrdersHash(ctx.store.ordersHash());
  io.out(
    'DNR: accepted. The working-copy orders are now the human-attested record, and the tamper flag is closed.\n',
  );
  return EXIT.OK;
}
