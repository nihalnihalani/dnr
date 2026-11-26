/** Load approved orders for a set of ids with their derived stale/re-landed flags (§5.9). */
import type { OrderEntry } from '@dnr/core';
import type { Order } from '@dnr/schemas';
import type { HookContext } from './context';
import { deriveStatus, filesOf, type UnitCache } from './engine';
import type { BlobReader } from './repo';

export async function loadEntries(
  ctx: HookContext,
  ids: readonly string[],
  reader: BlobReader,
  cache: UnitCache,
  extraSpecs: readonly string[] = [],
): Promise<{ entries: OrderEntry[]; orders: Order[] }> {
  const orders: Order[] = [];
  for (const id of ids) {
    const o = ctx.trusted.orders.get(id);
    if (o && o.status === 'approved') orders.push(o);
  }
  const specs = [...extraSpecs];
  for (const o of orders) for (const f of filesOf(o)) specs.push(`${o.snapshot_sha}:${f}`, `HEAD:${f}`);
  await reader.prefetch(specs);
  const entries: OrderEntry[] = orders.map((order) => {
    const d = deriveStatus(
      order,
      (f) => reader.get(order.snapshot_sha, f),
      (f) => reader.get('HEAD', f),
      cache,
      ctx.config,
      null, // no on-disk cache in the enforcement path: an agent could forge it (wave-2 C1)
    );
    return { order, stale: d.stale, relanded: d.relanded };
  });
  return { entries, orders };
}
