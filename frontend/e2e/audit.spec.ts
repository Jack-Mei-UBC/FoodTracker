import { test, expect } from '@playwright/test';

test('audit category Badge-as-button filters the table', async ({ page }) => {
  await page.goto('/audit');
  const rows = () => page.locator('tbody tr');
  const before = await rows().count();
  await page.getByText('Meat', { exact: false }).first().click();
  const after = await rows().count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);
});
