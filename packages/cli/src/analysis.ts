/** Effective status (§5.9 stale / re-landed, derived at load) and snapshot rebase for re-approval. */
import { extractUnits, UnitCache, unitHash } from '@dnr/core';
import { headCommit } from '@dnr/git';
import {
  BlobReader,
  deriveStatus,
  type EffectiveStatus,
  effectiveStatus,
  filesOf,
  type HookContext,
  loadParser,
} from '@dnr/hook';
import type { Order } from '@dnr/schemas';

export async function effectiveStatuses(
  ctx: HookContext,
  orders: Order[],
): Promise<Map<string, EffectiveStatus>> {
  const out = new Map<string, EffectiveStatus>();
  const approved = orders.filter((o) => o.status === 'approved');
  for (const o of orders) out.set(o.id, o.status);
  if (approved.length === 0) return out;
  const parser = await loadParser();
  const cache = new UnitCache(parser);
  const reader = new BlobReader(ctx.repoRoot);
  await reader.prefetch(
    approved.flatMap((o) => filesOf(o).flatMap((f) => [`${o.snapshot_sha}:${f}`, `HEAD:${f}`])),
  );
  for (const o of approved) {
    try {
      const d = deriveStatus(
        o,
        (f) => reader.get(o.snapshot_sha, f),
        (f) => reader.get('HEAD', f),
        cache,
        ctx.config,
        ctx.store.paths.cacheDir,
      );
      out.set(o.id, effectiveStatus(o, d));
    } catch {
      out.set(o.id, o.status);
    }
  }
  return out;
}

/** Re-approve (§5.9): rebase the snapshot onto HEAD (post_revert hash and count), status approved. */
export async function rebaseOnHead(ctx: HookContext, order: Order, by: string, at: string): Promise<Order> {
  const head = await headCommit(ctx.repoRoot);
  if (!head) throw new Error('DNR: cannot re-approve on an unborn HEAD');
  const parser = await loadParser();
  const reader = new BlobReader(ctx.repoRoot);
  await reader.prefetch(filesOf(order).map((f) => `${head}:${f}`));
  const units = order.units.map((u) => {
    const text = reader.get(head, u.file);
    const tokens =
      text === null ? [] : (extractUnits(parser, u.file, text)?.units.get(u.qualname)?.tokens ?? []);
    return { ...u, post_revert_hash: unitHash(tokens), post_revert_token_count: tokens.length };
  });
  return {
    ...order,
    snapshot_sha: head,
    units,
    status: 'approved',
    history: [...order.history, { at, by, action: 'reapproved' }],
    updated_at: at,
  };
}
