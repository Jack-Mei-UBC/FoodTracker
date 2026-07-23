import { test, expect } from '@playwright/test';

// LAYER 2 — toast interaction contract. Style-agnostic; must survive the
// shadcn restyle unchanged.
//
// Phase 3 M5 replaced the hand-rolled bottom-right StatusToast div (and the
// duplicated local notification/showToast state on the dashboard, diary, and
// meals pages) with sonner, mounted once via <Toaster/> in layout.tsx. This
// guards that a real notify() call actually renders a toast through that
// single global mount point, not just that the page compiles.

test('a validation error notification renders as a sonner toast', async ({ page }) => {
  await page.goto('/settings');
  // A 1-365 range field: an out-of-range value triggers notify(..., 'error')
  // in settings/page.tsx purely client-side, so the toast is the only thing
  // under test (no network round-trip to wait on).
  const input = page.locator('#sale-days');
  await input.fill('400');
  await input.press('Enter');
  await expect(page.getByText('Enter a whole number of days between 1 and 365.')).toBeVisible();
});
