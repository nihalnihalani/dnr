import { commitDiffU0, filePath, git, readBlob } from '@dnr/git';
import type { UnitAnalyzer } from './units';

/**
 * §9.2 realism stratum: Δ is the first main (first-parent) commit after R that touches any unit
 * of the order; R+Δ is Δ's parent, capped at the last main commit with committer date ≤ R + 365 days.
 */
export async function computeRdelta(
  repo: string,
  ref: string,
  revertSha: string,
  units: ReadonlyArray<{ file: string; qualname: string }>,
  analyzer: UnitAnalyzer,
): Promise<string> {
  const rDate = Date.parse((await git(['log', '-1', '--format=%cI', revertSha], { cwd: repo })).trim());
  const cap = rDate + 365 * 24 * 3600 * 1000;
  const out = await git(
    ['rev-list', '--first-parent', '--reverse', '--format=%H %ct', `${revertSha}..${ref}`],
    { cwd: repo },
  );
  const chain: Array<{ sha: string; t: number }> = [];
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}) (\d+)$/.exec(line.trim());
    if (m) chain.push({ sha: m[1] as string, t: Number(m[2]) * 1000 });
  }
  const files = new Set(units.map((u) => u.file));
  const wanted = new Set(units.map((u) => `${u.file}\0${u.qualname}`));
  let prev = revertSha;
  let lastInCap = revertSha;
  for (const c of chain) {
    if (c.t > cap) break;
    const diff = await commitDiffU0(repo, c.sha, [...files]);
    for (const f of diff) {
      const p = filePath(f);
      const before = f.oldPath ? await readBlob(repo, `${c.sha}^`, f.oldPath) : null;
      const after = f.newPath ? await readBlob(repo, c.sha, f.newPath) : null;
      for (const q of analyzer.changedUnits({ path: p, before, after, hunks: f.hunks })) {
        if (wanted.has(`${p}\0${q}`)) return prev;
      }
    }
    prev = c.sha;
    lastInCap = c.sha;
  }
  return lastInCap;
}
