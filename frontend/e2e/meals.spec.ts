import { test, expect } from '@playwright/test';

// LAYER 2 — meals builder interaction contract. Style-agnostic; must survive
// the shadcn restyle unchanged.
//
// Phase 3 M4 replaced the hand-rolled Catalog/USDA button pair with Base UI
// Tabs. Unlike the audit page's tab (which just filters a list that's always
// rendered), this one swaps which panel is mounted — catalog search vs the
// USDA lookup — so a wiring mistake here would silently strand one panel.

test('the meals builder Catalog/USDA tabs swap the ingredient search panel', async ({ page }) => {
  await page.goto('/meals');
  await page.getByRole('button', { name: '+ New Meal' }).click();

  const catalogInput = page.getByPlaceholder('Add an ingredient from the catalog…');
  const usdaTab = page.getByRole('tab', { name: 'USDA database' });
  const catalogTab = page.getByRole('tab', { name: 'Catalog', exact: true });

  await expect(catalogInput).toBeVisible();

  await usdaTab.click();
  await expect(catalogInput).toBeHidden();
  await expect(page.getByPlaceholder(/search usda/i)).toBeVisible();

  await catalogTab.click();
  await expect(catalogInput).toBeVisible();
});

test('the Catalog ingredient combobox lists a fixture food and adding it creates a row', async ({ page }) => {
  // Phase 3 M6 replaced the hand-rolled suggestion <div>/<button> list with
  // cmdk's Command/CommandList/CommandItem (kept inline, not portaled via
  // Popover, since this dropdown isn't inside a clipping ancestor) — this
  // proves the CommandItem's onSelect still wires through to addRow().
  await page.goto('/meals');
  await page.getByRole('button', { name: '+ New Meal' }).click();

  const catalogInput = page.getByPlaceholder('Add an ingredient from the catalog…');
  await catalogInput.fill('Fixture Rolled Oats');

  const option = page.getByText('Fixture Rolled Oats', { exact: false }).first();
  await expect(option).toBeVisible();
  await option.click();

  await expect(catalogInput).toHaveValue('');
  await expect(page.locator('span.font-semibold', { hasText: 'Fixture Rolled Oats' })).toBeVisible();
});
