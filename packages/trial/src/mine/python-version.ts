import { git, listTree, readBlob } from '@dnr/git';
import type { DjangoPython } from '@dnr/schemas';

export interface PythonVersion {
  /** The version to build the environment with (the newest declared version at that commit). */
  chosen: string;
  /** Every version the source declares (sorted ascending). */
  declared: string[];
  /** Which file decided (`pyproject.toml`, `setup.cfg`, `setup.py`, `tox.ini`, `.github/workflows/<f>`, `django-python.json`). */
  source: string;
  /** Environment kind per §9.1 step 6: uv for 3.8+, Docker for older. */
  kind: 'uv' | 'docker';
}

const cmp = (a: string, b: string) => {
  const [a1, a2] = a.split('.').map(Number) as [number, number];
  const [b1, b2] = b.split('.').map(Number) as [number, number];
  return a1 - b1 || a2 - b2;
};
const uniqSorted = (xs: string[]) => [...new Set(xs)].sort(cmp);

export function classifierVersions(text: string): string[] {
  return uniqSorted(
    [...text.matchAll(/Programming Language :: Python :: (3\.\d+)\b/g)].map((m) => m[1] as string),
  );
}

/** `>=3.10`, `>=3.6`, `~=3.8`: the lower bound. */
export function requiresMin(text: string, key: RegExp): string | null {
  const m = key.exec(text);
  if (!m) return null;
  const v = /(\d+\.\d+)/.exec(m[1] ?? '');
  return v ? (v[1] as string) : null;
}

export function toxVersions(text: string): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^envlist\s*=/.test(l));
  if (at < 0) return [];
  const parts = [(lines[at] as string).replace(/^envlist\s*=/, '')];
  for (let i = at + 1; i < lines.length && /^\s+\S/.test(lines[i] as string); i++)
    parts.push(lines[i] as string);
  const env = parts.join('\n');
  const out: string[] = [];
  for (const m of env.matchAll(/py3(\d{1,2})/g)) out.push(`3.${m[1]}`);
  for (const m of env.matchAll(/py3\{([\d,]+)\}/g))
    for (const n of (m[1] as string).split(',')) out.push(`3.${n}`);
  return uniqSorted(out);
}

export function workflowVersions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/python-version:\s*\[?([^\n\]]+)\]?/g)) {
    for (const v of (m[1] as string).matchAll(/['"]?(3\.\d+)['"]?/g)) out.push(v[1] as string);
  }
  return uniqSorted(out);
}

function result(declared: string[], source: string, min?: string | null): PythonVersion | null {
  const vs = declared.length > 0 ? declared : min ? [min] : [];
  if (vs.length === 0) return null;
  const chosen = vs[vs.length - 1] as string;
  return { chosen, declared: vs, source, kind: cmp(chosen, '3.8') >= 0 ? 'uv' : 'docker' };
}

export function djangoVersionOf(initPy: string): string | null {
  const m = /^VERSION\s*=\s*\((\d+),\s*(\d+)/m.exec(initPy);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** §9.1 step 6: pyproject.toml, setup.cfg, setup.py, tox.ini, CI workflow, then the Django table. */
export async function detectPython(
  repo: string,
  sha: string,
  table?: DjangoPython,
): Promise<PythonVersion | null> {
  const pyproject = await readBlob(repo, sha, 'pyproject.toml');
  if (pyproject) {
    const r = result(
      classifierVersions(pyproject),
      'pyproject.toml',
      requiresMin(pyproject, /requires-python\s*=\s*["']([^"']+)["']/),
    );
    if (r) return r;
  }
  const cfg = await readBlob(repo, sha, 'setup.cfg');
  if (cfg) {
    const r = result(classifierVersions(cfg), 'setup.cfg', requiresMin(cfg, /python_requires\s*=\s*(\S+)/));
    if (r) return r;
  }
  const setup = await readBlob(repo, sha, 'setup.py');
  if (setup) {
    const r = result(
      classifierVersions(setup),
      'setup.py',
      requiresMin(setup, /python_requires\s*=\s*['"]([^'"]+)['"]/),
    );
    if (r) return r;
  }
  const tox = await readBlob(repo, sha, 'tox.ini');
  if (tox) {
    const r = result(toxVersions(tox), 'tox.ini');
    if (r) return r;
  }
  const wfs = (await listTree(repo, sha, '.github/workflows/')).filter((p) => /\.ya?ml$/.test(p)).sort();
  for (const wf of wfs) {
    const t = await readBlob(repo, sha, wf);
    const r = t ? result(workflowVersions(t), wf) : null;
    if (r) return r;
  }
  if (table) {
    const init = await readBlob(repo, sha, 'django/__init__.py');
    const dv = init ? djangoVersionOf(init) : null;
    const row = dv ? table.find((t) => t.django === dv) : undefined;
    if (row) return result(row.pythons, 'django-python.json');
  }
  return null;
}

/** Builds `fixtures/django-python.json` from the repo's own X.Y release tags (no hand-typed data). */
export async function buildDjangoPythonTable(repo: string): Promise<DjangoPython> {
  const tags = (await git(['tag', '--list'], { cwd: repo }))
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^\d+\.\d+$/.test(t))
    .sort(cmp);
  const rows: DjangoPython = [];
  for (const tag of tags) {
    const sha = (await git(['rev-list', '-n', '1', tag], { cwd: repo })).trim();
    const pv = await detectPython(repo, sha);
    if (pv) rows.push({ django: tag, tag, pythons: pv.declared, source: pv.source });
  }
  return rows;
}
