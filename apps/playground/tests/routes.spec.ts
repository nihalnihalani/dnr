import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { DEMO, DEMO_ORDER, expectNoAxeViolations, openPlay, runPreset } from './helpers';

const demoBundle = JSON.parse(
  readFileSync(fileURLToPath(new URL(`../public/cases/${DEMO}.json`, import.meta.url)), 'utf8'),
);

const stone = (page: Page, state: string) => page.locator(`article.stone[data-state="${state}"]`).first();
const plotOf = (page: Page, state: string) => page.locator('li.plot', { has: stone(page, state) }).first();

test('ROUTE-01: home has the pitch, the CLI loop and the three buttons', {
  tag: ['@ROUTE-01', '@P7-routes'],
}, async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.terminal')).toBeVisible();
  await expect(page.locator('.terminal')).toContainText('Placeholder');
  for (const name of ['Try a revert', 'See the trial', 'How Kiro built it'])
    await expect(page.getByRole('link', { name })).toBeVisible();
  await page.getByRole('link', { name: 'Try a revert' }).click();
  await expect(page).toHaveURL(new RegExp(`/play/${DEMO}$`));
});

test('ROUTE-05: headstones carry epitaph, birth, death and links, each with a text label', {
  tag: ['@ROUTE-05', '@P7-routes'],
}, async ({ page }) => {
  await page.goto('graveyard');
  const s = page.locator(`article.stone`, { hasText: DEMO_ORDER });
  await expect(s).toContainText('Epitaph (reason)');
  await expect(s).toContainText('Born (commit): ea3a71c2d0');
  await expect(s).toContainText('Died (revert): 43933a1dca');
  await expect(s.getByRole('link', { name: 'ea3a71c2d0' })).toHaveAttribute(
    'href',
    /github\.com\/django\/django\/commit\/ea3a71c2d0/,
  );
  await expect(s.getByRole('link', { name: '#26434' })).toHaveAttribute(
    'href',
    /code\.djangoproject\.com\/ticket\/26434/,
  );
  await expect(s.getByTestId('state-label')).toHaveText('Approved: enforced');
});

test('STATE-01: draft is outlined, labeled, with Approve / Edit / Retire', { tag: ['@STATE-01'] }, async ({
  page,
}) => {
  await page.goto('graveyard');
  await expect(stone(page, 'draft')).toHaveClass(/outlined/);
  await expect(stone(page, 'draft').getByTestId('state-label')).toHaveText('Draft: not enforced');
  const plot = plotOf(page, 'draft');
  for (const a of ['approve', 'edit', 'retire'])
    await expect(plot.locator(`[data-action="${a}"]`)).toBeVisible();
  // Approve (simulated) → it becomes enforced.
  const id = await stone(page, 'draft').getAttribute('aria-label');
  await plot.locator('[data-action="approve"]').click();
  await expect(page.getByRole('status').filter({ hasText: 'approved (simulated)' })).toBeAttached();
  expect(id).toContain('Draft');
});

test('STATE-02: approved is solid with Allow once / Edit / Retire', { tag: ['@STATE-02'] }, async ({
  page,
}) => {
  await page.goto('graveyard');
  await expect(stone(page, 'approved')).toHaveClass(/solid/);
  const plot = plotOf(page, 'approved');
  for (const a of ['allow-once', 'edit', 'retire'])
    await expect(plot.locator(`[data-action="${a}"]`)).toBeVisible();
  await plot.locator('[data-action="edit"]').click();
  const box = plot.getByLabel('Reason (1–280 characters)');
  await box.fill('It broke query grouping: self.group_by holds Cols, not aliases.');
  await plot.getByRole('button', { name: /Save reason/ }).click();
  await expect(plot).toContainText('It broke query grouping');
});

test('STATE-03: retired is faded with Unretire', { tag: ['@STATE-03'] }, async ({ page }) => {
  await page.goto('graveyard');
  await expect(stone(page, 'retired')).toHaveClass(/faded/);
  await expect(stone(page, 'retired').getByTestId('state-label')).toHaveText('Retired');
  const plot = plotOf(page, 'retired');
  await expect(plot.locator('[data-action="unretire"]')).toBeVisible();
  await plot.locator('[data-action="unretire"]').click();
  await expect(page.getByRole('status').filter({ hasText: 'unretired to draft' })).toBeAttached();
});

test('STATE-04: stale is cracked; Re-approve returns it to approved', { tag: ['@STATE-04'] }, async ({
  page,
}) => {
  await page.goto('graveyard');
  const s = stone(page, 'stale');
  await expect(s).toHaveClass(/cracked/);
  await expect(s.getByTestId('state-label')).toHaveText('Stale: code changed, warn only');
  await expect(s).toContainText('illustrative state');
  const label = (await s.getAttribute('aria-label')) ?? '';
  const id = label.match(/dnr-[0-9a-f]{10}/)?.[0] as string;
  const plot = plotOf(page, 'stale');
  await expect(plot.locator('[data-action="retire"]')).toBeVisible();
  await plot.locator('[data-action="reapprove"]').click();
  await expect(page.locator(`article.stone[aria-label^="Order ${id}"]`)).toHaveAttribute(
    'data-state',
    'approved',
  );
  await page.goto(`orders/${id}`);
  await expect(page.locator('table').first()).toContainText('reapproved');
});

test('STATE-05: re-landed shows a lit candle and its label', { tag: ['@STATE-05'] }, async ({ page }) => {
  await page.goto('graveyard');
  const s = stone(page, 'relanded');
  await expect(s.locator('svg.candle-svg')).toBeVisible();
  await expect(s.getByTestId('state-label')).toHaveText('Re-landed: warn only until re-approved');
  await expect(plotOf(page, 'relanded').locator('[data-action="reapprove"]')).toBeVisible();
});

test('STATE-06: drift has a red border, a label, View diff and Restore from git', {
  tag: ['@STATE-06'],
}, async ({ page }) => {
  await page.goto('graveyard');
  const s = page.locator('article.stone[data-drift="true"]').first();
  await expect(s).toHaveClass(/drift/);
  await expect(s.getByTestId('drift-label')).toHaveText('Differs from git');
  const plot = page.locator('li.plot', { has: s });
  await plot.locator('[data-action="view-diff"]').click();
  await expect(plot.getByRole('region', { name: 'Diff against git' })).toBeVisible();
  await expect(plot.locator('[data-action="restore"]')).toBeVisible();
});

test('STATE-07: the three empty states', { tag: ['@STATE-07', '@empty-states'] }, async ({ page }) => {
  await page.goto('graveyard?empty=none');
  await expect(page.getByTestId('empty-no-orders')).toContainText('No orders yet');
  await expect(page.getByTestId('empty-no-orders')).toContainText('dnr scan');
  await expectNoAxeViolations(page);
  await page.goto('graveyard?empty=reverts');
  await expect(page.getByTestId('empty-no-reverts')).toContainText('No reverts found in this history');
  await expect(page.getByTestId('empty-no-reverts')).toContainText('dnr orders add');
  await expectNoAxeViolations(page);
  await page.goto('graveyard?empty=drafts');
  await expect(page.getByTestId('banner-drafts-only')).toContainText('3 drafts, 0 enforced');
  await expectNoAxeViolations(page);
});

test('empty-states: all retired, board down, no trial data', { tag: ['@empty-states'] }, async ({ page }) => {
  await page.goto('graveyard?empty=retired');
  await expect(page.getByTestId('banner-all-retired')).toBeVisible();
  await page.goto(`orders/${DEMO_ORDER}?board=1`);
  await expect(page.getByTestId('banner-board-down')).toBeVisible();
  await page.route(/\/data\/trial(\.sample)?\.json$/, (r) => r.fulfill({ status: 404, body: 'not found' }));
  await page.goto('trial');
  await expect(page.getByTestId('empty-trial')).toContainText('No trial data yet');
  await expectNoAxeViolations(page);
});

test('ROUTE-06: order page has the history and audit panel', { tag: ['@ROUTE-06', '@P7-routes'] }, async ({
  page,
}) => {
  await page.goto(`orders/${DEMO_ORDER}`);
  await expect(page.getByRole('heading', { name: 'History and audit' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Grants (allow-once and ask)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Crew overrides' })).toBeVisible();
  await expect(page.locator('table').first()).toContainText('created');
  await page.locator('[data-action="allow-once"]').click();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
  await expect(page.getByTestId('grants')).toContainText('pending (next session)');
});

test('deeplink-1: hosted /orders/:id?board=<port> with the board down → read-only + banner', {
  tag: ['@deeplink-1', '@ROUTE-10'],
}, async ({ page }) => {
  await page.goto(`orders/${DEMO_ORDER}?board=9`);
  await expect(page.getByTestId('banner-board-down')).toContainText(`dnr board --open ${DEMO_ORDER}`);
  await expect(page.locator('[data-action]')).toHaveCount(0);
  await page.goto('orders/dnr-0123456789?board=9');
  await expect(page.getByTestId('banner-board-down')).toContainText('dnr board --open dnr-0123456789');
});

test('ROUTE-04: /orders/view renders a raw GitHub order; Zod-invalid and foreign hosts show errors', {
  tag: ['@ROUTE-04', '@ROUTE-orders-view'],
}, async ({ page }) => {
  const ok =
    'https://raw.githubusercontent.com/example/django-demo-crew/main/.dnr/orders/dnr-43933a1dca.json';
  const bad = 'https://raw.githubusercontent.com/example/django-demo-crew/main/.dnr/orders/broken.json';
  await page.route(ok, (r) =>
    r.fulfill({ status: 200, contentType: 'text/plain', body: JSON.stringify(demoBundle.order) }),
  );
  await page.route(bad, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: JSON.stringify({ ...demoBundle.order, id: 'nope' }),
    }),
  );
  await page.goto(`orders/view?src=${encodeURIComponent(ok)}`);
  await expect(page.getByTestId('view-ok')).toContainText(DEMO_ORDER);
  await expectNoAxeViolations(page);
  await page.goto(`orders/view?src=${encodeURIComponent(bad)}`);
  await expect(page.getByTestId('view-error-invalid')).toContainText('id');
  await page.goto(`orders/view?src=${encodeURIComponent('https://evil.example/x.json')}`);
  await expect(page.getByTestId('view-error-host')).toBeVisible();
  await page.goto('orders/view');
  await expect(page.getByTestId('view-error-missing')).toBeVisible();
});

test('ROUTE-07: /trial renders the clearly-labeled sample and Recompute in browser matches', {
  tag: ['@ROUTE-07', '@ROUTE-trial'],
}, async ({ page }) => {
  await page.goto('trial');
  await expect(page.getByTestId('banner-sample')).toContainText('SAMPLE DATA');
  await expect(page.getByRole('heading', { name: 'Headline (sample)' })).toBeVisible();
  await page.getByTestId('recompute').click();
  await expect(page.getByTestId('recompute-table')).not.toContainText('differs');
  await expect(page.getByTestId('recompute-table').getByText('✓ matches')).toHaveCount(4);
});

test('ROUTE-08: /replay decides a pasted PreToolUse event', { tag: ['@ROUTE-08', '@ROUTE-replay'] }, async ({
  page,
}) => {
  await page.goto('replay');
  await expect(page.getByTestId('replay-run')).toBeEnabled();
  await page.getByLabel('Example event').selectOption('original-change');
  await expect(page.getByLabel('PreToolUse stdin')).toHaveValue(/"command": "str_replace"/);
  await page.getByTestId('replay-run').click();
  await expect(page.getByTestId('replay-result').getByTestId('verdict')).toHaveAttribute(
    'data-verdict',
    'BLOCK',
  );
  await page.getByLabel('PreToolUse stdin').fill('{"tool_name":"fs_read","tool_input":{}}');
  await page.getByTestId('replay-run').click();
  await expect(page.getByTestId('replay-note')).toBeVisible();
});

test('ROUTE-09: /kiro maps each Kiro surface to its file', { tag: ['@ROUTE-09', '@ROUTE-kiro'] }, async ({
  page,
}) => {
  await page.goto('kiro');
  await expect(page.getByRole('heading', { name: 'CLI hook' })).toBeVisible();
  await expect(page.getByText('.kiro/hooks/dnr-pre-write.json')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Steering' })).toBeVisible();
});

const ROUTES = [
  './',
  'play',
  `play/${DEMO}`,
  'graveyard',
  `orders/${DEMO_ORDER}`,
  'orders/view',
  'trial',
  'replay',
  'kiro',
  'no-such-page',
];
for (const r of ROUTES) {
  test(`A11Y-01: axe reports 0 violations on /${r.replace('./', '')}`, {
    tag: ['@axe', '@A11Y-01', '@P7-07'],
  }, async ({ page }) => {
    await page.goto(r);
    await expect(page.locator('#page-title')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoAxeViolations(page);
  });
}

test('A11Y-01: axe on /play after a BLOCK decision', { tag: ['@axe', '@A11Y-01'] }, async ({ page }) => {
  await openPlay(page);
  await runPreset(page, 'original');
  await expectNoAxeViolations(page);
});

test('A11Y-01: reduced motion stops the mist, candle and terminal animations', { tag: ['@A11Y-01'] }, async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('graveyard');
  const anim = await page.locator('.mist').evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toBe('none');
  const flame = await page
    .locator('.flame')
    .first()
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(flame).toBe('none');
});
