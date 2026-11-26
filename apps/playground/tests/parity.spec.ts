/**
 * P9 parity: every preset gives the same decision in the browser engine (web-tree-sitter WASM in
 * this browser) as in the node engine (@dnr/grammar/node), through the same simulator.
 * When `dnr check --file` ships, it is added here as a third source.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadGrammarsNode } from '@dnr/grammar/node';
import { CaseBundle } from '@dnr/schemas';
import { CaseEngine, decisionKey, initialState, newSession } from '@dnr/ui/engine';
import { expect, test } from '@playwright/test';
import { openPlay, results, runPreset } from './helpers';

const casesDir = fileURLToPath(new URL('../public/cases/', import.meta.url));
const index = JSON.parse(readFileSync(`${casesDir}index.json`, 'utf8')) as { cases: Array<{ id: string }> };

for (const { id } of index.cases) {
  test(`P9: browser and node engines agree on every preset of ${id}`, { tag: ['@P9'] }, async ({ page }) => {
    const bundle = CaseBundle.parse(JSON.parse(readFileSync(`${casesDir}${id}.json`, 'utf8')));
    const engine = new CaseEngine(await loadGrammarsNode(), bundle);
    let s = initialState(bundle);
    await openPlay(page, id);
    for (const p of bundle.presets) {
      s = newSession(bundle, s);
      const expected = engine.sendAll(s, bundle.order, p.writes).results.map(decisionKey);
      await page.locator('[data-preset="reset"]').click();
      await runPreset(page, p.id, { byId: true });
      expect(await results(page), `${id}/${p.id}`).toEqual(expected);
    }
  });
}
