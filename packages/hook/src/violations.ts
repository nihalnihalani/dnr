/**
 * Violations (wave-3 N4; plan §5.9 amended by the lead). A commit counts as a re-land only when it
 * was made outside an agent session or under a grant that applies. A re-application committed in
 * an agent session without a grant puts the order in the derived state `violated`: it keeps
 * enforcing (block, not warn), and Stop reports it every session until a human re-approves the
 * order or the commit is reverted. Recorded in `<state>/violations.json`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Violation {
  commit: string;
  at: string;
  session_key: string | null;
}

export function readViolations(stateDir: string): Record<string, Violation> {
  try {
    const j = JSON.parse(readFileSync(join(stateDir, 'violations.json'), 'utf8')) as Record<
      string,
      Violation
    >;
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function write(stateDir: string, v: Record<string, Violation>): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const f = join(stateDir, 'violations.json');
    writeFileSync(`${f}.tmp`, `${JSON.stringify(v, null, 2)}\n`);
    renameSync(`${f}.tmp`, f);
  } catch {}
}

export function recordViolation(stateDir: string, orderId: string, v: Violation): void {
  const all = readViolations(stateDir);
  if (all[orderId]?.commit === v.commit) return;
  all[orderId] = v;
  write(stateDir, all);
}

/** Cleared by a human re-approval (or once the order is no longer re-landed). */
export function clearViolation(stateDir: string, orderId: string): void {
  const all = readViolations(stateDir);
  if (!(orderId in all)) return;
  delete all[orderId];
  write(stateDir, all);
}
