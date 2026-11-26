import { commitDiffU0, filePath, readBlob } from '@dnr/git';
import { pyLineQualnames } from './py-units';

export interface TestLabelPlan {
  /** Test apps (directories under tests/) that C or R changed, sorted. */
  apps: string[];
  /** Restored tests: test functions C added that R deleted (validity is checked by `trial envs`). */
  restored: { paths: string[]; labels: string[] };
}

/** `tests/<app>/...` gives `<app>`. */
export function testAppOf(path: string): string | null {
  const m = /^tests\/([^/]+)\//.exec(path);
  return m ? (m[1] as string) : null;
}

/** `tests/aggregation_regress/tests.py` + `AggregationTests.test_x` gives `aggregation_regress.tests.AggregationTests.test_x`. */
export function labelFor(path: string, qualname: string): string | null {
  if (!path.startsWith('tests/') || !path.endsWith('.py')) return null;
  const mod = path.slice('tests/'.length, -'.py'.length).replace(/\//g, '.');
  return `${mod}.${qualname}`;
}

/**
 * §9.1 step 7 sources available from history alone: the test apps C and R changed, and C's test
 * hunks that R deleted (restored-test candidates). The module-to-app table and the coverage map
 * need environments and are added by `trial envs`.
 */
export async function planTestLabels(repo: string, original: string, revert: string): Promise<TestLabelPlan> {
  const [cd, rd] = await Promise.all([commitDiffU0(repo, original), commitDiffU0(repo, revert)]);
  const apps = new Set<string>();
  for (const f of [...cd, ...rd]) {
    const a = testAppOf(filePath(f));
    if (a) apps.add(a);
  }
  const cAddedTests = new Set<string>();
  for (const f of cd) {
    const p = filePath(f);
    if (!p.startsWith('tests/') || !p.endsWith('.py') || !f.newPath) continue;
    const text = await readBlob(repo, original, f.newPath);
    if (!text) continue;
    const q = pyLineQualnames(text);
    for (const h of f.hunks) {
      for (let i = 0; i < h.added.length; i++) {
        const m = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/.exec(h.added[i] as string);
        if (m) cAddedTests.add(`${p}\0${q[h.newStart + i]}`);
      }
    }
  }
  const paths = new Set<string>();
  const labels = new Set<string>();
  for (const f of rd) {
    const p = filePath(f);
    if (!p.startsWith('tests/') || !p.endsWith('.py') || !f.oldPath) continue;
    const text = await readBlob(repo, `${revert}^`, f.oldPath);
    if (!text) continue;
    const q = pyLineQualnames(text);
    for (const h of f.hunks) {
      for (let i = 0; i < h.removed.length; i++) {
        const m = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/.exec(h.removed[i] as string);
        if (!m) continue;
        const qn = q[h.oldStart + i] as string;
        if (!cAddedTests.has(`${p}\0${qn}`)) continue;
        const label = labelFor(p, qn);
        if (label) {
          paths.add(p);
          labels.add(label);
        }
      }
    }
  }
  return { apps: [...apps].sort(), restored: { paths: [...paths].sort(), labels: [...labels].sort() } };
}
