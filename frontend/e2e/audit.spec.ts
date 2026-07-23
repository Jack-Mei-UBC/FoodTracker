import { test, expect } from '@playwright/test';

test('audit category Badge-as-button filters the table', async ({ page }) => {
  await page.goto('/audit');
  const rows = () => page.locator('tbody tr');
  // The catalog loads async (`loading` state gates the table), so the "All"
  // category filter chip must be visible before reading a baseline count —
  // otherwise `before` races the fetch and reads 0.
  const meatChip = page.getByText('Meat', { exact: false }).first();
  await expect(meatChip).toBeVisible();
  await expect(rows().first()).toBeVisible();
  const before = await rows().count();
  await meatChip.click();
  const after = await rows().count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);
});
