/**
 * Production audit P2: a judge's first visit to /play. The shipped order is a real draft (no
 * human approved it), so the page leads with two explicit steps. Step 1 is the maintainer's
 * approval, simulated in this browser; step 2 is the agent's write. Every surface that shows a
 * browser-side approval says "simulated", and "Reset to the real state" returns to the order as
 * built. Runs locally and against a deployment (fresh browser context, so no stored state).
 */
import { expect, type Page, test } from '@playwright/test';
import { DEMO, DEMO_ORDER } from './helpers';

const SIM = 'Approved (simulated in this browser): enforced';

async function ready(page: Page) {
  await expect(page.locator('fieldset.presets')).toHaveAttribute('data-engine', 'ready', { timeout: 30_000 });
}

test('P2: first visit: the two steps lead the page; approve (simulated), send the write, BLOCK', {
  tag: ['@P2', '@first-visit', '@smoke'],
}, async ({ page }) => {
  await page.goto(`play/${DEMO}`);
  const steps = page.getByTestId('first-steps');
  await expect(steps).toBeVisible();
  // The steps come before the presets in the page.
  const before = await steps.evaluate((el) => {
    const presets = document.getElementById('presets-h');
    return !!presets && !!(el.compareDocumentPosition(presets) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before).toBe(true);
  const approve = steps.locator('[data-action="approve-first"]');
  await expect(approve).toHaveText('1. Approve as maintainer simulated in your browser');
  await expect(steps.locator('[data-action="send-original"]')).toHaveText("2. Send the agent's write");
  // As shipped, the order is a real draft.
  await expect(page.getByTestId('play-state')).toHaveText('Draft: not enforced');
  await ready(page);
  await approve.click();
  await expect(page.getByTestId('play-state')).toHaveText(SIM);
  await expect(steps.locator('[data-step="1"]')).toHaveAttribute('data-done', 'true');
  await expect(steps.locator('[data-step="1"]')).toContainText('simulated in this browser');
  await steps.locator('[data-action="send-original"]').click();
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'BLOCK');
  await expect(page.getByTestId('exit-code')).toHaveText('2');
  await expect(page.getByTestId('stderr')).toContainText(`DNR order ${DEMO_ORDER} matched`);
});

test('P2: a browser-side approval says "simulated" on every surface', {
  tag: ['@P2', '@first-visit'],
}, async ({ page }) => {
  await page.goto(`play/${DEMO}`);
  await ready(page);
  await page.getByTestId('first-steps').locator('[data-action="approve-first"]').click();
  // /play: the order header and the maintainer panel.
  await expect(page.getByTestId('play-state')).toHaveText(SIM);
  await expect(page.locator('.sim-actions')).toContainText(`Status: ${SIM}`);
  // The graveyard headstone (and its accessible name).
  await page.goto('graveyard');
  const stone = page.locator(`article.stone[aria-label^="Order ${DEMO_ORDER}"]`);
  await expect(stone.getByTestId('state-label')).toHaveText(SIM);
  await expect(stone).toHaveAttribute('aria-label', /simulated in this browser/);
  // The order page: its status line and its headstone.
  await page.goto(`orders/${DEMO_ORDER}`);
  await expect(page.getByTestId('order-state')).toHaveText(SIM);
  await expect(page.locator('article.stone').getByTestId('state-label')).toHaveText(SIM);
  // No state surface shows the plain "Approved: enforced" for this browser-only approval (the
  // graveyard legend, which explains each state in general, is not a state surface).
  const surfaces = '[data-testid="state-label"], [data-testid="play-state"], [data-testid="order-state"]';
  for (const path of [`play/${DEMO}`, 'graveyard', `orders/${DEMO_ORDER}`]) {
    await page.goto(path);
    await expect(page.locator('main')).toContainText('simulated in this browser');
    await expect(page.locator(surfaces).first()).toBeVisible();
    expect(await page.locator(surfaces).allTextContents()).not.toContain('Approved: enforced');
  }
});

test('P2: "Reset to the real state" returns the order to the draft it was built as', {
  tag: ['@P2', '@first-visit'],
}, async ({ page }) => {
  await page.goto(`play/${DEMO}`);
  await ready(page);
  const steps = page.getByTestId('first-steps');
  await steps.locator('[data-action="approve-first"]').click();
  await page.getByTestId('advance').click();
  await expect(page.getByTestId('play-state')).toHaveText(SIM);
  await steps.locator('[data-action="reset-real"]').click();
  await expect(page.getByTestId('play-state')).toHaveText('Draft: not enforced');
  await expect(page.getByRole('status').filter({ hasText: 'Reset to the real state' })).toBeAttached();
  await expect(steps.locator('[data-action="approve-first"]')).toBeVisible();
  // The real state allows the write (not enforced), and the reset survives a reload.
  await steps.locator('[data-action="send-original"]').click();
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'ALLOW');
  await page.reload();
  await expect(page.getByTestId('play-state')).toHaveText('Draft: not enforced');
  // The graveyard has the same reset.
  await ready(page);
  await steps.locator('[data-action="approve-first"]').click();
  await page.goto('graveyard');
  await page.locator('[data-action="reset-real"]').click();
  await expect(
    page.locator(`article.stone[aria-label^="Order ${DEMO_ORDER}"]`).getByTestId('state-label'),
  ).toHaveText('Draft: not enforced');
});
