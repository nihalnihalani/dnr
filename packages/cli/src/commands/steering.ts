/** `dnr steering generate [--orders <dir>] [--out <path>]` (§12.2): advisory history steering. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Order } from '@dnr/schemas';
import { parse, str } from '../args';
import { repoContext } from '../context';
import { EXIT, usage } from '../errors';
import type { CliIO } from '../io';

export function renderSteering(orders: Order[]): string {
  const lines = [
    '---',
    'inclusion: always',
    '---',
    '# Reverted changes in this repository (DNR history)',
    '',
    'These changes were made, then reverted. Do not re-introduce them. Before editing one of these functions, read why it was reverted. Steering advises; hooks enforce.',
    '',
  ];
  if (orders.length === 0) lines.push('No approved orders yet.', '');
  for (const o of [...orders].sort((a, b) => a.id.localeCompare(b.id))) {
    const units = [...new Set(o.units.map((u) => `\`${u.file}\` ${u.qualname}`))];
    lines.push(`## ${o.id}`, '', `- Why it was reverted: ${o.reason}`, `- Covers: ${units.join('; ')}`);
    for (const l of o.links) lines.push(`- ${l.rel[0]?.toUpperCase()}${l.rel.slice(1)}: ${l.url}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function cmdSteering(argv: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = argv;
  const { values: v } = parse(rest, { orders: { type: 'string' }, out: { type: 'string' } });
  if (sub !== 'generate' || v.help) {
    io.out('dnr steering generate [--orders <dir>] [--out <path>]\n');
    if (sub && sub !== 'generate' && !sub.startsWith('-'))
      throw usage(`dnr steering: unknown subcommand ${sub}`);
    return sub ? EXIT.OK : EXIT.USAGE;
  }
  const ctx = await repoContext(io, v.orders ? { orders: resolve(io.cwd, str(v.orders) as string) } : {});
  const orders = (await ctx.store.orders.list()).filter((o) => o.status === 'approved');
  const out = v.out
    ? resolve(io.cwd, str(v.out) as string)
    : join(ctx.repoRoot, '.kiro', 'steering', 'dnr-history.md');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderSteering(orders));
  io.out(`DNR: steering for ${orders.length} approved order(s) written to ${out}\n`);
  return EXIT.OK;
}
