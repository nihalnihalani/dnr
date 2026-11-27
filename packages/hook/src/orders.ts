/** Load approved orders for a set of ids with their derived stale/re-landed flags (§5.9). */
import { materialFromTexts, type OrderEntry, type OrderMaterial, type UnitMaterial } from '@dnr/core';
import type { Order } from '@dnr/schemas';
import type { HookContext } from './context';
import { deriveStatus, filesOf, type UnitCache } from './engine';
import type { BlobReader } from './repo';
import { readViolations, type Violation } from './violations';

export async function loadEntries(
  ctx: HookContext,
  ids: readonly string[],
  reader: BlobReader,
  cache: UnitCache,
  extraSpecs: readonly string[] = [],
): Promise<{ entries: OrderEntry[]; orders: Order[]; violated: Map<string, Violation> }> {
  const orders: Order[] = [];
  for (const id of ids) {
    const o = ctx.trusted.orders.get(id);
    if (o && o.status === 'approved') orders.push(o);
  }
  const specs = [...extraSpecs];
  for (const o of orders) {
    for (const f of filesOf(o)) specs.push(`${o.snapshot_sha}:${f}`, `HEAD:${f}`);
    // The C side of each unit (§5.16 material) comes from git objects, never from an on-disk cache.
    for (const u of o.units)
      if (u.kind !== 'removed') specs.push(`${u.c_state_ref.sha}:${u.c_state_ref.file}`);
  }
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
    const material = new LazyMaterial(() =>
      materialFromTexts(
        cache.provider,
        order,
        (f) => {
          const u = order.units.find((x) => x.c_state_ref.file === f);
          return u ? reader.get(u.c_state_ref.sha, f) : null;
        },
        (f) => reader.get(order.snapshot_sha, f),
      ),
    );
    return { order, stale: d.stale, relanded: d.relanded, material };
  });
  // Wave-3 N4: a re-land committed by an agent without a grant is `violated` and keeps enforcing.
  const violations = readViolations(ctx.store.paths.stateDir);
  const violated = new Map<string, Violation>();
  for (const e of entries) {
    const v = violations[e.order.id];
    if (v && e.relanded) {
      violated.set(e.order.id, v);
      e.relanded = false;
    }
  }
  return { entries, orders, violated };
}

/**
 * Order material (§5.16), parsed on first use. The engine only reads it when a covered unit is
 * missing from the proposed state (move/rename lookup) or proximity is on, so a plain write pays
 * nothing beyond the prefetched blobs.
 */
export class LazyMaterial implements OrderMaterial {
  private m: Map<string, UnitMaterial> | null = null;
  constructor(private readonly build: () => Map<string, UnitMaterial>) {}
  private get map(): Map<string, UnitMaterial> {
    if (!this.m) this.m = this.build();
    return this.m;
  }
  get size(): number {
    return this.map.size;
  }
  get(key: string): UnitMaterial | undefined {
    return this.map.get(key);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  forEach(cb: (value: UnitMaterial, key: string, map: ReadonlyMap<string, UnitMaterial>) => void): void {
    for (const [k, v] of this.map) cb(v, k, this);
  }
  entries(): MapIterator<[string, UnitMaterial]> {
    return this.map.entries();
  }
  keys(): MapIterator<string> {
    return this.map.keys();
  }
  values(): MapIterator<UnitMaterial> {
    return this.map.values();
  }
  [Symbol.iterator](): MapIterator<[string, UnitMaterial]> {
    return this.map[Symbol.iterator]();
  }
}
