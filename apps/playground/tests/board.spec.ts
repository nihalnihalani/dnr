/**
 * The local board in a real browser: the same UI build served by `startBoard` with the API
 * adapter. These need the local build, so they are skipped against a deployed PLAYGROUND_URL.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type BoardHandle, MemoryStore, startBoard } from '@dnr/board';
import type { OrderRow } from '@dnr/ui/model';
import { expect, test } from '@playwright/test';
import { DEMO_ORDER, expectNoAxeViolations, isRemote } from './helpers';

test.skip(isRemote, 'board tests need the local build');

const seed = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/cases/graveyard.json', import.meta.url)), 'utf8'),
) as { rows: OrderRow[] };
const rows = (): OrderRow[] =>
  seed.rows.map((r) => ({ order: r.order, effective: r.effective, drift: r.drift }));

let board: BoardHandle;
test.beforeEach(async ({ baseURL }, info) => {
  board = await startBoard({
    store: new MemoryStore({ rows: rows() }),
    version: 'test',
    playgroundOrigin: new URL(baseURL as string).origin,
    // WebKit has no *.localhost resolution on every platform; the auto probe falls back there.
    host: info.title.includes('127.0.0.1') ? '127.0.0.1' : 'auto',
    ...(info.title.includes('--open') ? { openOrder: DEMO_ORDER } : {}),
  });
});
test.afterEach(async () => {
  await board?.close();
});

test('AUTH-02: launch probes the per-launch *.localhost host or falls back to the loopback IP', {
  tag: ['@AUTH-02'],
}, async ({ page }) => {
  await page.goto(board.launchUrl);
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  const host = new URL(page.url()).host;
  expect([board.launchHost, `127.0.0.1:${board.port}`]).toContain(host);
  await expect(page.locator('.mode-pill')).toHaveText('Local board');
  // The nonce is single-use.
  const again = await page.request.get(board.launchUrl);
  expect(again.status()).toBe(403);
});

test('AUTH-02: --host 127.0.0.1 keeps the session on 127.0.0.1', { tag: ['@AUTH-02'] }, async ({ page }) => {
  await page.goto(board.launchUrl);
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  expect(new URL(page.url()).host).toBe(`127.0.0.1:${board.port}`);
});

test('deeplink-3: dnr board --open lands on the order with working actions', {
  tag: ['@deeplink-3', '@board-flow'],
}, async ({ page }) => {
  await page.goto(board.launchUrl);
  await expect(page.getByRole('heading', { name: `Order ${DEMO_ORDER}` })).toBeVisible();
  await page.locator('[data-action="allow-once"]').click();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
  await expect(page.locator('[data-action="allow-once"]')).not.toContainText('simulated');
});

test('deeplink-2: after launch, a deep link in a new page has working actions', {
  tag: ['@deeplink-2'],
}, async ({ page, context }) => {
  await page.goto(board.launchUrl);
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const p2 = await context.newPage();
  await p2.goto(`${origin}/orders/${DEMO_ORDER}`);
  await p2.locator('[data-action="retire"]').click();
  await expect(p2.getByText('Retired', { exact: true }).first()).toBeVisible();
});

test('deeplink-4: the hosted page probes /api/health and moves to the board origin', {
  tag: ['@deeplink-4', '@ROUTE-10'],
}, async ({ page }) => {
  await page.goto(board.launchUrl);
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  await page.goto(`orders/${DEMO_ORDER}?board=${board.port}`);
  await page.waitForURL(`${origin}/orders/${DEMO_ORDER}`);
  await page.locator('[data-action="allow-once"]').click();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
});

test('board-flow: approve a draft, allow once, retire, with history recorded', {
  tag: ['@board-flow', '@P12-01'],
}, async ({ page }) => {
  await page.goto(board.launchUrl);
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  const draft = page.locator('li.plot', { has: page.locator('article.stone[data-state="draft"]') }).first();
  const id = ((await draft.locator('article').getAttribute('aria-label')) ?? '').match(
    /dnr-[0-9a-f]{10}/,
  )?.[0];
  await draft.locator('[data-action="approve"]').click();
  await expect(page.locator(`article.stone[aria-label^="Order ${id}"]`)).toHaveAttribute(
    'data-state',
    'approved',
  );
  await page.goto(`${new URL(page.url()).origin}/orders/${id}`);
  await page.locator('[data-action="allow-once"]').click();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
  await page.locator('[data-action="retire"]').click();
  await expect(page.locator('table').first()).toContainText('retired');
  await expect(page.locator('table').first()).toContainText('approved');
});

test('STATE-08: 401 banner without a board session, 409 banner on a stale transition', {
  tag: ['@STATE-08'],
}, async ({ page, browser }) => {
  const anon = await browser.newPage();
  await anon.goto(`http://127.0.0.1:${board.port}/graveyard`);
  await expect(anon.getByTestId('banner-401')).toContainText('board not unlocked');
  await anon.close();

  await page.goto(board.launchUrl);
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/orders/${DEMO_ORDER}`);
  await expect(page.locator('[data-action="retire"]')).toBeVisible();
  // Another tab retires the order; this tab still shows Retire, which is now invalid.
  const res = await page.evaluate(async (id) => {
    const r = await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-DNR-CSRF': '1' },
      body: JSON.stringify({ status: 'retired' }),
    });
    return r.status;
  }, DEMO_ORDER);
  expect(res).toBe(200);
  await page.locator('[data-action="retire"]').click();
  await expect(page.getByTestId('banner-409')).toContainText('Invalid transition');
});

test('a11y-board: keyboard-only approve on the board; axe 0', { tag: ['@a11y-board', '@P12-03'] }, async ({
  page,
  browserName,
}) => {
  test.skip(browserName === 'webkit', 'WebKit does not Tab to buttons by default');
  await page.goto(board.launchUrl);
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  await expectNoAxeViolations(page);
  const approve = page.locator('[data-action="approve"]').first();
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    if (await approve.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(approve).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'approved' })).toBeAttached();
  await page.goto(`${new URL(page.url()).origin}/orders/${DEMO_ORDER}`);
  await expectNoAxeViolations(page);
});
