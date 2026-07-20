import { test, expect, Page } from '@playwright/test';
import { foodByKey } from './fixtures/seed-data.mjs';

// LAYER 2 — modal behavior contract. THE migration gate.
//
// Everything here is style-agnostic on purpose: it asserts *behavior*, not
// pixels, so it must pass identically before and after the shadcn restyle. If a
// test in this file needs editing during Phase 3, that is the signal something
// behavioural broke — not that the test is stale.
//
// The centering test is the important one. Per CLAUDE.md, every page root and
// <main> carries `.animate-slide-up`, whose `transform` makes that element a
// containing block for `position: fixed` descendants. An inline (non-portaled)
// modal therefore centers inside the page's full scrollable box instead of the
// viewport — it "opens in the middle of the page" and becomes unreachable on a
// long page. `max-h-[90vh]` does NOT fix it; the portal does. Radix Dialog will
// take over that portaling in Phase 3 M1, so this test is what proves the swap
// preserved the fix.

const OATS = foodByKey('oats')!;

/**
 * Find a fixture row on the dashboard. The real catalog runs to hundreds of
 * scraped foods and the table pages at 25, so a fixture is not on page 1 —
 * search first, which narrows to it regardless of catalog size.
 */
async function findFixtureRow(page: Page, name: string) {
  await page.goto('/');
  await page.getByPlaceholder(/search name, barcode, alias/i).fill(name);
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row.first(), 'fixture row must be present — run: node e2e/fixtures/seed.mjs').toBeVisible();
  return row.first();
}

/** Open the dashboard price-history modal by clicking a known fixture row. */
async function openPriceHistory(page: Page) {
  const row = await findFixtureRow(page, OATS.name);
  await row.click();
  const modal = page.locator('[data-loc="modal.price-history"]');
  await expect(modal).toBeVisible();
  return modal;
}

test('modal centers in the VIEWPORT, not inside the transformed page root', async ({ page }) => {
  const modal = await openPriceHistory(page);

  const box = (await modal.boundingBox())!;
  const viewport = page.viewportSize()!;

  // The panel's centre must sit near the viewport's centre. If the portal is
  // lost, the panel centres inside the page's scroll box and this blows up.
  const centreY = box.y + box.height / 2;
  expect(Math.abs(centreY - viewport.height / 2)).toBeLessThan(viewport.height * 0.25);

  // And it must be on-screen at all.
  expect(box.y).toBeGreaterThan(-1);
  expect(box.y).toBeLessThan(viewport.height);
});

test('modal stays in the viewport after the page is scrolled', async ({ page }) => {
  const row = await findFixtureRow(page, OATS.name);
  await page.mouse.wheel(0, 2000); // get the page root well out of alignment
  await page.waitForTimeout(150);

  await row.click();
  const modal = page.locator('[data-loc="modal.price-history"]');
  await expect(modal).toBeVisible();

  const box = (await modal.boundingBox())!;
  const viewport = page.viewportSize()!;
  // Visible region of the panel, clamped to the viewport.
  const visible = Math.min(box.y + box.height, viewport.height) - Math.max(box.y, 0);
  expect(visible, 'modal must remain reachable after scrolling').toBeGreaterThan(100);
});

test('Escape closes the modal', async ({ page }) => {
  const modal = await openPriceHistory(page);
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
});

test('backdrop click closes the modal, clicks inside do not', async ({ page }) => {
  const modal = await openPriceHistory(page);

  // A click on the panel itself must NOT close it (stopPropagation contract).
  await modal.click({ position: { x: 10, y: 10 } });
  await expect(modal).toBeVisible();

  // A click far outside the panel hits the backdrop and closes it.
  await page.mouse.click(5, 5);
  await expect(modal).toBeHidden();
});

test('Escape closes only the TOPMOST modal when stacked', async ({ page }) => {
  const history = await openPriceHistory(page);

  // Stack a second modal on top: the price editor, opened from "+ Add Price".
  await history.getByRole('button', { name: /add price/i }).click();
  const editor = page.locator('[data-loc="modal.price-editor"]');
  await expect(editor).toBeVisible();

  // First Escape closes ONLY the editor.
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await expect(history, 'the underlying modal must survive the first Escape').toBeVisible();

  // Second Escape closes the one underneath.
  await page.keyboard.press('Escape');
  await expect(history).toBeHidden();
});

test('price-history modal shows the food photo and both nutrition bases', async ({ page }) => {
  const modal = await openPriceHistory(page);

  // The photo slot (image or placeholder icon) sits in the header next to the name.
  await expect(modal.getByRole('button', { name: /change icon/i })).toBeVisible();

  // Per-serving chip AND the comparable per-100 chip. The oats fixture is
  // 150 kcal / 40 g, so per 100 g is 375 kcal — computed here from the fixture
  // rather than hard-coded, so changing the fixture can't silently break this.
  const n = OATS.nutrition!;
  const per100 = Math.round((Number(n.calories) / Number(n.serving_size)) * 100);

  await expect(modal).toContainText(`${Math.round(Number(n.calories))} kcal`);
  await expect(modal).toContainText(`${n.serving_size} ${n.serving_unit}`);
  await expect(modal, 'per-100 comparable basis must be shown').toContainText(`${per100} kcal`);
  await expect(modal).toContainText('100 g');
});
