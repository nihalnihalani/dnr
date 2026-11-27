// Copies the assets the npm package ships next to the bundle:
// - the vendored grammars into `vendor/grammars/` (shipped in `files`);
// - the built board UI (`apps/playground/dist`, served by `dnr board`) into `dist/ui/`.
// A missing UI build is a hard failure: the package must never ship the "UI not built" stub.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../../vendor/grammars/', import.meta.url));
const to = fileURLToPath(new URL('./vendor/grammars/', import.meta.url));
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });

const uiFrom = fileURLToPath(new URL('../../apps/playground/dist/', import.meta.url));
const uiTo = fileURLToPath(new URL('./dist/ui/', import.meta.url));
if (!existsSync(`${uiFrom}index.html`)) {
  console.error(
    `dnr-guard build: the board UI is not built (${uiFrom}index.html is missing).\n` +
      'Run `pnpm -F @dnr/playground build` first (or `pnpm build`, which orders it).',
  );
  process.exit(1);
}
rmSync(uiTo, { recursive: true, force: true });
// `_headers` is a Cloudflare Pages file and robots.txt is for the hosted site; the board ignores both.
cpSync(uiFrom, uiTo, {
  recursive: true,
  filter: (src) => !/[\\/](_headers|robots\.txt)$/.test(src),
});
