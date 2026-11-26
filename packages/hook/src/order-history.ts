/**
 * Order-set comparisons across git states (wave-3 N3): a commit, a reset/amend/update-ref or a
 * staged change must not delete or weaken an order unless the human-attested record agrees.
 */
import { relative, sep } from 'node:path';
import { catBlobs, runGit } from '@dnr/git';
import { Order } from '@dnr/schemas';
import { orderHash, readAttested } from '@dnr/store';
import type { HookContext } from './context';

function ordersRel(ctx: HookContext): string | null {
  const rel = relative(ctx.repoRoot, ctx.store.paths.ordersDir);
  return !rel || rel.startsWith('..') || rel.startsWith(sep) ? null : rel.split(sep).join('/');
}

/** Orders committed at `rev` (a commit id), or staged in the index when `rev` is ':'. */
export async function orderSetAt(ctx: HookContext, rev: string): Promise<Map<string, Order>> {
  const out = new Map<string, Order>();
  const dir = ordersRel(ctx);
  if (!dir) return out;
  const r =
    rev === ':'
      ? await runGit(['ls-files', '-z', '--', dir], { cwd: ctx.repoRoot, okCodes: [0, 128] })
      : await runGit(['ls-tree', '-r', '-z', '--name-only', rev, '--', dir], {
          cwd: ctx.repoRoot,
          okCodes: [0, 128],
        });
  if (r.code !== 0) return out;
  const paths = r.stdout
    .split('\0')
    .filter((p) => p.endsWith('.json') && !p.slice(dir.length + 1).includes('/'));
  const specs = paths.map((p) => (rev === ':' ? `:${p}` : `${rev}:${p}`));
  const blobs = await catBlobs(ctx.repoRoot, specs);
  for (const s of specs) {
    try {
      const o = Order.safeParse(JSON.parse(blobs.get(s) ?? 'null'));
      if (o.success) out.set(o.data.id, o.data);
    } catch {}
  }
  return out;
}

/**
 * Orders that are approved in `before` and missing, no longer approved, or stripped of units in
 * `after`, where the human-attested record does not hold `after`'s version.
 */
export function weakenedBetween(
  ctx: HookContext,
  before: Map<string, Order>,
  after: Map<string, Order>,
): string[] {
  const attested = readAttested(ctx.store.paths.attestedFile);
  const out: string[] = [];
  for (const [id, b] of before) {
    if (b.status !== 'approved') continue;
    const a = after.get(id);
    const units = (o: Order) => new Set(o.units.map((u) => `${u.file}\0${u.qualname}`));
    const weaker = a?.status !== 'approved' || [...units(b)].some((k) => !units(a).has(k));
    if (!weaker) continue;
    const att = attested?.orders[id];
    if (att && a && att.status === a.status && att.sha256 === orderHash(a)) continue; // a human decided this
    if (att && !a && att.status !== 'approved') continue;
    out.push(id);
  }
  return out;
}
