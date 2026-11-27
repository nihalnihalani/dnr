import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { approveSim, DEMO, DEMO_ORDER, openPlay, results, runPreset } from './helpers';

test('smoke: the demo case loads the WASM engine; draft allows, approved (simulated) blocks the original change', {
  tag: ['@smoke'],
}, async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Some changes should stay dead');
  await openPlay(page);
  // The order as built from Django is a draft: not enforced.
  await expect(page.getByTestId('banner-draft')).toContainText('Draft: not enforced');
  await runPreset(page, 'original');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'ALLOW');
  await approveSim(page);
  await page.locator('[data-preset="reset"]').click();
  await runPreset(page, 'original');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'BLOCK');
  await expect(page.getByTestId('exit-code')).toHaveText('2');
});

test('ROUTE-02: order card with A/R chips, editor on the post-revert baseline, presets and reset, Send write', {
  tag: ['@ROUTE-02', '@P7-routes'],
}, async ({ page }) => {
  await openPlay(page);
  const card = page.locator('.order-card');
  await expect(card).toContainText(DEMO_ORDER);
  await expect(card).toContainText('Query.clear_ordering');
  await expect(card.getByRole('list', { name: 'Added tokens (A)' }).locator('li').first()).toContainText('+');
  // Editor opens on the post-revert baseline (R). Sending it unchanged is ALLOW (C would BLOCK).
  // It mounts when it nears the viewport (below the fold on phones), as a reader scrolls to it.
  await page.locator('#editor-panel').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('editor')).toContainText('Create SQL statements for QuerySets');
  for (const kind of ['original-change', 'hard-negative', 'formatting-only'])
    await expect(page.locator(`[data-preset-kind="${kind}"]`)).toBeVisible();
  await expect(page.locator('[data-preset="reset"]')).toBeVisible();
  // Send write with the unchanged baseline: nothing changes, ALLOW.
  await page.getByTestId('send-write').click();
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'ALLOW');
  await page.locator('[data-preset="reset"]').click();
  await expect(page.locator('.verdict.idle')).toBeVisible();
});

test('ROUTE-03: decision panel shows verdict, exit code, exact stderr, JSON, score bars and highlighted tokens', {
  tag: ['@ROUTE-03'],
}, async ({ page }) => {
  await openPlay(page);
  await approveSim(page);
  await runPreset(page, 'original');
  const stderr = page.getByTestId('stderr');
  await expect(stderr).toContainText(
    `DNR order ${DEMO_ORDER} matched (edit 1.00 ≥ 0.60) in Query.clear_ordering.`,
  );
  await expect(stderr).toContainText(`dnr board --open ${DEMO_ORDER}`);
  const text = (await stderr.textContent()) ?? '';
  expect(text.length).toBeLessThanOrEqual(1200);
  expect(text.split('\n')[0]).toMatch(/^DNR: .+ https:\/\/github\.com\/django\/django\/commit\/43933a1dca/);
  await page.getByText('Decision JSON').click();
  const json = JSON.parse((await page.getByTestId('decision-json').textContent()) ?? '{}');
  expect(json).toMatchObject({
    outcome: 'block',
    tier: 'match',
    order_id: DEMO_ORDER,
    edit_score: 1,
    fired_by: 'edit',
  });
  await expect(page.getByRole('meter', { name: /Edit score 1\.00, threshold 0\.60/ })).toBeAttached();
  await expect(page.locator('.chip.hit').first()).toBeVisible();
  await expect(page.getByTestId('live')).toContainText('BLOCK, exit 2');
  // Hard negative: changes the covered unit without re-applying it → warn tier, not a block.
  await runPreset(page, 'hard-negative');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'WARN');
  // The held-out paraphrase (a mutant DNR never saw while tuning) still blocks.
  await page.locator('[data-preset="reset"]').click();
  await runPreset(page, 'paraphrase');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'BLOCK');
  // Presets the case cannot offer are listed with their reason.
  const na = page.getByTestId('unavailable-presets');
  await expect(na.locator('[data-kind="half-of-two-file"]')).toContainText('covers one file');
  await expect(na.locator('[data-kind="recorded-agent"]')).toContainText('demo/L');
  // Formatting cannot hide a re-application.
  await page.locator('[data-preset="reset"]').click();
  await runPreset(page, 'formatting');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'BLOCK');
});

test('ROUTE-03: simulated Allow once lets the re-land through, Advance 1 h expires it in a new session', {
  tag: ['@ROUTE-03', '@board-flow-sim'],
}, async ({ page }) => {
  await openPlay(page);
  await approveSim(page);
  await runPreset(page, 'original');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'BLOCK');
  await page.locator('.sim-actions [data-action="allow-once"]').click();
  await expect(page.locator('.sim-actions')).toContainText('active until');
  await page.locator('[data-preset="reset"]').click();
  await runPreset(page, 'original');
  expect((await results(page))[0]).toMatchObject({ outcome: 'allow_grant', applied: true });
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'ALLOW');
  await page.getByTestId('advance').click();
  await page.locator('[data-preset="reset"]').click();
  await runPreset(page, 'original');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'BLOCK');
  // The grant's use is in the audit panel.
  await page.goto(`orders/${DEMO_ORDER}`);
  await expect(page.getByTestId('grants')).toContainText('allow_once');
  await expect(page.getByTestId('grants')).toContainText('1 (write)');
});

test('ROUTE-03: simulated Retire stops enforcement; the ask format exits 0 with JSON', {
  tag: ['@ROUTE-03'],
}, async ({ page }) => {
  await openPlay(page);
  await approveSim(page);
  await page.getByLabel('Decision format ask').check();
  await runPreset(page, 'original');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'ASK');
  await expect(page.getByTestId('exit-code')).toHaveText('0');
  const out = JSON.parse((await page.getByTestId('stdout').textContent()) ?? '{}');
  expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  await page.locator('.sim-actions [data-action="retire"]').click();
  await expect(page.locator('.sim-actions')).toContainText('Retired');
  await page.locator('[data-preset="reset"]').click();
  await runPreset(page, 'original');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'ALLOW');
});

const caseIndex = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/cases/index.json', import.meta.url)), 'utf8'),
) as { cases: Array<{ id: string; status: string; grammars: string[]; source: { repo: string } }> };

test('ts-case: the real TypeScript case (vite afc44f0957) loads the TS grammar, allows as a draft, blocks once approved', {
  tag: ['@ts-case', '@P12-08'],
}, async ({ page }) => {
  const ts = caseIndex.cases.find((c) => c.grammars.includes('typescript'));
  expect(ts?.id).toBe('afc44f0957');
  expect(ts?.source.repo).toBe('vitejs/vite');
  // Exported as `dnr orders build` made it: a draft no human has approved.
  expect(ts?.status).toBe('draft');
  await page.goto('play');
  await expect(page.locator(`a[href$="/play/afc44f0957"]`)).toBeVisible();
  await openPlay(page, 'afc44f0957');
  await expect(page.getByText('Grammars loaded:')).toContainText('typescript');
  await expect(page.getByTestId('banner-draft')).toContainText('Draft: not enforced');
  await runPreset(page, 'original');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'ALLOW');
  await approveSim(page);
  await page.locator('[data-preset="reset"]').click();
  await runPreset(page, 'original');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'BLOCK');
  await expect(page.getByTestId('exit-code')).toHaveText('2');
  await expect(page.getByTestId('stderr')).toContainText('DNR order dnr-afc44f0957 matched');
});

test('STATE-08: a parse-degraded unit shows its banner', { tag: ['@STATE-08'] }, async ({ page }) => {
  const bundle = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../public/cases/${DEMO}.json`, import.meta.url)), 'utf8'),
  ) as { files: Array<{ path: string; baseline_text: string }> };
  const f = bundle.files[0] as { path: string; baseline_text: string };
  // Query.clear_ordering still parses as a method, but most of its tokens sit under ERROR nodes.
  const start = f.baseline_text.indexOf('    def clear_ordering(');
  const end = f.baseline_text.indexOf('    def set_group_by(', start);
  const body = [
    '        if not force and ((( self.is_sliced ]]] or {{{ self.distinct_fields )) or ?? self.select_for_update',
    '        ))) return :: @@ ##',
    '        self.order_by = ((( ]]]',
  ].join('\n');
  const broken = `${f.baseline_text.slice(0, start)}    def clear_ordering(self, force=False, clear_default=True):\n${body}\n\n${f.baseline_text.slice(end)}`;
  await openPlay(page);
  await approveSim(page);
  // Pasted through /replay (a textarea), so the editor's auto-closing brackets cannot change it.
  await page.goto('replay');
  await expect(page.getByTestId('replay-run')).toBeEnabled();
  await page.getByLabel('PreToolUse stdin').fill(
    JSON.stringify({
      tool_name: 'fs_write',
      cwd: '/w',
      tool_input: { command: 'create', path: `/w/${f.path}`, file_text: broken },
    }),
  );
  await page.getByTestId('replay-run').click();
  await expect(page.getByTestId('replay-result')).toContainText('approved');
  await expect(page.getByTestId('banner-degraded')).toBeVisible();
});

test('A11Y-01: keyboard only: reach a preset, run it, hear the decision', {
  tag: ['@A11Y-01', '@keyboard'],
}, async ({ page, browserName }) => {
  test.skip(
    browserName === 'webkit',
    'WebKit does not Tab to buttons by default (macOS full keyboard access setting)',
  );
  await openPlay(page, DEMO);
  // Approve (simulated) by keyboard too.
  const approve = page.locator('.sim-actions [data-action="approve"]');
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press('Tab');
    if (await approve.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(approve).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.sim-actions')).toContainText('Approved: enforced');
  await page.locator('#main').focus();
  const original = page.locator('[data-preset-kind="original-change"]');
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    if (await original.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(original).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'BLOCK');
  await expect(page.getByTestId('live')).toHaveAttribute('aria-live', 'assertive');
  await expect(page.getByTestId('live')).toContainText('BLOCK');
});

test('ROUTE-02: unknown case shows a way back', { tag: ['@ROUTE-02'] }, async ({ page }) => {
  await page.goto('play/nope');
  await expect(page.getByRole('heading', { name: /No case/ })).toBeVisible();
  await page.goto('play');
  await expect(page.getByRole('link', { name: /26434/ })).toBeVisible();
  void DEMO;
});
