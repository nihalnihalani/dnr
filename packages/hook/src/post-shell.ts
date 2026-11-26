/**
 * The structural guard behind guard-shell (wave-2 H3): guard-shell cannot enumerate every way a
 * shell can re-apply a change, so right after every shell call `dnr session shell-after`
 *  1. scores the files the agent touched against the session baseline (the Stop check, now
 *     immediate), and
 *  2. when HEAD moved during the call, runs the crossing check (`dnr check --commit`) on each new
 *     commit, which catches `git cherry-pick` and other commits that skip the pre-commit hook.
 * A finding is reported once per (order, state) with a Stop-style "undo it, tell the user" text.
 */
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { commitInfo, headCommit, isAncestor, revList } from '@dnr/git';
import type { Grant, Order, Session } from '@dnr/schemas';
import { checkCommit } from './commit';
import type { HookContext } from './context';
import { cap } from './messages';
import { orderSetAt, weakenedBetween } from './order-history';
import { scoreTouched } from './stop';
import { openTamper } from './trusted';
import { recordViolation } from './violations';

export interface PostShellFinding {
  kind: 'worktree' | 'commit' | 'orders';
  /** For kind 'orders': the weakened order ids and how HEAD moved. */
  weakened?: string[];
  how?: string;
  order: Order;
  qualnames: string[];
  edit: number;
  commit?: string;
}

function readShellHead(ctx: HookContext, key: string): string | null {
  const f = join(ctx.store.paths.stateDir, 'shell-heads', `${key}.json`);
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as { head?: unknown };
    rmSync(f, { force: true });
    return typeof j.head === 'string' ? j.head : null;
  } catch {
    return null;
  }
}

function worktreeState(hit: { order: Order; edit: number }, s: Session): string {
  return createHash('sha256')
    .update(hit.order.id)
    .update(String(hit.edit))
    .update(s.touched.join('\n'))
    .digest('hex');
}

export async function postShellCheck(ctx: HookContext, s: Session): Promise<PostShellFinding | null> {
  const granted = new Set(
    (await ctx.store.grants.applying(s, ctx.now()).catch(() => [] as Grant[])).map((g) => g.order_id),
  );
  const mark = (k: string) => {
    const m = `post-shell:${createHash('sha256').update(k).digest('hex').slice(0, 16)}`;
    if (s.warned.includes(m)) return false;
    s.warned.push(m);
    return true;
  };

  // 2. Commits made during the call.
  const before = readShellHead(ctx, s.session_key);
  const head = await headCommit(ctx.repoRoot);
  // Wave-3 N3: a reset/amend/update-ref (HEAD moved to a non-descendant) or a commit that deletes
  // or weakens an order without a human-attested record opens the persistent tamper flag.
  if (head && before && head !== before) {
    const ff = await isAncestor(ctx.repoRoot, before, head).catch(() => false);
    const beforeSet = await orderSetAt(ctx, before);
    const weakened = weakenedBetween(ctx, beforeSet, await orderSetAt(ctx, head));
    if (weakened.length) {
      const how = ff
        ? `a commit (${head.slice(0, 10)})`
        : `HEAD moving from ${before.slice(0, 10)} to ${head.slice(0, 10)} (reset, amend or update-ref)`;
      openTamper(
        ctx.store.paths.stateDir,
        weakened.map((id) => `order ${id} was removed or weakened by ${how}`),
        new Date(ctx.now()).toISOString(),
        weakened.map((id) => beforeSet.get(id)).filter((o): o is NonNullable<typeof o> => !!o),
      );
      const order = ctx.trusted.orders.get(weakened[0] as string);
      if (order && mark(`orders:${head}:${weakened.join(',')}`))
        return { kind: 'orders', order, qualnames: [], edit: 0, weakened, how, commit: head };
    }
  }
  if (head && head !== before) {
    // Without a recorded HEAD (guard-shell did not run), only a commit made during this session counts.
    const recent = async () =>
      Date.parse((await commitInfo(ctx.repoRoot, head)).committed_at) >= Date.parse(s.started_at);
    const fresh = before
      ? (await revList(ctx.repoRoot, `${before}..${head}`)).slice(0, 20)
      : (await recent())
        ? [head]
        : [];
    for (const sha of fresh.reverse()) {
      const f = (await checkCommit(ctx, sha)).find((x) => x.crossing && !granted.has(x.order_id));
      if (f && mark(`commit:${sha}:${f.order_id}`)) {
        // Wave-3 N4: an agent-session commit that re-applies an order without a grant violates it.
        recordViolation(ctx.store.paths.stateDir, f.order_id, {
          commit: sha,
          at: new Date(ctx.now()).toISOString(),
          session_key: s.session_key,
        });
        const order = ctx.trusted.orders.get(f.order_id);
        // The same re-application is also in the working tree now: report it once, as the commit.
        const wt = await scoreTouched(ctx, s, granted);
        if (wt) mark(`worktree:${worktreeState(wt, s)}`);
        if (order) return { kind: 'commit', order, qualnames: f.qualnames, edit: f.edit, commit: sha };
      }
    }
  }

  // 1. The working tree, scored over the touched files.
  const hit = await scoreTouched(ctx, s, granted);
  if (hit) {
    if (mark(`worktree:${worktreeState(hit, s)}`)) return { kind: 'worktree', ...hit };
  }
  return null;
}

export function postShellReason(f: PostShellFinding, reduced: boolean): string {
  const url = f.order.links.find((l) => l.rel === 'revert')?.url ?? f.order.links[0]?.url ?? '';
  const where = f.qualnames.length ? ` in ${f.qualnames.join(', ')}` : '';
  if (reduced)
    return cap(
      `DNR: this may re-apply ${f.order.id} (${f.order.reason}, ${url})${where}. Tell the user; do not revert unless asked.`,
    );
  if (f.kind === 'orders')
    return cap(
      `DNR: ${f.how} removed or weakened DNR order(s) ${(f.weakened ?? []).join(', ')} without a human's approval. DNR keeps enforcing them and has recorded this as tampering. Do not touch .dnr/; tell the user. Only a human can restore the orders or accept the change (\`dnr tamper accept\`).`,
    );
  if (f.kind === 'commit') {
    const sha = (f.commit ?? '').slice(0, 10);
    return cap(
      `DNR: the commit you just made (${sha}) re-applies ${f.order.id} (${f.order.reason}, ${url})${where}. This change was tried and reverted. Undo that commit (for example \`git revert --no-edit ${sha}\`), do not route around this, and tell the user.`,
    );
  }
  return cap(
    `DNR: the shell command you just ran re-applies ${f.order.id} (${f.order.reason}, ${url})${where}. This change was tried and reverted. Undo only the edits that command made, do not route around this, and tell the user.`,
  );
}
