# UI test net

Playwright suite that runs against the **already-running** docker stack. There
is deliberately no `webServer` block in `playwright.config.ts` — these pages need
the backend, db and redis, not just Next.

```bash
docker compose up -d --wait     # from the repo root
npm run seed                    # from frontend/ — idempotent
npm run test:e2e
npm run test:e2e:ui             # interactive runner
```

## Layout

| File | Layer | What it protects |
|---|---|---|
| `fixtures/seed-data.mjs` | — | **Static** fixture data. The single source of truth: the seeder inserts it, the specs import it for assertions, so expectations can't drift from the data. |
| `fixtures/seed.mjs` | — | Seeds the above **through the REST API** (raw SQL would skip `unit_price` normalization and the `food_prices` join rows, producing fixtures that look right in the DB and wrong in the UI). |
| `routes.spec.ts` | 1 | Every page loads, no console errors, and every page-root `data-loc` marker is present. |
| `modal.spec.ts` | 2 | Modal behavior contract — viewport centering, stacked-Escape ordering, backdrop-vs-panel clicks. |
| `dashboard.spec.ts` | 2 | Search / alias / barcode / sort / category filter, the canonical per-kg price, the per-100 kcal basis, and the expired-sale rule. |

## Why Layer 2 matters more than screenshots here

The shadcn migration adopts shadcn's **default** look, so the app's appearance is
deliberately changing. Visual baselines captured *before* that would diff on
every snapshot and train everyone to run `--update-snapshots` without reading it
— worse than no net.

So **Layer 2 is the migration gate**: these tests assert behavior, not pixels,
and must pass *unchanged* before and after the restyle. If a test in
`modal.spec.ts` or `dashboard.spec.ts` needs editing during the migration, that
is the signal something behavioural broke.

Visual snapshots (Layer 3) come later as a **forward** net — baselines captured
per component right after it migrates, protecting it from the next step's
collateral damage.

## Two contracts these tests enforce

- **`data-loc` markers must survive.** They're the inspect-element → source
  workflow, and they only keep working if every adopted component forwards
  unknown `data-*` props. `routes.spec.ts` turns that from a documented hope
  into a failing test.
- **The portal in `Modal.tsx` is load-bearing.** Page roots carry
  `.animate-slide-up`, whose `transform` makes them a containing block for
  `position: fixed` descendants — so a non-portaled modal centres inside the
  page's scroll box instead of the viewport. Verified: removing the portal fails
  the centering and backdrop tests.

## Gotchas

- **Search before asserting on a row.** The real catalog runs to hundreds of
  scraped foods and the table pages at 25, so no fixture is on page 1.
- **The suite is serial** (`workers: 1`). The stack is shared mutable state.
- Not wired to the Stop hook — too slow. The hook keeps running
  `scripts/smoke-test.ps1`; this runs manually and in CI.
