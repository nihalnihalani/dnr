/**
 * P9 parity: every preset gives the same decision in the browser (web-tree-sitter WASM, this
 * browser) as in the real hook, `dnr check --file` from the built CLI.
 *
 * For each write of each preset, the hook runs in a temp git repo put in the exact session state
 * the browser was in before that write (working tree and warned set), so multi-write presets are
 * compared write by write. Outcome, tier, order, scores, fired_by and the stderr text must match.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadGrammarsNode } from '@dnr/grammar/node';
import { CaseBundle } from '@dnr/schemas';
import { CaseEngine, initialState, newSession, type SimState } from '@dnr/ui/engine';
import { expect, test } from '@playwright/test';
import { CaseRepo } from './cli-reference';
import { approveSim, isRemote, openPlay, results, runPreset } from './helpers';

const casesDir = fileURLToPath(new URL('../public/cases/', import.meta.url));
const index = JSON.parse(readFileSync(`${casesDir}index.json`, 'utf8')) as { cases: Array<{ id: string }> };

const r6 = (x: number | null | undefined) => (x === null || x === undefined ? null : Number(x.toFixed(6)));

interface Key {
  path: string;
  outcome: string;
  tier: string;
  order_id: string | null;
  edit_score: number | null;
  prox_score: number | null;
  fired_by: string | null;
  stderr: string;
}

/** The hook's answer for every write of a preset, replaying the browser's session state. */
async function hookSequence(
  repo: CaseRepo,
  engine: CaseEngine,
  start: SimState,
  writes: CaseBundle['presets'][number]['writes'],
) {
  const out: Key[] = [];
  let s = start;
  for (const w of writes) {
    const ref = await repo.check(s.files, s.warned, w);
    out.push({
      path: w.path,
      outcome: ref.decision.outcome,
      tier: ref.decision.tier,
      order_id: ref.decision.order_id,
      edit_score: r6(ref.decision.edit_score),
      prox_score: r6(ref.decision.prox_score),
      fired_by: ref.decision.fired_by,
      stderr: ref.stderr ?? '',
    });
    // Advance the session the same way the hook would (applied writes, warned set).
    s = engine.send(s, repo.order, w).next;
  }
  return out;
}

for (const { id } of index.cases) {
  test(`P9: browser decisions equal dnr check --file on every preset of ${id}`, { tag: ['@P9'] }, async ({
    page,
  }) => {
    test.skip(isRemote, 'needs the built CLI and the local case files');
    test.setTimeout(180_000);
    // Open the page first: the node-side setup below blocks this worker for a while. The hook's
    // temp repo carries the order approved (the test is the maintainer); the browser gets the same
    // approval through its simulated action.
    await openPlay(page, id);
    await approveSim(page);
    const bundle = CaseBundle.parse(JSON.parse(readFileSync(`${casesDir}${id}.json`, 'utf8')));
    const engine = new CaseEngine(await loadGrammarsNode(), bundle);
    const repo = CaseRepo.create(bundle);
    try {
      let s = initialState(bundle);
      for (const p of bundle.presets) {
        s = newSession(bundle, s);
        const expected = await hookSequence(repo, engine, s, p.writes);
        await page.locator('[data-preset="reset"]').click();
        await runPreset(page, p.id, { byId: true });
        const got = ((await results(page)) as Array<Key & { edit_score: number | null }>).map((r) => ({
          path: r.path,
          outcome: r.outcome,
          tier: r.tier,
          order_id: r.order_id,
          edit_score: r.edit_score,
          prox_score: r.prox_score ?? null,
          fired_by: r.fired_by,
          stderr: r.stderr,
        }));
        expect(got, `${id}/${p.id}: browser vs dnr check --file`).toEqual(expected);
      }
    } finally {
      repo.dispose();
    }
  });
}
