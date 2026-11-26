/**
 * The local board in a real browser: the same UI build served by `startBoard`, with the store
 * `dnr board` uses (`createBoardStore`) over a real git repository holding a real revert and a
 * real order (apps/board/src/real-repo.ts). Every state is made the real way: approval by the
 * test acting as the maintainer, stale and re-landed by commits, drift by editing the order file.
 * Skipped against a deployed PLAYGROUND_URL (needs the local build).
 */
import { type BoardHandle, startBoard } from '@dnr/board';
import { expect, type Page, test } from '@playwright/test';
import { RealRepo } from '../../board/src/real-repo';
import { expectNoAxeViolations, isRemote } from './helpers';

test.skip(isRemote, 'board tests need the local build');

interface Setup {
  /** Prepare the repository before the board starts. */
  prepare?: (repo: RealRepo) => Promise<void> | void;
  withOrder?: boolean;
  host?: 'auto' | '127.0.0.1';
  openOwnOrder?: boolean;
  /** Environment the board runs in (grant provenance reads it). */
  env?: NodeJS.ProcessEnv;
}

let board: BoardHandle | null = null;
let repo: RealRepo | null = null;

async function launch(page: Page, baseURL: string | undefined, s: Setup = {}) {
  repo = await RealRepo.create({ withOrder: s.withOrder ?? true });
  await s.prepare?.(repo);
  board = await startBoard({
    store: await repo.boardStore(s.env ?? {}),
    version: 'test',
    playgroundOrigin: new URL(baseURL as string).origin,
    host: s.host ?? 'auto',
    ...(s.openOwnOrder ? { openOrder: repo.order.id } : {}),
    user: 'test-maintainer',
  });
  await page.goto(board.launchUrl);
  return { board, repo, id: repo.order.id };
}

const approved = async (r: RealRepo) => {
  await r.approve();
  r.commitOrders('Approve the order');
};

test.afterEach(async () => {
  await board?.close();
  repo?.dispose();
  board = null;
  repo = null;
});

const graveyard = (page: Page) => expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
const stone = (page: Page, id: string) => page.locator(`article.stone[aria-label^="Order ${id}"]`);
const plot = (page: Page, id: string) => page.locator('li.plot', { has: stone(page, id) });

test('AUTH-02: launch probes the per-launch *.localhost host or falls back to the loopback IP', {
  tag: ['@AUTH-02'],
}, async ({ page, baseURL }) => {
  const { board } = await launch(page, baseURL);
  await graveyard(page);
  expect([board.launchHost, `127.0.0.1:${board.port}`]).toContain(new URL(page.url()).host);
  await expect(page.locator('.mode-pill')).toHaveText('Local board');
  expect((await page.request.get(board.launchUrl)).status()).toBe(403); // single-use nonce
});

test('AUTH-02: --host 127.0.0.1 keeps the session on 127.0.0.1', { tag: ['@AUTH-02'] }, async ({
  page,
  baseURL,
}) => {
  const { board } = await launch(page, baseURL, { host: '127.0.0.1' });
  await graveyard(page);
  expect(new URL(page.url()).host).toBe(`127.0.0.1:${board.port}`);
});

test('STATE-01: a freshly built order is a draft: outlined, labeled, Approve / Edit / Retire', {
  tag: ['@STATE-01', '@board-flow'],
}, async ({ page, baseURL }) => {
  const { id } = await launch(page, baseURL);
  await graveyard(page);
  await expect(stone(page, id)).toHaveClass(/outlined/);
  await expect(stone(page, id).getByTestId('state-label')).toHaveText('Draft: not enforced');
  for (const a of ['approve', 'edit', 'retire'])
    await expect(plot(page, id).locator(`[data-action="${a}"]`)).toBeVisible();
  await expect(page.getByTestId('banner-drafts-only')).toContainText('1 draft, 0 enforced');
});

test('board-flow: approve the draft, allow once, retire, unretire; history and grants recorded', {
  tag: ['@board-flow', '@P12-01', '@STATE-02', '@STATE-03'],
}, async ({ page, baseURL }) => {
  const { id } = await launch(page, baseURL);
  await graveyard(page);
  await plot(page, id).locator('[data-action="approve"]').click();
  await expect(stone(page, id)).toHaveAttribute('data-state', 'approved');
  await expect(stone(page, id)).toHaveClass(/solid/);
  // The approval changed the order file; until it is committed it differs from git.
  await expect(stone(page, id).getByTestId('drift-label')).toHaveText('Differs from git');
  await page.goto(`${new URL(page.url()).origin}/orders/${id}`);
  for (const a of ['allow-once', 'edit', 'retire'])
    await expect(page.locator(`[data-action="${a}"]`).first()).toBeVisible();
  await page.locator('[data-action="allow-once"]').first().click();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
  await expect(page.locator('[data-action="allow-once"]').first()).not.toContainText('simulated');
  await page.locator('[data-action="retire"]').first().click();
  await expect(page.locator('.stone')).toHaveClass(/faded/);
  await expect(page.locator('.stone').getByTestId('state-label')).toHaveText('Retired');
  await page.locator('[data-action="unretire"]').first().click();
  await expect(page.locator('.stone').getByTestId('state-label')).toHaveText('Draft: not enforced');
  const history = page.locator('table').first();
  for (const a of ['created', 'approved', 'retired', 'unretired']) await expect(history).toContainText(a);
});

test('STATE-04: later code moves the unit: cracked "Stale" headstone; Re-approve rebases it', {
  tag: ['@STATE-04'],
}, async ({ page, baseURL }) => {
  const { id } = await launch(page, baseURL, {
    prepare: async (r) => {
      await approved(r);
      r.makeStale();
    },
  });
  await graveyard(page);
  await expect(stone(page, id)).toHaveClass(/cracked/);
  await expect(stone(page, id).getByTestId('state-label')).toHaveText('Stale: code changed, warn only');
  await expect(plot(page, id).locator('[data-action="retire"]')).toBeVisible();
  await plot(page, id).locator('[data-action="reapprove"]').click();
  await expect(stone(page, id)).toHaveAttribute('data-state', 'approved');
  await page.goto(`${new URL(page.url()).origin}/orders/${id}`);
  await expect(page.locator('table').first()).toContainText('reapproved');
});

test('STATE-05: C committed again: a lit candle and "Re-landed"', { tag: ['@STATE-05'] }, async ({
  page,
  baseURL,
}) => {
  const { id } = await launch(page, baseURL, {
    prepare: async (r) => {
      await approved(r);
      r.makeRelanded();
    },
  });
  await graveyard(page);
  await expect(stone(page, id).locator('svg.candle-svg')).toBeVisible();
  await expect(stone(page, id).getByTestId('state-label')).toHaveText(
    'Re-landed: warn only until re-approved',
  );
  await expect(plot(page, id).locator('[data-action="reapprove"]')).toBeVisible();
  // Reduced motion stops the flame (A11Y-01).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const flame = await stone(page, id)
    .locator('.flame')
    .first()
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(flame).toBe('none');
});

test('STATE-06: the order file edited but not committed: red border, "Differs from git", View diff', {
  tag: ['@STATE-06'],
}, async ({ page, baseURL }) => {
  const { id } = await launch(page, baseURL, {
    prepare: async (r) => {
      await approved(r);
      r.makeDrift();
    },
  });
  await graveyard(page);
  await expect(stone(page, id)).toHaveClass(/drift/);
  await expect(stone(page, id).getByTestId('drift-label')).toHaveText('Differs from git');
  await plot(page, id).locator('[data-action="view-diff"]').click();
  const diff = plot(page, id).getByRole('region', { name: 'Diff against git' });
  await expect(diff).toContainText('(edited locally)');
  await expect(diff).toContainText(`git checkout -- .dnr/orders/${id}.json`);
  await expect(plot(page, id).locator('[data-action="restore"]')).toBeVisible();
});

test('STATE-07: a repository with reverts but no orders yet shows "No orders yet" and dnr scan', {
  tag: ['@STATE-07', '@empty-states'],
}, async ({ page, baseURL }) => {
  await launch(page, baseURL, { withOrder: false });
  await graveyard(page);
  await expect(page.getByTestId('empty-no-orders')).toContainText('No orders yet');
  await expect(page.getByTestId('empty-no-orders')).toContainText('dnr scan');
  await expectNoAxeViolations(page);
});

test('deeplink-3: dnr board --open lands on the order with working actions', {
  tag: ['@deeplink-3', '@board-flow'],
}, async ({ page, baseURL }) => {
  const { id } = await launch(page, baseURL, { openOwnOrder: true, prepare: approved });
  await expect(page.getByRole('heading', { name: `Order ${id}` })).toBeVisible();
  await page.locator('[data-action="allow-once"]').first().click();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
});

test('deeplink-2: after launch, a deep link in a new page has working actions', {
  tag: ['@deeplink-2'],
}, async ({ page, context, baseURL }) => {
  const { id } = await launch(page, baseURL, { prepare: approved });
  await graveyard(page);
  const p2 = await context.newPage();
  await p2.goto(`${new URL(page.url()).origin}/orders/${id}`);
  await p2.locator('[data-action="retire"]').first().click();
  await expect(p2.locator('.stone').getByTestId('state-label')).toHaveText('Retired');
});

test('deeplink-4: the hosted page probes /api/health and moves to the board origin', {
  tag: ['@deeplink-4', '@ROUTE-10'],
}, async ({ page, baseURL }) => {
  const { board, id } = await launch(page, baseURL, { prepare: approved });
  await graveyard(page);
  const origin = new URL(page.url()).origin;
  await page.goto(`orders/${id}?board=${board.port}`);
  await page.waitForURL(`${origin}/orders/${id}`);
  await page.locator('[data-action="allow-once"]').first().click();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
});

test('STATE-08: 401 banner without a board session, 409 banner on a stale transition', {
  tag: ['@STATE-08'],
}, async ({ page, browser, baseURL }) => {
  const { board, id } = await launch(page, baseURL, { prepare: approved });
  await graveyard(page);
  const anon = await browser.newPage();
  await anon.goto(`http://127.0.0.1:${board.port}/graveyard`);
  await expect(anon.getByTestId('banner-401')).toContainText('board not unlocked');
  await anon.close();

  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/orders/${id}`);
  await expect(page.locator('[data-action="retire"]').first()).toBeVisible();
  // Another tab retires the order; this tab still offers Retire, which is now invalid.
  const res = await page.evaluate(async (oid) => {
    const r = await fetch(`/api/orders/${oid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-DNR-CSRF': '1' },
      body: JSON.stringify({ status: 'retired' }),
    });
    return r.status;
  }, id);
  expect(res).toBe(200);
  await page.locator('[data-action="retire"]').first().click();
  await expect(page.getByTestId('banner-409')).toContainText('Invalid transition');
});

test('a11y-board: keyboard-only approve on the board; axe 0', { tag: ['@a11y-board', '@P12-03'] }, async ({
  page,
  browserName,
  baseURL,
}) => {
  test.skip(browserName === 'webkit', 'WebKit does not Tab to buttons by default');
  const { id } = await launch(page, baseURL);
  await graveyard(page);
  await expectNoAxeViolations(page);
  const approve = page.locator('[data-action="approve"]').first();
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    if (await approve.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(approve).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(stone(page, id)).toHaveAttribute('data-state', 'approved');
  await page.goto(`${new URL(page.url()).origin}/orders/${id}`);
  await expectNoAxeViolations(page);
});

test('N5: a grant made from inside a Kiro agent environment is suspect until a human confirms it', {
  tag: ['@N5'],
}, async ({ page, baseURL }) => {
  const { id } = await launch(page, baseURL, {
    prepare: approved,
    env: { KIRO_SESSION_ID: 'agent-session-1' },
  });
  await graveyard(page);
  await page.goto(`${new URL(page.url()).origin}/orders/${id}`);
  await page.locator('[data-action="allow-once"]').first().click();
  const origin = page.getByTestId('grant-origin');
  await expect(origin).toContainText('Suspect, not applied until confirmed');
  await expect(origin).toContainText('env:KIRO_SESSION_ID');
  await page.reload();
  await expect(page.getByTestId('grant-origin')).toContainText('Suspect, not applied until confirmed');
  await expectNoAxeViolations(page);
  await page.reload();
  await origin.locator('[data-action="confirm-grant"]').click();
  await expect(origin).toContainText('confirmed by');
  await expect(origin.locator('[data-action="confirm-grant"]')).toHaveCount(0);
  // axe on a freshly loaded page showing the confirmed grant (Playwright's Firefox crashes when
  // axe runs on this page after in-place re-renders).
  await page.reload();
  await expect(page.getByTestId('grant-origin')).toContainText('confirmed by');
  await expectNoAxeViolations(page);
});
