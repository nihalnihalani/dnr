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
import { commitInfo, headCommit, revList } from '@dnr/git';
import type { Grant, Order, Session } from '@dnr/schemas';
import { checkCommit } from './commit';
import type { HookContext } from './context';
import { cap } from './messages';
import { scoreTouched } from './stop';

export interface PostShellFinding {
  kind: 'worktree' | 'commit';
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
        const order = ctx.trusted.orders.get(f.order_id);
        if (order) return { kind: 'commit', order, qualnames: f.qualnames, edit: f.edit, commit: sha };
      }
    }
  }

  // 1. The working tree, scored over the touched files.
  const hit = await scoreTouched(ctx, s, granted);
  if (hit) {
    const state = createHash('sha256')
      .update(hit.order.id)
      .update(String(hit.edit))
      .update(s.touched.join('\n'))
      .digest('hex');
    if (mark(`worktree:${state}`)) return { kind: 'worktree', ...hit };
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
