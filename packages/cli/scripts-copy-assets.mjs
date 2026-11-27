// Copies the assets the npm package ships next to the bundle:
// - the vendored grammars into `vendor/grammars/` (shipped in `files`);
// - the built board UI (`apps/playground/dist`, served by `dnr board`) into `dist/ui/`;
// - LICENSE, NOTICE, README.md and a generated THIRD_PARTY_LICENSES (audit P5).
// A missing UI build is a hard failure: the package must never ship the "UI not built" stub.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
// `_headers` is the static-host header file and robots.txt is for the hosted site; the board sets its
// own headers and ignores both.
cpSync(uiFrom, uiTo, {
  recursive: true,
  filter: (src) => !/[\\/](_headers|robots\.txt)$/.test(src),
});

// Production audit P5: the package's own LICENSE, NOTICE and README, and the generated
// THIRD_PARTY_LICENSES for everything bundled or installed with it.
for (const f of ['LICENSE', 'NOTICE', 'README.md'])
  copyFileSync(
    fileURLToPath(new URL(`../../${f}`, import.meta.url)),
    fileURLToPath(new URL(`./${f}`, import.meta.url)),
  );
const { render } = await import('./scripts/third-party-licenses.mjs');
const { version } = JSON.parse(
  (await import('node:fs')).readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
writeFileSync(fileURLToPath(new URL('./THIRD_PARTY_LICENSES', import.meta.url)), render(version));
