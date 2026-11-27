import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import {
  approveSim,
  closedPort,
  DEMO,
  DEMO_ORDER,
  expectNoAxeViolations,
  isRemote,
  openPlay,
  runPreset,
} from './helpers';

const demoBundle = JSON.parse(
  readFileSync(fileURLToPath(new URL(`../public/cases/${DEMO}.json`, import.meta.url)), 'utf8'),
);

const stone = (page: Page, state: string) => page.locator(`article.stone[data-state="${state}"]`).first();
const plotOf = (page: Page, state: string) => page.locator('li.plot', { has: stone(page, state) }).first();

test('ROUTE-01: home has the pitch and the three buttons; no CLI output unless a real capture exists', {
  tag: ['@ROUTE-01', '@P7-routes'],
}, async ({ page }) => {
  await page.goto('./');
  for (const name of ['Try a revert', 'See the trial', 'How Kiro built it'])
    await expect(page.getByRole('link', { name })).toBeVisible();
  // No capture of `dnr check` on an approved demo checkout exists yet (it needs a human
  // approval), so nothing is shown in its place.
  const capture = await page.request.get('data/cli-capture.json');
  const hasCapture = capture.ok() && (capture.headers()['content-type'] ?? '').includes('json');
  await expect(page.getByTestId('cli-capture')).toHaveCount(hasCapture ? 1 : 0);
  await expect(page.locator('.terminal')).toHaveCount(hasCapture ? 1 : 0);
  await page.getByRole('link', { name: 'Try a revert' }).click();
  await expect(page).toHaveURL(new RegExp(`/play/${DEMO}$`));
});

test('ROUTE-05: headstones carry epitaph, birth, death and links, each with a text label', {
  tag: ['@ROUTE-05', '@P7-routes'],
}, async ({ page }) => {
  await page.goto('graveyard');
  const s = page.locator('article.stone', { hasText: DEMO_ORDER });
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
  // The real stored status, as `dnr orders list` computed it.
  await expect(s.getByTestId('state-label')).toHaveText('Draft: not enforced');
});

test('STATE-01: the real demo orders are drafts: outlined, labeled, Approve / Edit / Retire; drafts-only banner', {
  tag: ['@STATE-01', '@STATE-07'],
}, async ({ page }) => {
  await page.goto('graveyard');
  await expect(page.locator('article.stone')).toHaveCount(2);
  await expect(stone(page, 'draft')).toHaveClass(/outlined/);
  await expect(stone(page, 'draft').getByTestId('state-label')).toHaveText('Draft: not enforced');
  const plot = plotOf(page, 'draft');
  for (const a of ['approve', 'edit', 'retire'])
    await expect(plot.locator(`[data-action="${a}"]`)).toBeVisible();
  await expect(page.getByTestId('banner-drafts-only')).toContainText('2 drafts, 0 enforced');
  await expectNoAxeViolations(page);
});

test('STATE-02: approved (simulated in this browser) is solid with Allow once / Edit / Retire', {
  tag: ['@STATE-02'],
}, async ({ page }) => {
  await page.goto('graveyard');
  const plot = plotOf(page, 'draft');
  await plot.locator('[data-action="approve"]').click();
  await expect(page.getByRole('status').filter({ hasText: 'approved (simulated)' })).toBeAttached();
  await expect(stone(page, 'approved')).toHaveClass(/solid/);
  const ap = plotOf(page, 'approved');
  for (const a of ['allow-once', 'edit', 'retire'])
    await expect(ap.locator(`[data-action="${a}"]`)).toBeVisible();
  await ap.locator('[data-action="edit"]').click();
  await ap
    .getByLabel('Reason (1–280 characters)')
    .fill('It broke query grouping: self.group_by holds Cols, not aliases.');
  await ap.getByRole('button', { name: /Save reason/ }).click();
  await expect(ap).toContainText('It broke query grouping');
});

test('STATE-03: retired (simulated) is faded with Unretire, which returns it to draft', {
  tag: ['@STATE-03'],
}, async ({ page }) => {
  await page.goto('graveyard');
  await plotOf(page, 'draft').locator('[data-action="retire"]').click();
  await expect(stone(page, 'retired')).toHaveClass(/faded/);
  await expect(stone(page, 'retired').getByTestId('state-label')).toHaveText('Retired');
  await plotOf(page, 'retired').locator('[data-action="unretire"]').click();
  await expect(page.getByRole('status').filter({ hasText: 'unretired to draft' })).toBeAttached();
  await expect(page.locator('article.stone[data-state="draft"]')).toHaveCount(2);
});

test('empty-states: board down, no trial data', { tag: ['@empty-states'] }, async ({ page }) => {
  await page.goto(`orders/${DEMO_ORDER}?board=1`);
  await expect(page.getByTestId('banner-board-down')).toBeVisible();
  await page.goto('trial');
  await expect(page.getByTestId('empty-trial')).toContainText('has not run yet');
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
  // The real order is a draft; approve it (simulated) to reach Allow once.
  await page.locator('[data-action="approve"]').click();
  await page.locator('[data-action="allow-once"]').click();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
  await expect(page.getByTestId('grants')).toContainText('pending (next session)');
});

test('deeplink-1: hosted /orders/:id?board=<port> with the board down → read-only + banner', {
  tag: ['@deeplink-1', '@ROUTE-10', '@P13-10'],
}, async ({ page }) => {
  // A real closed port: bound, then released, so the probe's fetch is refused, not skipped.
  const port = await closedPort();
  await page.goto(`orders/${DEMO_ORDER}?board=${port}`);
  const banner = page.getByTestId('banner-board-down');
  await expect(banner).toContainText(`Run dnr board --open ${DEMO_ORDER} to act on this order`);
  // The bundled demo order is shown, read-only: its headstone and history, and no actions.
  await expect(banner).toContainText('Showing the bundled demo copy, read-only.');
  await expect(page.getByRole('heading', { name: `Order ${DEMO_ORDER}` })).toBeVisible();
  await expect(page.locator('table').first()).toContainText('created');
  await expect(page.getByText('Read-only: actions need the local board.')).toBeVisible();
  await expect(page.locator('[data-action]')).toHaveCount(0);
  // Where a browser blocks the probe (Safari), the banner still links to a board on that port.
  await expect(page.getByTestId('board-link')).toHaveAttribute(
    'href',
    `http://127.0.0.1:${port}/orders/${DEMO_ORDER}`,
  );
  await expectNoAxeViolations(page);
  // An unknown ID shows only the banner.
  await page.goto(`orders/dnr-0123456789?board=${port}`);
  await expect(page.getByTestId('banner-board-down')).toContainText(
    'Run dnr board --open dnr-0123456789 to act on this order',
  );
  await expect(page.getByTestId('banner-board-down')).not.toContainText('read-only');
  await expect(page.locator('article.stone')).toHaveCount(0);
  await expect(page.locator('[data-action]')).toHaveCount(0);
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

test('ROUTE-07: until a real reports/trial.json exists, /trial shows the empty state and no numbers', {
  tag: ['@ROUTE-07', '@ROUTE-trial', '@empty-states'],
}, async ({ page }) => {
  await page.goto('trial');
  const empty = page.getByTestId('empty-trial');
  await expect(empty).toContainText('The pre-registered trial has not run yet');
  await expect(empty).toContainText('Recompute in browser');
  await expect(page.getByTestId('prereg')).toContainText('prereg-v1');
  await expect(page.getByLabel(/fake/i)).toHaveCount(0);
  await expect(page.getByTestId('trial-real')).toHaveCount(0);
  // No figure from the sample file is on the page.
  await expect(page.locator('main')).not.toContainText(/\d+ of \d+/);
  await expectNoAxeViolations(page);
});

test('ROUTE-08: /replay decides a pasted PreToolUse event', { tag: ['@ROUTE-08', '@ROUTE-replay'] }, async ({
  page,
}) => {
  const decide = async () => {
    await page.goto('replay');
    await expect(page.getByTestId('replay-run')).toBeEnabled();
    await page.getByLabel('Example event').selectOption('original-change');
    await expect(page.getByLabel('PreToolUse stdin')).toHaveValue(/"command": "str_replace"/);
    await page.getByTestId('replay-run').click();
    return page.getByTestId('replay-result');
  };
  // The real order is a draft: the hook allows the write, and the page says why.
  const draft = await decide();
  await expect(draft.getByTestId('verdict')).toHaveAttribute('data-verdict', 'ALLOW');
  await expect(draft).toContainText('not enforced');
  // Approved in this browser (simulated), the same event is blocked.
  await openPlay(page);
  await approveSim(page);
  const approved = await decide();
  await expect(approved.getByTestId('verdict')).toHaveAttribute('data-verdict', 'BLOCK');
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
  await approveSim(page);
  await runPreset(page, 'original');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'BLOCK');
  await expectNoAxeViolations(page);
});

test('A11Y-01: reduced motion stops the mist animation', { tag: ['@A11Y-01'] }, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('graveyard');
  const anim = await page.locator('.mist').evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toBe('none');
  // The candle's flame (re-landed orders) is checked on the board, where a real re-land exists.
});

test('polish: unknown routes get the 404 page with ways back; static hosts answer HTTP 404', {
  tag: ['@polish', '@not-found'],
}, async ({ page }) => {
  const res = await page.goto('no-such-page');
  // The GitHub Pages mirror serves 404.html with status 404; vite preview falls back with 200.
  if (isRemote) expect(res?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toContainText('404 · page not found');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing buried here');
  await expect(page).toHaveTitle('Page not found · DNR');
  await expectNoAxeViolations(page);
  await page.getByTestId('not-found').getByRole('link', { name: 'Try a revert' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(new URL(page.url()).pathname).toMatch(/\/play$/);
});

test('polish: favicon, touch icon and social preview tags resolve to real files', {
  tag: ['@polish', '@meta'],
}, async ({ page, request }) => {
  await page.goto('./');
  const attr = (sel: string, a: string) => page.locator(sel).first().getAttribute(a);
  const icon = await attr('link[rel="icon"]', 'href');
  const touch = await attr('link[rel="apple-touch-icon"]', 'href');
  for (const [href, type] of [
    [icon, 'image/svg+xml'],
    [touch, 'image/png'],
  ] as const) {
    const r = await request.get(new URL(href as string, page.url()).href);
    expect(r.status(), href ?? '').toBe(200);
    expect(r.headers()['content-type']).toContain(type);
  }
  for (const p of ['og:title', 'og:description', 'og:image', 'og:url'])
    expect(await attr(`meta[property="${p}"]`, 'content'), p).toBeTruthy();
  expect(await attr('meta[name="twitter:card"]', 'content')).toBe('summary_large_image');
  const og = (await attr('meta[property="og:image"]', 'content')) as string;
  expect(og).toMatch(/^https:\/\/.+\/og\.png$/);
  // The image itself ships in this build (fetched from this deployment, not the absolute URL).
  const img = await request.get(new URL('og.png', new URL('./', page.url())).href);
  expect(img.status()).toBe(200);
  expect(img.headers()['content-type']).toContain('image/png');
});
