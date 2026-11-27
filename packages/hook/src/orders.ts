/** Load approved orders for a set of ids with their derived stale/re-landed flags (§5.9). */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type OrderEntry, type OrderMaterial, type UnitMaterial, unitKey } from '@dnr/core';
import type { Order } from '@dnr/schemas';
import type { HookContext } from './context';
import { deriveStatus, filesOf, type UnitCache } from './engine';
import type { BlobReader } from './repo';
import { DNR_VERSION } from './version';
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
  const cTokens = new CTokenCache(ctx.store.paths.cacheDir);
  const entries: OrderEntry[] = orders.map((order) => {
    const d = deriveStatus(
      order,
      (f) => reader.get(order.snapshot_sha, f),
      (f) => reader.get('HEAD', f),
      cache,
      ctx.config,
      null, // no on-disk cache in the enforcement path: an agent could forge it (wave-2 C1)
    );
    const material = new LazyMaterial(() => orderMaterial(order, reader, cache, cTokens));
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
 * §5.16 material for one order. PR_u comes from the snapshot text through the shared in-process
 * UnitCache (deriveStatus has parsed the same text already). C_u comes from the C-side blob
 * through CTokenCache, so a warm lookup does not re-parse an unchanged file.
 */
function orderMaterial(
  order: Order,
  reader: BlobReader,
  cache: UnitCache,
  cTokens: CTokenCache,
): Map<string, UnitMaterial> {
  const out = new Map<string, UnitMaterial>();
  for (const u of order.units) {
    const snap = reader.get(order.snapshot_sha, u.file);
    const PR = snap === null ? [] : (cache.get(u.file, snap)?.units.get(u.qualname)?.tokens ?? []);
    let C: string[] = [];
    if (u.kind !== 'removed') {
      const ref = u.c_state_ref;
      const text = reader.get(ref.sha, ref.file);
      if (text !== null) {
        C =
          cTokens.get(text, ref.file, ref.qualname, u.A) ??
          cTokens.put(
            text,
            ref.file,
            ref.qualname,
            cache.get(ref.file, text)?.units.get(ref.qualname)?.tokens ?? [],
          );
      }
    }
    out.set(unitKey(u.file, u.qualname), { C, PR });
  }
  return out;
}

/**
 * C-side unit tokens keyed by the sha256 of the C blob's text, the path (it picks the grammar),
 * the qualname and the DNR version, in $DNR_STATE_DIR/cache/c-units.json. The state dir is a
 * protected path (write tools are denied, guard-shell refuses shell writes to it), and every hit
 * is checked: C_u must contain every token C added (the order's A for that unit), else the entry
 * is ignored and the blob is parsed again. It is used only for the move/rename lookup's C side,
 * never for the baseline or the proposed text.
 */
export class CTokenCache {
  private file: string;
  private data: Record<string, string[]> | null = null;
  private dirty = false;
  constructor(cacheDir: string) {
    this.file = join(cacheDir, 'c-units.json');
  }
  private load(): Record<string, string[]> {
    if (this.data) return this.data;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      this.data = j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, string[]>) : {};
    } catch {
      this.data = {};
    }
    return this.data;
  }
  private key(text: string, file: string, qualname: string): string {
    const h = createHash('sha256').update(text).digest('hex');
    return `${DNR_VERSION}\u0000${h}\u0000${file}\u0000${qualname}`;
  }
  get(text: string, file: string, qualname: string, added: readonly string[]): string[] | null {
    const hit = this.load()[this.key(text, file, qualname)];
    if (!Array.isArray(hit) || !hit.every((t) => typeof t === 'string')) return null;
    // Tamper check: every token C added must be in C_u (multiset containment).
    const count = new Map<string, number>();
    for (const t of hit) count.set(t, (count.get(t) ?? 0) + 1);
    for (const t of added) {
      const n = count.get(t) ?? 0;
      if (n === 0) return null;
      count.set(t, n - 1);
    }
    return hit;
  }
  put(text: string, file: string, qualname: string, tokens: string[]): string[] {
    const d = this.load();
    d[this.key(text, file, qualname)] = tokens;
    this.dirty = true;
    this.flush();
    return tokens;
  }
  flush(): void {
    if (!this.dirty || !this.data) return;
    try {
      // Bounded: keep the newest 256 entries.
      const keys = Object.keys(this.data);
      for (const k of keys.slice(0, Math.max(0, keys.length - 256))) delete this.data[k];
      mkdirSync(join(this.file, '..'), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch {}
  }
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
