/**
 * The two read-only MCP queries (§12.4). Neither ever returns A or R tokens.
 * - explain_function({file, qualname}) → {orders: [{id, effective_status, reason, links}]}
 * - list_orders_for_file({file}) → {orders: [{id, qualnames, reason}]}
 */
import { UnitCache } from '@dnr/core';
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

export interface ExplainResult {
  orders: Array<{ id: string; effective_status: EffectiveStatus; reason: string; links: Order['links'] }>;
}
export interface ListResult {
  orders: Array<{ id: string; qualnames: string[]; reason: string }>;
}

function normFile(f: string): string {
  return f.replace(/^\.\//, '').replace(/\\/g, '/');
}

async function statusOf(ctx: HookContext, orders: Order[]): Promise<Map<string, EffectiveStatus>> {
  const m = new Map<string, EffectiveStatus>(orders.map((o) => [o.id, o.status]));
  const approved = orders.filter((o) => o.status === 'approved');
  if (approved.length === 0) return m;
  try {
    const cache = new UnitCache(await loadParser());
    const reader = new BlobReader(ctx.repoRoot);
    await reader.prefetch(
      approved.flatMap((o) => filesOf(o).flatMap((f) => [`${o.snapshot_sha}:${f}`, `HEAD:${f}`])),
    );
    for (const o of approved) {
      const d = deriveStatus(
        o,
        (f) => reader.get(o.snapshot_sha, f),
        (f) => reader.get('HEAD', f),
        cache,
        ctx.config,
        ctx.store.paths.cacheDir,
      );
      m.set(o.id, effectiveStatus(o, d));
    }
  } catch {
    // No git or no grammar: report the stored status.
  }
  return m;
}

/** Orders that cover the unit (retired orders are omitted: they no longer apply). */
export async function explainFunction(
  ctx: HookContext,
  input: { file: string; qualname: string },
): Promise<ExplainResult> {
  const file = normFile(input.file);
  const orders = (await ctx.store.orders.list()).filter(
    (o) => o.status !== 'retired' && o.units.some((u) => u.file === file && u.qualname === input.qualname),
  );
  const st = await statusOf(ctx, orders);
  return {
    orders: orders.map((o) => ({
      id: o.id,
      effective_status: st.get(o.id) ?? o.status,
      reason: o.reason,
      links: o.links,
    })),
  };
}

export async function listOrdersForFile(ctx: HookContext, input: { file: string }): Promise<ListResult> {
  const file = normFile(input.file);
  const orders = (await ctx.store.orders.list()).filter(
    (o) => o.status !== 'retired' && o.units.some((u) => u.file === file),
  );
  return {
    orders: orders.map((o) => ({
      id: o.id,
      qualnames: [...new Set(o.units.filter((u) => u.file === file).map((u) => u.qualname))],
      reason: o.reason,
    })),
  };
}
