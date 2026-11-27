/**
 * The `BoardStorePort` adapter `dnr board` hands to `startBoard` (apps/board/src/store-port.ts),
 * backed by @dnr/store plus git for effective status, drift and the re-approve rebase.
 */
import { relative } from 'node:path';
import { catBlobs } from '@dnr/git';
import { type EffectiveStatus, grantOrigin, type HookContext, readTamper, readViolations } from '@dnr/hook';
import { Order } from '@dnr/schemas';
import {
  nowIso,
  nowMs,
  OrderNotFoundError,
  TransitionError as StoreTransitionError,
  serializeOrder,
} from '@dnr/store';
import { createPatch } from 'diff';
import { effectiveStatuses, rebaseOnHead } from './analysis';

export interface BoardErrors {
  TransitionError: new (m: string) => Error;
  NotFoundError: new (m: string) => Error;
}

/** Effective statuses that enforce, so an allow-once grant means something (§10 state table). */
export const ALLOW_ONCE = new Set<EffectiveStatus>(['approved', 'stale', 'relanded', 'violated']);

export function createBoardStore(ctx: HookContext, errors: BoardErrors) {
  const store = ctx.store;
  const ordersRel = relative(ctx.repoRoot, store.paths.ordersDir);
  const inRepo = !ordersRel.startsWith('..');

  async function committed(ids: string[]): Promise<Map<string, string | null>> {
    if (!inRepo || ids.length === 0) return new Map();
    const specs = ids.map((id) => `HEAD:${ordersRel}/${id}.json`);
    const m = await catBlobs(ctx.repoRoot, specs).catch(() => new Map<string, string | null>());
    return new Map(ids.map((id) => [id, m.get(`HEAD:${ordersRel}/${id}.json`) ?? null]));
  }

  async function rows(orders: Order[]) {
    const eff = await effectiveStatuses(ctx, orders);
    const git = await committed(orders.map((o) => o.id));
    const violations = readViolations(store.paths.stateDir);
    return orders.map((order) => {
      const g = git.get(order.id);
      const drift = g !== undefined && g !== null && JSON.stringify(JSON.parse(g)) !== JSON.stringify(order);
      const effective = (eff.get(order.id) ?? order.status) as EffectiveStatus;
      const v = violations[order.id];
      return {
        order,
        effective,
        drift,
        ...(effective === 'violated' && v ? { violation: { commit: v.commit, at: v.at } } : {}),
      };
    });
  }

  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StoreTransitionError) throw new errors.TransitionError(e.message);
      if (e instanceof OrderNotFoundError) throw new errors.NotFoundError(e.message);
      throw e;
    }
  };

  const getRow = async (id: string) => {
    const o = await store.orders.get(id);
    return o ? ((await rows([o]))[0] ?? null) : null;
  };
  const requireRow = async (id: string) => {
    const r = await getRow(id);
    if (!r) throw new errors.NotFoundError(`DNR: no order ${id}`);
    return r;
  };

  return {
    listOrders: async () => rows(await store.orders.list()),
    getOrder: getRow,
    patchOrder: (id: string, patch: { status?: Order['status']; reason?: string }, by: string) =>
      wrap(async () => {
        const at = nowIso(ctx.env);
        if (patch.reason !== undefined) {
          const reason = patch.reason.trim();
          if (!Order.shape.reason.safeParse(reason).success)
            throw new errors.TransitionError('reason must be 1–280 characters after trimming');
          await store.orders.editReason(id, reason, by, 'human', at);
        }
        if (patch.status !== undefined) {
          // A no-op transition is invalid too (checkTransition): 409, same as `dnr orders`.
          await store.orders.transition(id, patch.status, by, at);
        }
        return requireRow(id);
      }),
    reapprove: (id: string, by: string) =>
      wrap(async () => {
        const row = await requireRow(id);
        if (row.effective !== 'stale' && row.effective !== 'relanded' && row.effective !== 'violated')
          throw new errors.TransitionError(
            `DNR: ${id} is ${row.effective}; only stale or re-landed orders are re-approved`,
          );
        await store.orders.put(await rebaseOnHead(ctx, row.order, by, nowIso(ctx.env)));
        return requireRow(id);
      }),
    allowOnce: (id: string, ttlSeconds: number, by: string) =>
      wrap(async () => {
        const row = await requireRow(id);
        if (!ALLOW_ONCE.has(row.effective))
          throw new errors.TransitionError(
            `DNR: ${id} is ${row.effective}; only an enforced order can be allowed once`,
          );
        const at = nowMs(ctx.env);
        const origin = await grantOrigin({
          via: 'board',
          store,
          env: ctx.env,
          now: at,
          sessionTtlMinutes: ctx.config.session_ttl_minutes,
        });
        return store.grants.create({
          order_id: id,
          kind: 'allow_once',
          session_key: null,
          granted_by: by,
          ttl_ms: ttlSeconds * 1000,
          at,
          origin,
        });
      }),
    /** Wave-3 N5: confirm a suspect grant (the board's Confirm action; guarded at board launch). */
    confirmGrant: (orderId: string, sessionKey: string | null, by: string) =>
      wrap(async () => {
        const grants = (await store.grants.list(orderId)).filter(
          (g) => g.order_id === orderId && g.session_key === sessionKey,
        );
        if (grants.length === 0)
          throw new errors.NotFoundError(`DNR: no grant for ${orderId} and that session`);
        const [done] = await store.grants.confirm(orderId, sessionKey, by, nowIso(ctx.env));
        if (!done)
          throw new errors.TransitionError(
            `DNR: that grant for ${orderId} is not suspect or is already confirmed`,
          );
        return done;
      }),
    listGrants: (orderId?: string) => store.grants.list(orderId),
    /** The persistent tamper flag (wave-3 N3), shown as the board's tamper banner. */
    tamper: async () => readTamper(store.paths.stateDir),
    listEvents: (filter: { order?: string }) => store.readEvents(filter.order ? { order: filter.order } : {}),
    diff: (id: string) =>
      wrap(async () => {
        const file = await store.orders.require(id);
        const g = (await committed([id])).get(id) ?? null;
        let git: Order | null = null;
        if (g) {
          const r = Order.safeParse(JSON.parse(g));
          git = r.success ? r.data : null;
        }
        const unified = createPatch(
          `${ordersRel}/${id}.json`,
          g ?? '',
          serializeOrder(file),
          'git (HEAD)',
          'working copy',
        );
        return { file, git, unified };
      }),
  };
}
