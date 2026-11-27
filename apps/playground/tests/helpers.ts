import { createServer } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const DEMO = '43933a1dca';
export const DEMO_ORDER = 'dnr-43933a1dca';
export const isRemote = !!process.env.PLAYGROUND_URL;

/** Open a /play case and wait until the engine (WASM grammar) is ready. */
export async function openPlay(page: Page, id = DEMO) {
  await page.goto(`play/${id}`);
  await expect(page.getByRole('heading', { name: 'Presets' })).toBeVisible();
  await expect(page.locator('fieldset.presets')).toHaveAttribute('data-engine', 'ready', { timeout: 30_000 });
}

const KIND: Record<string, string> = {
  original: 'original-change',
  'hard-negative': 'hard-negative',
  formatting: 'formatting-only',
  paraphrase: 'held-out-paraphrase',
  half: 'half-of-two-file',
};

/** Run a preset by its kind (short names above), or by exact id with `{ byId: true }`. */
export async function runPreset(page: Page, preset: string, opts: { byId?: boolean } = {}) {
  const sel = opts.byId ? `[data-preset="${preset}"]` : `[data-preset-kind="${KIND[preset] ?? preset}"]`;
  await page.locator(sel).click();
  await expect(page.getByTestId('verdict')).toBeVisible();
}

export async function results(page: Page): Promise<unknown[]> {
  const raw = await page.getByTestId('results').getAttribute('data-results');
  return JSON.parse(raw ?? '[]');
}

export async function expectNoAxeViolations(page: Page) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    r.violations.map((v) => `${v.id}: ${v.nodes.length} × ${v.help} (${v.nodes[0]?.target.join(' ')})`),
  ).toEqual([]);
}

/**
 * The demo orders are drafts (no maintainer has approved them), so DNR allows every write. This
 * clicks the browser-local "Approve (simulated)" action, as a judge would, to enforce the order.
 */
export async function approveSim(page: Page) {
  await page.locator('.sim-actions [data-action="approve"]').click();
  await expect(page.locator('.sim-actions')).toContainText('Approved (simulated in this browser): enforced');
}

/** A loopback port nothing listens on: bound by the OS, then closed (a real "board down"). */
export function closedPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      srv.close(() => res(port));
    });
  });
}
