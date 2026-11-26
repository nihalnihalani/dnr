/**
 * §9.3 order set per run: `$TRIAL_ROOT/orders/<run_id>/` holds only orders whose revert is an
 * ancestor of the run's start commit, built for every mined revert passing E1–E5 and E7, whatever
 * its role. Later reverts never reach the hook or the S steering.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Order } from '@dnr/schemas';
import { hashDir } from './home';
import { isAncestor } from './repo';

export interface OrderSetResult {
  dir: string;
  ids: string[];
  /** Pool reverts that are ancestors of start but have no order in the store yet (Phase 4). */
  missing: string[];
  approved: number;
  hash: string;
}

export async function buildOrderSet(input: {
  dir: string;
  gitDir: string;
  start: string;
  /** Revert SHAs eligible for an order (E1–E5, E7). */
  pool: ReadonlySet<string>;
  /** Extra revert SHAs whose order must be included when it is an ancestor (e.g. a SYN case's own order). */
  extra?: ReadonlySet<string>;
  orders: readonly Order[];
}): Promise<OrderSetResult> {
  await rm(input.dir, { recursive: true, force: true });
  await mkdir(input.dir, { recursive: true });
  const byRevert = new Map(input.orders.filter((o) => o.revert_sha).map((o) => [o.revert_sha as string, o]));
  const wanted = new Set([...input.pool, ...(input.extra ?? [])]);
  const ids: string[] = [];
  const missing: string[] = [];
  let approved = 0;
  for (const sha of [...wanted].sort()) {
    if (!(await isAncestor(input.gitDir, sha, input.start))) continue;
    const o = byRevert.get(sha);
    if (!o) {
      missing.push(sha);
      continue;
    }
    if (o.status === 'approved') approved++;
    await writeFile(join(input.dir, `${o.id}.json`), `${JSON.stringify(o, null, 2)}\n`);
    ids.push(o.id);
  }
  return { dir: input.dir, ids, missing, approved, hash: hashDir(input.dir) };
}
