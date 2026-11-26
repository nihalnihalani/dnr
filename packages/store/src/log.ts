/** `$DNR_STATE_DIR/hook.log` (§5.12): one line per internal error or debug note. Never throws. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso } from './clock';

export function hookLog(file: string, line: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${nowIso()} ${line.replace(/\n/g, '\\n')}\n`);
  } catch {
    // Logging must never break fail-open.
  }
}
