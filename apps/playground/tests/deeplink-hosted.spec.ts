/**
 * Deep link case 4 on the real hosted Playground (plan §10 "Hosted order view", Phase 13): the
 * deployed HTTPS page at PLAYGROUND_URL probes a real local board on 127.0.0.1, then navigates to
 * the board origin, where the actions work. This is the public-to-loopback request that Local
 * Network Access (Chromium) and Private Network Access preflights apply to, which a local
 * `vite preview` on 127.0.0.1 cannot exercise. Runs only against a deployment (PLAYGROUND_URL),
 * from a workspace checkout (the board runs here, over a real git repo and order).
 */
import { type BoardHandle, startBoard } from '@dnr/board';
import { type BrowserContext, expect, test } from '@playwright/test';
import { RealRepo } from '../../board/src/real-repo';
import { closedPort, isRemote } from './helpers';

test.skip(!isRemote, 'needs a deployed Playground (PLAYGROUND_URL)');

let board: BoardHandle | null = null;
let repo: RealRepo | null = null;
test.afterEach(async () => {
  await board?.close();
  repo?.dispose();
  board = null;
  repo = null;
});

/**
 * Grant Local Network Access, as the user does at the browser's prompt: Chromium and Firefox both
 * gate a public HTTPS page's fetch to 127.0.0.1 behind it. WebKit has no such permission; it blocks
 * the fetch as mixed content instead (see the board-link test below).
 */
async function allowLocalNetwork(context: BrowserContext, browserName: string, origin: string) {
  if (browserName === 'webkit') return;
  await context.grantPermissions(['local-network-access'], { origin });
}

async function approvedBoard(host: 'auto' | '127.0.0.1', playgroundOrigin: string) {
  repo = await RealRepo.create();
  await repo.approve();
  repo.commitOrders('Approve the order');
  board = await startBoard({
    store: await repo.boardStore(),
    version: 'test',
    // The board answers CORS only to this origin (as `dnr board` does for the real sites).
    playgroundOrigin,
    host,
    user: 'test-maintainer',
  });
  return { board, id: repo.order.id };
}

test('deeplink-4: hosted page probes the local board, navigates to its origin, actions work', {
  tag: ['@deeplink-4', '@deeplink-hosted', '@ROUTE-10', '@P13-13'],
}, async ({ page, context, browserName, baseURL }) => {
  test.skip(
    browserName === 'webkit',
    'WebKit blocks an HTTPS page fetching http://127.0.0.1 as mixed content; the board-link test covers it',
  );
  const hosted = new URL(baseURL as string);
  const { board, id } = await approvedBoard('auto', hosted.origin);
  await allowLocalNetwork(context, browserName, hosted.origin);
  // Unlock the board first, as `dnr board` does: the launch URL sets the session cookie.
  await page.goto(board.launchUrl);
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const health = page.waitForRequest((r) => r.url() === `http://127.0.0.1:${board.port}/api/health`);
  await page.goto(new URL(`orders/${id}?board=${board.port}`, hosted).href);
  await health;
  // The page moves to the origin health returned (the host the session cookie is on).
  await page.waitForURL(`${origin}/orders/${id}`);
  await expect(page.locator('.mode-pill')).toHaveText('Local board');
  await page.locator('[data-action="allow-once"]').first().click();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
});

test('deeplink-4: probe blocked (WebKit mixed content, or the LNA prompt declined): the banner links to the running board', {
  tag: ['@deeplink-4', '@deeplink-hosted', '@P13-13'],
}, async ({ page, baseURL }) => {
  const hosted = new URL(baseURL as string);
  // --host 127.0.0.1 is what dnr doctor recommends on Safari; the link targets that host.
  const { board, id } = await approvedBoard('127.0.0.1', hosted.origin);
  await page.goto(board.launchUrl);
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  // No Local Network Access grant: Chromium and Firefox refuse the probe as when the user declines
  // the prompt; WebKit blocks it as mixed content. Each is the browser's own refusal.
  await page.goto(new URL(`orders/${id}?board=${board.port}`, hosted).href);
  await expect(page.getByTestId('banner-board-down')).toContainText(`dnr board --open ${id}`);
  const link = page.getByTestId('board-link');
  await expect(link).toHaveAttribute('href', `http://127.0.0.1:${board.port}/orders/${id}`);
  await link.click();
  await page.waitForURL(`http://127.0.0.1:${board.port}/orders/${id}`);
  await expect(page.locator('.mode-pill')).toHaveText('Local board');
  await page.locator('[data-action="allow-once"]').first().click();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
});

test('deeplink-1: hosted page with no board on the port: read-only demo order and the banner', {
  tag: ['@deeplink-1', '@deeplink-hosted', '@P13-10'],
}, async ({ page, context, browserName, baseURL }) => {
  const hosted = new URL(baseURL as string);
  await allowLocalNetwork(context, browserName, hosted.origin);
  const port = await closedPort();
  await page.goto(new URL(`orders/dnr-43933a1dca?board=${port}`, hosted).href);
  await expect(page.getByTestId('banner-board-down')).toContainText(
    'Run dnr board --open dnr-43933a1dca to act on this order',
  );
  await expect(page.locator('[data-action]')).toHaveCount(0);
  expect(new URL(page.url()).origin).toBe(hosted.origin);
});
