import { test, expect, Page } from '@playwright/test';
import { foodByKey, ACTIVE_FOOD_NAMES, SALE_EXPIRED_ENDS } from './fixtures/seed-data.mjs';

// LAYER 2 — dashboard interaction contracts. Style-agnostic; must survive the
// shadcn restyle unchanged.
//
// These cover the behaviors CLAUDE.md calls out as load-bearing and easy to
// regress: client-side search/sort/filter (the whole catalog is loaded once and
// sorted in memory — server paging would silently make sorting dishonest), the
// canonical per-kg price display, and the expired-sale rule.

const OATS = foodByKey('oats')!;
const OIL = foodByKey('oliveoil')!;
const YOGURT = foodByKey('yogurt')!;
const DRUMSTICKS = foodByKey('drumsticks')!;

const search = (page: Page) => page.getByPlaceholder(/search name, barcode, alias/i);
const rows = (page: Page) => page.locator('tbody tr');

test('search filters the catalog by name', async ({ page }) => {
  await page.goto('/');
  await search(page).fill(OATS.name);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(OATS.name);
});

test('search matches on a learned alias, not just the name', async ({ page }) => {
  // The oats fixture carries the alias "FIXT RLD OATS". Searching the alias must
  // surface the food under its real name — the aliases-in-haystack contract.
  await page.goto('/');
  await search(page).fill(OATS.aliases[0]);
  await expect(rows(page).first()).toContainText(OATS.name);
});

test('search matches on barcode', async ({ page }) => {
  await page.goto('/');
  await search(page).fill(OATS.barcode!);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(OATS.name);
});

test('archived foods are absent from the catalog', async ({ page }) => {
  await page.goto('/');
  await search(page).fill('Fixture Archived Widget');
  await expect(rows(page)).toHaveCount(0);
});

test('sorting by name reverses on a second click, and is honest across the whole catalog', async ({ page }) => {
  await page.goto('/');
  // Narrow to the fixtures so the assertion doesn't depend on the scraped catalog.
  await search(page).fill('Fixture');

  // 2nd cell of EACH row (1st is the icon). `.locator('td').nth(1)` would pick a
  // single cell across all rows, not one per row.
  const nameCell = () => rows(page).locator('td:nth-child(2)');

  await page.locator('th button[title="Sort by product"]').click();
  const asc = await nameCell().allInnerTexts();

  await page.locator('th button[title="Sort by product"]').click();
  const desc = await nameCell().allInnerTexts();

  expect(asc.length).toBeGreaterThan(1);
  expect(desc).toEqual([...asc].reverse());
});

test('kcal column reads per 100 g, not per label serving', async ({ page }) => {
  await page.goto('/');
  await search(page).fill(OATS.name);

  // Oats fixture: 150 kcal / 40 g → 375 per 100 g. Computed from the fixture so
  // changing the data can't silently invalidate the assertion.
  const n = OATS.nutrition!;
  const per100 = Math.round((Number(n.calories) / Number(n.serving_size)) * 100);

  const row = rows(page).first();
  await expect(row).toContainText(String(per100));
  await expect(row, 'must not show the raw per-serving figure').not.toContainText(
    ` ${Math.round(Number(n.calories))} /`);
});

test('a volume food shows a canonical per-kg price via density', async ({ page }) => {
  await page.goto('/');
  await search(page).fill(OIL.name);
  // $12.99 / 1 L, density 0.92 → $14.12/kg. Assert the canonical unit is shown
  // rather than the raw per-litre figure.
  await expect(rows(page).first()).toContainText('/kg');
});

test('an expired sale is not quoted as a current price', async ({ page }) => {
  // The yogurt fixture has an EXPIRED $3.49 sale and an active $5.99 regular
  // price. The dashboard must show the regular one — this is ACTIVE_PRICE_SQL
  // surfacing in the UI.
  await page.goto('/');
  await search(page).fill(YOGURT.name);
  const row = rows(page).first();

  await expect(row).not.toContainText('3.49');
  await expect(row, 'expired sale must not be badged as on sale').not.toContainText('sale');
  expect(new Date(SALE_EXPIRED_ENDS).getTime()).toBeLessThan(Date.now());
});

test('an active sale IS badged', async ({ page }) => {
  await page.goto('/');
  await search(page).fill(DRUMSTICKS.name);
  await expect(rows(page).first()).toContainText(/sale/i);
});

test('category filter narrows the table', async ({ page }) => {
  await page.goto('/');
  await search(page).fill('Fixture');
  const before = await rows(page).count();

  await page.getByRole('button', { name: 'Meat', exact: true }).click();
  const after = await rows(page).count();

  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThan(before);
  await expect(rows(page).first()).toContainText(DRUMSTICKS.name);
});

test('all seeded fixtures are reachable in the catalog', async ({ page }) => {
  // Guards the fixture set itself: if the seeder or a catalog read regresses,
  // this reports which food went missing rather than failing somewhere obscure.
  await page.goto('/');
  const missing: string[] = [];
  for (const name of ACTIVE_FOOD_NAMES) {
    await search(page).fill(name);
    if (await rows(page).filter({ hasText: name }).count() === 0) missing.push(name);
  }
  expect(missing).toEqual([]);
});

test('the On sale checkbox filters down to actively-discounted foods', async ({ page }) => {
  // Phase 3 M8 replaced the native <input type="checkbox"> with Base UI's
  // Checkbox, which renders a <span> (not a labelable element) plus a
  // visually-hidden native <input> for exactly this purpose. Clicking the
  // *label text* — not the checkbox element itself — must still toggle it,
  // the same as it did with a real <input>.
  await page.goto('/');
  await search(page).fill('Fixture');
  const before = await rows(page).count();

  await page.getByText('On sale', { exact: true }).click();
  const after = await rows(page).count();

  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThan(before);
  await expect(rows(page).first()).toContainText(DRUMSTICKS.name);
});

test('the Add Food category Select opens, lists options, and picks one', async ({ page }) => {
  // Phase 3 M3 replaced the native <select> here with Base UI's Select, which
  // portals its listbox to <body> — this guards that the portal wiring and
  // value/onValueChange plumbing actually work, not just that the page renders.
  await page.goto('/');
  const trigger = page.locator('form:has(input[placeholder="Add product (e.g. Fresh Gala Apples)"]) [role="combobox"]');
  await trigger.click();
  const option = page.getByRole('option', { name: 'Meat', exact: true });
  await expect(option).toBeVisible();
  await option.click();
  await expect(trigger).toContainText('Meat');
});
