import { test, expect } from '@playwright/test';

// LAYER 1 — route smoke.
//
// Every page loads, renders its root `data-loc` landmark, and logs no console
// errors. Cheap and catches catastrophic breakage.
//
// The data-loc assertion is doing real work during the shadcn migration: those
// markers are the inspect-element → source workflow, and they only survive if
// every adopted component forwards unknown `data-*` props. This turns that from
// a documented hope into an enforced contract.

const PAGES: Array<{ path: string; loc: string }> = [
  { path: '/', loc: 'page.dashboard' },
  { path: '/diary', loc: 'page.diary' },
  { path: '/history', loc: 'page.history' },
  { path: '/inbox', loc: 'page.inbox' },
  { path: '/scrapes', loc: 'page.scrapes' },
  { path: '/meals', loc: 'page.meals' },
  { path: '/staging', loc: 'page.staging' },
  { path: '/budget', loc: 'page.budget' },
  { path: '/audit', loc: 'page.audit' },
  { path: '/settings', loc: 'page.settings' },
  { path: '/scanner', loc: 'page.scanner' },
];

for (const { path, loc } of PAGES) {
  test(`${path} loads without console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
    expect(res?.status(), `${path} should return 200`).toBe(200);

    // Layout landmarks are on every page.
    await expect(page.locator('[data-loc="layout.main"]')).toBeAttached();

    // Ignore noise we don't control: favicon 404s and Next's dev-only HMR chatter.
    const real = errors.filter(e =>
      !/favicon/i.test(e) &&
      !/Download the React DevTools/i.test(e) &&
      !/\[Fast Refresh\]/i.test(e));
    expect(real, `console errors on ${path}`).toEqual([]);
  });
}

test('page-root data-loc markers are present', async ({ page }) => {
  // Checked in one test so a missing marker reports as one clear failure list
  // rather than N scattered ones.
  const missing: string[] = [];
  for (const { path, loc } of PAGES) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    const count = await page.locator(`[data-loc="${loc}"]`).count();
    if (count === 0) missing.push(`${path} -> [data-loc="${loc}"]`);
  }
  expect(missing, 'data-loc markers must survive component changes').toEqual([]);
});
