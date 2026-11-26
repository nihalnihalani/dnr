/**
 * Hook output texts (§6): block stderr (core `blockMessage`), the warn-tier text, the protect
 * text and the Stop reasons. Every text is capped at 1,200 characters.
 */
import { blockMessage, reasonLine } from '@dnr/core';
import type { Decision, Order } from '@dnr/schemas';

export const MAX_REASON_CHARS = 1200;

export function cap(s: string, n = MAX_REASON_CHARS): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function revertUrl(order: Order): string {
  return order.links.find((l) => l.rel === 'revert')?.url ?? order.links[0]?.url ?? '';
}

/**
 * Warn tier (§5.4). `downgraded` marks a match shown as a warning (warn-only / commit-enforce).
 */
export function warnMessage(
  order: Order,
  decision: Decision,
  opts: { qualnames?: readonly string[]; threshold?: number; downgraded?: boolean; file?: string } = {},
): string {
  const files = [...new Set(order.units.map((u) => u.file))];
  const where = opts.qualnames?.length
    ? ` ${opts.qualnames.join(', ')}`
    : ` ${opts.file ?? files[0] ?? 'its files'}`;
  const scored = decision.edit_score !== null;
  const score = `edit ${(decision.edit_score ?? 0).toFixed(2)}`;
  const tau = (opts.threshold ?? 0.6).toFixed(2);
  const second = opts.downgraded
    ? `DNR order ${order.id}: this write may re-apply it (${score} ≥ ${tau}) in${where}.`
    : `DNR order ${order.id} covers${where}, which this write changes (${scored ? `${score} < ${tau}, not a re-application` : 'the tool is not one DNR can score'}).`;
  const third = opts.downgraded
    ? 'This change was tried and reverted. Tell the user before going further; do not revert unless asked. This warning is shown once per session.'
    : `This code was changed and reverted before. Check that you are not re-applying it, and tell the user if you are. This warning is shown once per session for ${order.id}; the next write passes.`;
  return cap([reasonLine(order), second, third].join('\n'));
}

export function protectMessage(target: string): string {
  return cap(
    `DNR: ${target} is protected. DNR orders, config, hooks, settings and agents cannot be written by an agent. Do not route around this; tell the user.`,
  );
}

export function blockText(
  order: Order,
  decision: Decision,
  opts: { qualnames?: readonly string[]; threshold?: number; proxThreshold?: number },
): string {
  return cap(blockMessage(order, decision, opts));
}

/** Stop backstop reason (§5.11). */
export function stopReason(order: Order, qualnames: readonly string[], reduced: boolean): string {
  const url = revertUrl(order);
  if (reduced)
    return cap(
      `DNR: this may re-apply ${order.id} (${order.reason}, ${url}). Tell the user; do not revert unless asked.`,
    );
  return cap(
    `DNR: your edits re-apply ${order.id} (${order.reason}, ${url}). Revert only the edits you made to ${qualnames.join(', ') || 'the order units'} this session, then tell the user.`,
  );
}

/** Stop's tamper report (wave-2 C1): one forced turn listing what changed. */
export function tamperReason(findings: readonly string[]): string {
  return cap(
    `DNR: DNR's own state was tampered with or is invalid. ${findings.join(' ')} DNR kept enforcing with the committed orders and config. Do not edit DNR files or approvals. Tell the user exactly what changed.`,
  );
}

export function ordersChangedReason(): string {
  return cap(
    'DNR: the DNR order set, config or hook files changed during this session outside a guarded `dnr` command. Do not edit DNR files. Tell the user exactly what changed.',
  );
}

/** Wave-3 N1: covered writes are blocked while the repository is unusable. */
export function gitBrokenMessage(why: string, order: Order | null): string {
  return cap(
    `DNR: the git repository is unusable (${why}), so DNR cannot check this write against ${order ? `order ${order.id} (${order.reason})` : 'its orders'}. DNR blocks writes to protected code until the repository is repaired. Do not edit files under .git; tell the user.`,
  );
}

/** Wave-3 N4: the order was violated by an agent commit; writes that still carry it block. */
export function violatedMessage(order: Order, commit: string): string {
  return cap(
    `${reasonLine(order)}\nDNR order ${order.id} was violated: commit ${commit.slice(0, 10)} re-applied it during an agent session without a human's approval. It is still enforced. Revert that commit (for example \`git revert --no-edit ${commit.slice(0, 10)}\`) and tell the user; only a human can re-approve the order.`,
  );
}
