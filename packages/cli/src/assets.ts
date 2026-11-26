/** Files shipped in the npm package (`templates/`, `vendor/grammars/`), found from src or dist. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Resolve `rel` under the package root: `dist/cli.js` → `../`, `src/x.ts` → `../`, `src/commands/x.ts` → `../../`. */
export function packagePath(rel: string): string {
  for (const up of ['../', '../../']) {
    const p = fileURLToPath(new URL(`${up}${rel}`, import.meta.url));
    if (existsSync(p)) return p;
  }
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
