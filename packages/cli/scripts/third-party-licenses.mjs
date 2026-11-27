// Production audit P5: THIRD_PARTY_LICENSES for the dnr-guard npm package.
//
// It covers every npm package that can end up in the tarball or next to it: the production
// dependency closure of dnr-guard's own dependencies and of every workspace package it bundles
// (@dnr/* through tsup, the board UI through @dnr/playground and @dnr/ui). That closure is a
// superset of what vite and tsup actually inline, so nothing bundled is missed. It also carries the
// license texts for the third-party source excerpts the package ships (Django and Vite, in the demo
// cases and the board UI). Workspace packages are dnr's own (MIT, LICENSE).
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('..', import.meta.url));
const ROOT = join(CLI, '..', '..');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** The directory of package `name` as Node would resolve it from `fromDir` (pnpm layout safe). */
function findPkgDir(fromDir, name) {
  let dir = realpathSync(fromDir);
  for (;;) {
    const p = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(p)) return realpathSync(dirname(p));
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown|mit|bsd))?$/i;

function licenseTexts(dir) {
  const out = [];
  for (const n of readdirSync(dir).sort())
    if (LICENSE_FILE.test(n)) out.push({ file: n, text: readFileSync(join(dir, n), 'utf8').trim() });
  return out;
}

function licenseId(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return null;
}

/** Every third-party package reachable through `dependencies` from dnr-guard and its workspace deps. */
export function collect() {
  const seenDirs = new Set();
  const packages = new Map(); // key name@version
  const queue = [];
  const cli = readJson(join(CLI, 'package.json'));
  // dnr-guard's runtime deps, and the workspace packages it bundles (its devDependencies).
  for (const [name, spec] of Object.entries({ ...cli.dependencies, ...cli.devDependencies }))
    queue.push({ from: CLI, name, workspace: String(spec).startsWith('workspace:') });
  while (queue.length) {
    const { from, name } = queue.shift();
    const dir = findPkgDir(from, name);
    if (!dir) throw new Error(`third-party-licenses: cannot resolve ${name} from ${from}`);
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const pkg = readJson(join(dir, 'package.json'));
    const isWorkspace = !dir.includes(`${join('node_modules', '.pnpm')}`) && dir.startsWith(ROOT);
    if (!isWorkspace) {
      const key = `${pkg.name}@${pkg.version}`;
      if (!packages.has(key))
        packages.set(key, {
          name: pkg.name,
          version: pkg.version,
          license: licenseId(pkg),
          repository: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? null),
          texts: licenseTexts(dir),
        });
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ from: dir, name: dep });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {}))
      if (findPkgDir(dir, dep)) queue.push({ from: dir, name: dep });
  }
  return [...packages.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/** Third-party source excerpts shipped as data (demo cases, board UI cases). */
export const EXCERPTS = [
  {
    what: 'Django source excerpts (templates/demo/*.case.json, dist/ui/cases/*.json)',
    license: 'BSD-3-Clause',
    file: join(ROOT, 'apps', 'playground', 'public', 'licenses', 'django-LICENSE.txt'),
  },
  {
    what: 'Vite source excerpts (dist/ui/cases/*.json, the TypeScript demo case)',
    license: 'MIT',
    file: join(ROOT, 'apps', 'playground', 'public', 'licenses', 'vite-LICENSE.txt'),
  },
];

export function render(version) {
  const pkgs = collect();
  const bar = '='.repeat(78);
  const lines = [
    `dnr-guard ${version}: third-party software notices and licenses`,
    '',
    'dnr-guard is MIT-licensed (LICENSE). It bundles or installs the third-party packages listed',
    'below, and ships source excerpts from Django and Vite as demo data. Each entry gives the',
    "package's declared license and the license files it ships. Generated at build time by",
    'packages/cli/scripts/third-party-licenses.mjs from the production dependency closure.',
    '',
    'Packages:',
    ...pkgs.map((p) => `  ${p.name}@${p.version} (${p.license ?? 'no license field'})`),
    '',
    'Source excerpts:',
    ...EXCERPTS.map((e) => `  ${e.what} (${e.license})`),
    '',
  ];
  for (const p of pkgs) {
    lines.push(bar, `${p.name}@${p.version}`, `License: ${p.license ?? 'no license field in package.json'}`);
    if (p.repository) lines.push(`Repository: ${p.repository}`);
    lines.push('');
    if (p.texts.length === 0)
      lines.push(`(The package ships no license file; its package.json declares ${p.license}.)`, '');
    for (const t of p.texts) lines.push(`--- ${t.file} ---`, t.text, '');
  }
  for (const e of EXCERPTS) {
    lines.push(bar, e.what, `License: ${e.license}`, '', readFileSync(e.file, 'utf8').trim(), '');
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const version = readJson(join(CLI, 'package.json')).version;
  const out = join(CLI, 'THIRD_PARTY_LICENSES');
  writeFileSync(out, render(version));
  console.log(`third-party-licenses: wrote ${out}`);
}
