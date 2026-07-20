import { defineConfig, devices } from '@playwright/test';

// UI test net. Runs against the ALREADY-RUNNING docker stack — there is
// deliberately no `webServer` block, because the app needs the backend, db and
// redis, not just Next. Bring the stack up first:
//
//   docker compose up -d --wait
//   node e2e/fixtures/seed.mjs
//   npm run test:e2e
//
// Three layers (see SHADCN-MIGRATION.md):
//   1. route smoke        — every page loads, renders its data-loc, no console errors
//   2. interaction        — style-agnostic behavior contracts; THE migration gate
//   3. visual snapshots   — a FORWARD net, baselines captured per component as it
//                           migrates (the look is deliberately changing, so a
//                           pre-migration baseline would diff on everything)

const WEB = process.env.WEB || 'http://localhost:3000';

export default defineConfig({
  // Specs and the fixtures they import live together in frontend/e2e/. They
  // have to be inside this package: there is no root package.json (by design —
  // see CLAUDE.md), so a spec at the repo root couldn't resolve
  // `@playwright/test` from frontend/node_modules.
  testDir: './e2e',
  // The stack is shared mutable state, so parallel specs can race on it.
  // Correctness over speed: this suite is small.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  timeout: 30_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // Next dev compiles lazily and fonts load async — allow a little noise
      // rather than training everyone to blind-update snapshots.
      maxDiffPixelRatio: 0.02,
    },
  },

  use: {
    baseURL: WEB,
    // A fixed viewport is required for stable screenshots.
    viewport: { width: 1280, height: 900 },
    // `.animate-slide-up` is a 0.4s transform on every page root and modal
    // panel — a guaranteed screenshot flake source unless motion is off.
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
