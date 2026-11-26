/**
 * What the hook would print for a decision (§6): exit code, stderr, and the JSON on stdout.
 *
 * - deny format: block / warn_block / deny_protected exit 2 with the reason on stderr.
 * - ask format: exit 0 with {"hookSpecificOutput":{"permissionDecision":"ask",...}} on stdout.
 * - everything else exits 0 with no output.
 *
 * The block text is core's `blockMessage` and the warn_block text is `@dnr/hook`'s `warnMessage`,
 * byte for byte what the hook prints.
 */
import { blockMessage } from '@dnr/core';
import { warnMessage } from '@dnr/hook/messages';
import type { Decision, Order } from '@dnr/schemas';

export type Verdict = 'BLOCK' | 'ASK' | 'WARN' | 'ALLOW' | 'DENY' | 'ERROR';

export interface HookOutput {
  verdict: Verdict;
  exitCode: 0 | 2;
  stderr: string;
  /** stdout JSON (ask format), or null. */
  stdout: string | null;
  permission: 'ask' | null;
  /** True when the text is the UI's stand-in, not the hook's own function. */
  provisionalText: boolean;
}

export function verdictOf(outcome: Decision['outcome']): Verdict {
  switch (outcome) {
    case 'block':
      return 'BLOCK';
    case 'ask':
      return 'ASK';
    case 'warn_block':
      return 'WARN';
    case 'deny_protected':
      return 'DENY';
    case 'error_open':
      return 'ERROR';
    default:
      return 'ALLOW';
  }
}

export function hookOutput(
  order: Order,
  decision: Decision,
  opts: { qualnames?: readonly string[]; format?: 'deny' | 'ask'; threshold?: number } = {},
): HookOutput {
  const verdict = verdictOf(decision.outcome);
  const q = opts.qualnames ?? [];
  let text = '';
  const provisional = false;
  if (decision.outcome === 'block' || decision.outcome === 'ask') {
    text = blockMessage(order, decision, {
      qualnames: q,
      ...(opts.threshold ? { threshold: opts.threshold } : {}),
    });
  } else if (decision.outcome === 'warn_block') {
    text = warnMessage(order, decision, {
      qualnames: q,
      ...(opts.threshold ? { threshold: opts.threshold } : {}),
    });
  } else if (decision.outcome === 'deny_protected') {
    text = decision.reason_line ?? 'DNR: protected path';
  }
  if (decision.outcome === 'ask' || (decision.outcome === 'warn_block' && opts.format === 'ask')) {
    return {
      verdict: decision.outcome === 'ask' ? 'ASK' : 'WARN',
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: text },
      }),
      permission: 'ask',
      provisionalText: provisional,
    };
  }
  if (text)
    return {
      verdict,
      exitCode: 2,
      stderr: text,
      stdout: null,
      permission: null,
      provisionalText: provisional,
    };
  return { verdict, exitCode: 0, stderr: '', stdout: null, permission: null, provisionalText: false };
}
