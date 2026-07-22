# shadcn/ui migration plan

Living plan for reworking the FoodTracker frontend onto shadcn/ui, plus the
prerequisite work: a repaired smoke test that survives a cold Docker stack, and
a UI test net that makes a restyling migration safe.

**Ordering is not negotiable.** Phases 0 and 1 exist because Phase 3 is the
riskiest change ever made to this repo and there is currently nothing to catch a
regression. Do not start Phase 3 until Phase 1's Layer 2 contracts are green.

---

## Status at a glance

| Phase | State | Notes |
|---|---|---|
| **0 — smoke repair + compose split** | ✅ **shipped** | All of F1–F7 landed. Smoke suite is 50/50 green and the two twins are back in sync. |
| **1 — UI test net** | 🟡 **partly shipped** | Layers 1 & 2 exist (29 Playwright tests, green ×3 consecutive runs). Layer 3 (visual) and the Vitest secondary are **not started**. A real **flake source was found and fixed** — Playwright artifacts were being written into the container's bind mount, triggering mid-run recompiles. |
| **2 — shadcn prerequisites** | ✅ **shipped** | Next 15 + Tailwind 4 in; tsconfig on ES2020; `cn()` + cva/clsx/tailwind-merge installed; `shadcn init -b base -p nova` run with **Base UI**; `rsc: false` corrected by hand. `shadcn add` verified end-to-end with Button. |
| **3 — the migration** | 🟡 **started** | Global de-customisation done (bespoke palette/glassmorphism/webfonts deleted, `globals.css` 10.2 KB → 6.2 KB). **M1 shipped**: `Modal` → Base UI Dialog, `zClass`/`backdropClass`/`panelClassName` deleted (not just frozen), 11 duplicated close buttons removed, all 16 call sites updated, 6/6 modal + 29/29 full suite green. **M2 shipped**: Badge, Label, Button, Card, `.panel` done (48 `.btn*` + 35 `.card` + 30 `.panel` call sites converted; three of four transitional class families deleted from `globals.css`, `.badge` left pending 3 interactive chips). **M3 shipped**: all 20 native `<select>`s → Base UI `<Select>`, verified with a new permanent Playwright interaction test since this pass changed real markup/behavior, not just classes. M4–M8 not started. |
| **4 — docs & guardrails** | ⬜ not started | Folded into each Phase 3 step. |

Phase 0's findings below are kept as the **historical record of why** the fixes
look the way they do — they read in the past tense on purpose. The problems they
describe are fixed; don't re-diagnose them.

---

## Phase 0 — Repair the smoke test on a cold stack ✅ SHIPPED

### Why it failed — confirmed against a real CI run *(resolved)*

> **Outcome.** Every fix in the F-table below shipped. The smoke suite now runs
> **50 assertions, all passing**, against a healthy stack, and the two twins were
> re-verified as in sync (same 10 frontend routes, same API coverage — the only
> textual difference is `$VAR` vs `${VAR}` interpolation). The drift described
> below is closed, and CLAUDE.md now documents the pair as a hand-synced contract.

The failure happened in **GitHub Actions** (`.github/workflows/smoke.yml`), not on
a local Docker stack, and the failing script is **`scripts/smoke-test.sh`** — a
bash twin of the PowerShell hook that I had not accounted for. The observed run
fails exactly five assertions, all from one root cause:

1. ✅ **There is no seed data.** `db/schema.sql:411-425` has the `stores` /
   `foods` / `price_logs` inserts commented out, so CI's fresh volume boots an
   empty catalog:
   - `GET /api/foods returns items` fails on `len(d)>0`;
   - the next two assertions index `d[0]` of an empty list → `IndexError: list
     index out of range` (the tracebacks in the log);
   - `GET /api/foods/1` 404s → the two `/api/foods/:id` assertions fail.
2. ✅ **Hard-coded row ids** (`/api/foods/1`, `/api/foods/5/prices`) — brittle
   even against a seeded database.
3. ❌ **Hook timeout — not a factor.** CI doesn't use the Stop hook, and every
   frontend route returned 200.
4. ❌ **Readiness gating — not a factor.** The workflow already polls backend
   health (60×3s) and the frontend (40×3s) before running the suite.

**Newly discovered, and more serious than the failure itself: the two smoke
scripts have drifted.** `smoke-test.sh` is a much older subset of
`smoke-test.ps1` — it sweeps **6** frontend routes to the PowerShell version's
**10** (missing `/staging`, `/budget`, `/audit`, `/settings`), and is missing
entire assertion blocks: the images endpoint, audit/bulk validation,
`from-nutrition`, catalog merge, receipts/budget, scan-job detail, app settings,
and the **expired-sale `ACTIVE_PRICE_SQL` invariant**. So **CI green does not
mean local green** — the gate that's supposed to enforce "every change is
verified" is enforcing a weaker contract than the one on the developer's
machine. This is a third hand-synced cross-language contract of exactly the kind
CLAUDE.md already warns about, and it isn't documented as one.

### Also found: compose is discarding the Docker images' work

Every Dockerfile is already multi-stage and installs dependencies at build time.
But `docker-compose.yml` overrides each service's `CMD` with
`command: sh -c "npm install --include=dev && npm run dev"`, so the container
**re-installs on every boot**, throwing away the image layer it just built. The
frontend is worse: its builder stage runs `npm run build`, then compose ignores
the result and runs `npm run dev`. This — not any missing healthcheck — is why
cold starts take minutes. See Phase 0 F6 below.

### Fixes

| # | Fix | Files |
|---|---|---|
| F1 | **Static fixtures + seeder.** `e2e/fixtures/seed-data.mjs` is the single static source of truth; `e2e/fixtures/seed.mjs` inserts it **through the backend REST API**. Playwright tests import the same file for assertions, so expectations can't drift from the data. | `e2e/fixtures/*` |
| F2 | **Discover ids.** Take the id from `GET /api/foods` instead of hard-coding `1`/`5`. | both smoke scripts |
| F3 | **Skip, don't fail, on an empty catalog.** Catalog-dependent assertions emit `[SKIP]` when the DB is empty (the idiom already used for scan jobs), so an unseeded stack degrades to skips. Guards `d[0]` so an empty list can never raise `IndexError`. | both smoke scripts |
| F4 | **Re-sync the two scripts** to the same assertion set and route list, and document them in CLAUDE.md as a hand-synced pair alongside the other cross-language contracts. | both smoke scripts, `CLAUDE.md` |
| F5 | **Seed in CI** after the health gate, before the suite. | `.github/workflows/smoke.yml` |
| F6 | **Dev/CI compose split + real Dockerfile targets.** See below. | `docker-compose*.yml`, `*/Dockerfile` |
| F7 | **Healthchecks** — `pg_isready`, `redis-cli ping`, `/api/health` — with `depends_on: {condition: service_healthy}`, so `docker compose up -d --wait` is meaningful and CI can drop its hand-rolled poll loops. | `docker-compose.yml` |

### Why the seeder goes through the REST API, not raw SQL

A price row is invisible to every catalog read unless its `food_prices` join row
exists, and `unit_price` normalization happens in the route handler — both
documented in CLAUDE.md. Raw `INSERT`s would produce fixtures that look right in
the database and wrong in the UI. Going through `POST /api/foods` +
`POST /api/foods/:id/prices` gets the joins, normalization, and audit rows for
free, and has the side benefit of exercising those endpoints on every seed. It's
~15 rows; the speed cost is irrelevant.

### Fixture set (F1)

Chosen so it doubles as deterministic Playwright data:

- 2 stores (one with lat/long for the GPS auto-match path).
- Foods covering every display branch: mass-based, volume-based **with density**,
  count-based, one archived, one with an alias, one with nutrition, one with
  `usable_pct != 100`.
- **One active sale and one expired sale** (`sale_ends_at` in the past) so the
  `ACTIVE_PRICE_SQL` invariant is actually exercised rather than assumed.
- One meal with ingredients.

Marked clearly as dev fixtures. Never loaded into a production volume.

### Docker: dev vs CI (F6)

The problem isn't the Dockerfiles — they're already multi-stage and install
dependencies at build time. It's that compose overrides `CMD` with
`npm install && npm run dev`, re-installing on every boot.

**The fix is the standard Compose dev pattern**, which keeps hot reload *and*
gets fast cold starts:

- **`docker-compose.yml`** — base. No bind mounts, no `command:` overrides; runs
  the image's own production `CMD`. This is what CI and any deploy use.
- **`docker-compose.override.yml`** — **loaded automatically** by a bare
  `docker compose up`. Adds the source bind mounts, `target: dev`, and the
  hot-reload command. Your day-to-day workflow is unchanged: still
  `docker compose up -d`, still hot reload.
- **`docker-compose.ci.yml`** — explicit overlay for CI
  (`-f docker-compose.yml -f docker-compose.ci.yml`), which pointedly does *not*
  load the dev override.

Hot reload survives without a runtime install because the source bind mount is
paired with an **anonymous volume on `node_modules`** (already present), which
masks the host directory and preserves the image's installed dependencies. The
tradeoff — and it's the correct one — is that **changing `package.json` now
requires an image rebuild** (`docker compose up -d --build <svc>`) instead of a
container restart. That's the normal contract, and it's what makes the boot fast.

Dockerfiles gain explicit `dev` and `prod` stages so `target: dev` gets
devDependencies and the watcher, while the base image stays lean.

---

## Phase 1 — UI test net (before any shadcn work) 🟡 PARTLY SHIPPED

**What exists today** (`frontend/e2e/`, run with `npm run seed && npm run test:e2e`):

| Layer | State | Detail |
|---|---|---|
| 1 — route smoke | ✅ | `routes.spec.ts`, 5 tests, sweeping **all 11 routes** including `/scanner`. |
| 2 — interaction contracts | ✅ | `modal.spec.ts` (6 tests: centering, stacking, backdrop) + `dashboard.spec.ts` (11 tests: search/sort/filter, per-100 basis, expired-sale rule). |
| 3 — visual regression | ⬜ | **Not started.** No `toHaveScreenshot()` anywhere yet. Per the revision below this is a *forward* net captured per-component during Phase 3, so starting it now would be premature — but the flake-control list must be in place before the first baseline. |
| Vitest secondary | ⬜ | **Not started.** No `vitest` dependency, no `test:unit` script. `units.ts` / `nutrition.ts` / `match.ts` remain unit-untested. |

Wired: `test:e2e`, `test:e2e:ui`, `test:e2e:update`, `seed`. **`test:unit` is
referenced further down but does not exist yet** — add it with Vitest.

### Open items

- [x] **`/scanner` is missing from both smoke-test twins.** ~~Playwright's
      `routes.spec.ts` covers it, but the twins sweep 10 frontend routes and
      omit `/scanner`.~~ **Fixed** — both scripts now sweep all 11 routes
      including `/scanner`.
- [x] **The smoke scripts exit 0 when the stack is down.** **Fixed** — both
      twins now support `STRICT=1` (fail with exit 2 on an unreachable/unhealthy
      backend; CI sets it in `smoke.yml`), and the non-strict local skip prints
      an unmissable `NOTHING WAS VERIFIED` banner instead of a quiet
      `skipping`, so a Stop-hook "green" on a down stack is at least visibly
      unverified rather than mistaken for a pass.
- [ ] Add the Vitest secondary (`test:unit`) for the three pure-logic libs.
- [ ] Put the Layer 3 flake controls in place *before* the first snapshot:
      fixed viewport, `reducedMotion: 'reduce'`, the `.animate-slide-up`
      test-only override, self-hosted fonts, and masked dynamic regions.

### Tooling

**Playwright (`@playwright/test`) as the primary net.** Real browser, works
against the running Docker stack, understands portals and dialogs natively, has
first-class visual snapshots (`toHaveScreenshot`) and a trace viewer.

Rejected: jsdom-based (Vitest + Testing Library) as the *primary* net — the
failure mode this project actually suffers from is layout and overlay
positioning (the `position: fixed` inside a transformed ancestor bug), which
jsdom cannot see.

**Vitest as a cheap secondary** for pure logic: `lib/units.ts`
(`canonicalUnitPrice`, `formatCanonicalUnitPrice`), `lib/nutrition.ts`
(`scaleNutrients`, `nutrientsPer100`, `per100Basis`), `lib/match.ts`. Fast, no
browser, high value per line.

Location: `frontend/e2e/`. Config points `baseURL` at `http://localhost:3000`
with a global setup that reuses the Phase 0 readiness logic. No `webServer`
block — the stack comes from docker compose.

### Three layers

**Layer 1 — route smoke.** Every page returns 200, renders its root `data-loc`,
and logs no console errors. Cheap, catches catastrophic breakage. *Shipped as 5
parametrized tests sweeping all 11 routes.*

**Layer 2 — interaction contracts.** Anchored on `data-loc` selectors, which the
project already maintains and which *must survive the migration*. Priority:

- **Modal behavior** — this is the contract most at risk in Phase 3:
  - opens centered **in the viewport** (assert bounding box against viewport, the
    exact regression documented in CLAUDE.md);
  - Escape closes only the **topmost** modal when stacked
    (FoodDetailModal → PriceEditor → Escape closes only PriceEditor);
  - backdrop click closes; body scroll is locked.
- Dashboard: table renders, column sort reorders, search filters, thumbnail
  click opens the icon picker without opening the row modal.
- `modal.price-history`: opens, shows the food photo, shows per-serving **and**
  per-100 nutrition chips.
- PriceEditor / MacroEditor: render, validate, and save paths.
- Audit: tab switch, row selection, bulk bar appears.
- Meals: Catalog/USDA tab switch, add an ingredient.

**Layer 3 — visual regression.** `toHaveScreenshot()` per page and per modal at
a fixed viewport.

> **Revised — the "adopt shadcn defaults" decision changes what this layer is
> for.** The original plan captured baselines *before* Phase 3 so they'd define
> "still looks right." That only works for a pixel-preserving migration. Since
> the look is deliberately changing, a pre-migration baseline would diff on
> every single snapshot and teach everyone to run `--update-snapshots` without
> reading it — worse than no net at all.
>
> So: **Layer 3 is a forward net, not a migration gate.** Baselines are captured
> **per component, immediately after** that component is migrated and eyeballed.
> It protects everything migrated so far from the *next* step's collateral
> damage, which is the real risk in a page-by-page sweep.
>
> That makes **Layer 2 the migration gate instead** — interaction contracts are
> style-agnostic, so they should pass unchanged before and after a restyle. If a
> Layer 2 test needs editing during Phase 3, that's the signal something
> behavioural broke. Layer 2 therefore gets the coverage budget that would have
> gone to pre-migration snapshots.

Flake control (all required, or Layer 3 will be abandoned within a week):

- deterministic fixtures from Phase 0;
- fixed viewport, `reducedMotion: 'reduce'`, and a test-only override for
  `.animate-slide-up` (a 0.4s animation guarantees flake);
- **self-host or preload the Google Fonts** in `globals.css:1` — a network font
  fetch mid-screenshot is a classic snapshot flake;
- mask dynamic regions (dates, timestamps, "scraped at").

### Deliberately out of scope

OCR/scan *results* (nondeterministic, external models). Those pages are tested
with fixture rows only.

### Wiring

`npm run test:e2e`, `npm run test:e2e:update`, `npm run test:unit`. The Stop hook
keeps running the **fast** smoke test only — Playwright is too slow for a
per-turn hook, so it runs manually and in CI. Document that split.

---

## Phase 2 — shadcn prerequisites ✅ SHIPPED

> **State: DONE.** Next 15 + Tailwind 4, tsconfig on `ES2020`,
> `class-variance-authority`/`clsx`/`tailwind-merge` installed, `cn()` at
> `src/lib/utils.ts`, `components.json` written by `shadcn init -b base -p nova`,
> and `@base-ui/react` in place. **Base UI, not Radix** — it became shadcn's
> default in July 2026. Verified end-to-end by generating `ui/button.tsx`.

| # | Item | Notes |
|---|---|---|
| P1 | **tsconfig `target: es5` → `ES2020`** | Removes the documented `[...set]` spread ban. Radix/cmdk ship modern syntax; es5 without `downlevelIteration` is real friction. Next transpiles for browsers via SWC/browserslist regardless, so this is a type-check-level change. **Update the CLAUDE.md gotcha when done.** |
| P2 | **Next 15 + Tailwind 4 — SHIPPED** ✅ | Path B taken and it was cheap. See "The dependency cascade — resolved" below. |
| P3 | **Dependencies** | `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss-animate`, `@radix-ui/react-*` (per component), `cmdk` (combobox), and finally *using* `lucide-react` (installed, currently zero imports). |
| P4 | **`cn()` helper** at `src/lib/utils.ts` (clsx + tailwind-merge). shadcn assumes it exists. |
| P5 | **`components.json`** | `aliases.components: "@/components/ui"`, `aliases.utils: "@/lib/utils"`, `tailwind.css: "src/app/globals.css"`, `tsx: true`, and **`rsc: false`** — mandatory, the static export has no server. The `@/*` path alias already exists in tsconfig. ✅ |
| P6 | **Theme tokens — shadcn defaults** ✅ *decided* | Take shadcn's **default** CSS variable block verbatim rather than hand-mapping to the current palette. `baseColor: slate` (closest to the existing slate-heavy palette, so the shift is the least jarring option that's still a default). Default `--radius: 0.5rem` replaces the current `rounded-2xl` feel. See "What adopting the defaults actually changes" below. |
| P7 | **Retire the old vocabulary, don't preserve it** ✅ *decided* | Because the look is changing anyway, `.card` / `.panel` / `.btn*` / `.field-*` / `.badge` in `@layer components` get **deleted** as they're replaced, rather than kept in sync with shadcn variants. That also dissolves the `.card`-class-vs-`<Card>`-component collision by deletion. Same for `.glass-panel`, `.glass-panel-hover`, and `pulse-glow` once nothing references them. |
| P8 | **`data-loc` forwarding** | Verify every adopted component spreads `...props` so `data-loc` reaches the DOM. Radix and shadcn's generated components do. Layer 1 tests assert the key slugs still exist, which turns this from a documented hope into an enforced contract. |
| P9 | **Static-export gate** | Run `npm run build:mobile` (`BUILD_TARGET=static`) after prereqs **and after every migration phase**, to prove nothing pulled in a server-only dependency. This is the constraint most likely to break silently. |

### The dependency cascade — RESOLVED (Path B shipped 2026-07-22)

**Outcome: Next 15 + Tailwind 4 are in, on React 18, with zero source changes.**
The cascade the first attempt predicted (`Tailwind 4 → Node 20+ → Next 15+ →
likely React 19`) stopped one step short of React 19 — which is what made Path B
cheap.

What was actually required:

1. **`npm install next@15`** — that's the whole framework upgrade. Every Next
   15.x release accepts `react ^18.2.0` as a peer, so **React 19 was never
   needed**, and the React-19-compat risk for `react-easy-crop` /
   `lucide-react` (the main worry in the Path A/B table below) evaporated.
   Verified before installing: both libs declare React 18 support.
2. **`@tailwindcss/upgrade` in a `node:22-alpine` container** (Tailwind 4 needs
   Node ≥ 20; the host is on 18). It rewrote 16 source files, deleted
   `tailwind.config.js` in favour of a CSS-first `@theme` block, moved the
   shared vocabulary from `@layer components` to `@utility`, swapped PostCSS to
   `@tailwindcss/postcss`, and dropped `autoprefixer`.
3. **Nothing else.** No hand-fixes to components, no API migrations.

Verified on the isolated worktree stack: dev server healthy, **93 KB of CSS
compiled with `.card`/`.btn`/`.badge`/`.field-input` and the glassmorphism
`backdrop-filter` intact**, production `--target prod` image builds, the
Capacitor `BUILD_TARGET=static` export emits all 12 pages, typecheck clean,
**50/50 smoke assertions and 29/29 Playwright tests green across 3 consecutive
runs**.

**A caution for anyone re-reading the failure below:** Next 15 *still* vendors
`postcss@8.4.31` in its dependency list, exactly like Next 14. So the nested
version is **not** the diagnostic — only the runtime behaviour is. Don't
conclude from `cat node_modules/next/package.json` that it's still broken.

**A process note.** The retry initially failed with
`Cannot apply unknown utility class 'rounded-2xl'` — caused by *manually*
`npm install`-ing Tailwind 4 first and then running the upgrade tool, which left
a half-migrated state (v4 packages, v3 stylesheet). The tool must run against a
**clean v3 baseline** and do the dependency bump itself. Reverting to Tailwind 3
and re-running it in one shot worked.

---

<details>
<summary>Historical: the original blocked attempt (2026-07-19, rolled back)</summary>

Ran `@tailwindcss/upgrade` for real and backed it out. What it surfaced, in order:

1. **The upgrade tool needs Node ≥ 20.** Local Node is 18.20.8 (nvm has only 16
   and 18). Worked around by running the tool in a `node:22-alpine` container
   with an anonymous volume masking `node_modules`, so the Windows-built modules
   were never touched.
2. **The tool itself worked fine** — migrated 16 source files, converted
   `tailwind.config.js` into `@theme`, swapped PostCSS to `@tailwindcss/postcss`,
   dropped `autoprefixer`, and rewrote `@layer components` → `@utility`, plus
   renames (`focus:outline-none`→`outline-hidden`,
   `bg-gradient-to-r`→`bg-linear-to-r`, `z-[60]`→`z-60`).
3. **⛔ Tailwind 4 cannot run on Next 14.** `@tailwindcss/postcss@4.3.3` requires
   `postcss ^8.5.16`. The root install has 8.5.19 — but **Next 14.2.35 bundles
   its own nested `postcss@8.4.31`**, and Next's webpack CSS pipeline runs the
   plugin through *that* copy. Result:
   `TypeError: Cannot read properties of undefined (reading 'All')` on
   `globals.css:1`. Not fixable from the app side; it needs **Next 15+**.

So the real chain is **Tailwind 4 → Node 20+ → Next 15+ → (likely React 19)**,
not the single step the plan assumed.

**Kept from the attempt:** the Dockerfile bump to `node:22-alpine`. Node 18 is
EOL and the stack runs fine on 22 with Tailwind 3, so that's an independent win.

**Also learned — a `--build` alone is not enough.** The dev override masks
`node_modules` with an *anonymous volume*, and that volume **survives
`--build`**, so a rebuilt image's modules stay hidden behind the stale ones.
After any dependency change the correct command is:

```bash
docker compose up -d --build -V frontend   # -V = --renew-anon-volumes
```

Without `-V` you get a confusing `Cannot find module` for a package that is
demonstrably in `package.json`.

### Two ways forward — decided: **B**

| | Path | Cost | Ceiling |
|---|---|---|---|
| **A** | Stay on Tailwind 3, `shadcn@2.3.0`, **Radix** | None beyond the original plan | Frozen CLI; no Base UI; no new components |
| **B** | Next 14→15 first, then Tailwind 4, then current shadcn + **Base UI** | A framework major | Fully current, indefinitely |

**B is less scary than it sounds for this codebase specifically.** Next 15's
breaking changes are overwhelmingly about *server* APIs — async
`cookies()`/`headers()`/`params`, caching defaults, server actions. This app has
none of them: the Capacitor static-export constraint already forces every page
to be a client component fetching `${API_BASE_URL}` at runtime. The unknown is
React 19 compatibility for `react-easy-crop` and `lucide-react`.

**That prediction held.** B was chosen and shipped; the React 19 unknown never
materialised because Next 15 runs fine on React 18. Components therefore come
from **Base UI** (current shadcn's default), not the frozen `shadcn@2.3.0` +
Radix of Path A.

</details>

### Open items

- [x] ~~Decide Path A vs Path B.~~ **Decided: B.** Next 15 + Tailwind 4 shipped;
      Phase 3 targets **Base UI**.
- [x] ~~**P1 — `tsconfig.json` `target: es5` → `ES2020`.**~~ Done; verified a
      `[...set]`/`[...map]` probe compiles. The CLAUDE.md gotcha is retired.
- [x] ~~**P3/P4 — deps + `cn()`.**~~ Done (`cva`, `clsx`, `tailwind-merge`).
      `cmdk` deliberately **not** installed yet — Base UI may cover the combobox
      (M6); decide when that step is reached rather than adding a dep on spec.
- [x] ~~**P5 — `shadcn init -b base`.**~~ Done with preset `nova` (Lucide +
      Geist). **`rsc` had to be corrected to `false` by hand** — the CLI writes
      `true`, which would break the Capacitor static export. Note
      `components.json` rejects unknown keys, so that constraint could not be
      recorded as a comment inside the file; it lives in CLAUDE.md.
- [x] ~~**Decide the font question.**~~ **Resolved: Geist only, self-hosted.**
      The Inter/Outfit Google-CDN `@import` is gone. The deciding factor was not
      aesthetics but that a CDN webfont **fails offline** in the Capacitor build
      and adds a render-blocking third-party request; `next/font` bundles Geist.
      Verified: zero `fonts.googleapis`/`gstatic` requests at runtime.
- [x] ~~Before committing to B, spike **React 19 compatibility for
      `react-easy-crop` and `lucide-react`**~~ — **moot.** Next 15 accepts React
      18, so the app never moved to React 19. Was the one genuine unknown in that
      path, and cheap to test ahead of the framework major. `ImageCropper` is on
      the never-migrated list, so a `react-easy-crop` break would have to be
      solved rather than designed around.
- [ ] Once a path is picked, do P3–P5 together (deps, `cn()` helper,
      `components.json`) — they're inert until a component actually uses them.

### What adopting the defaults actually changes

Going with shadcn's defaults is the *less work* option, but it is a real visual
change, not a neutral one. Concretely, these go away unless deliberately kept:

- **The glassmorphism.** `.glass-panel` / `.card` are `rgba(8,12,28,0.65)` +
  `backdrop-filter: blur(12px)`. shadcn surfaces are flat and opaque.
- **The gradient identity.** `.btn-primary` is a violet→indigo gradient; shadcn's
  primary button is a flat solid fill.
- **The body treatment.** The two radial gradients over `#05070f`, and the
  violet custom scrollbars, are app-specific, not shadcn concepts.
- **Corner radius.** `--radius: 0.5rem` default vs the current `rounded-2xl`
  (1rem) house style.

Worth keeping on purpose (cheap, and they carry most of the brand):

- **The fonts** — Inter body / Outfit headings. shadcn prescribes no font, so
  keeping these costs nothing and preserves a lot of the app's character.
- **Dark mode as the default.** The app is dark-only today; shadcn ships both
  themes, so a light mode comes along free. Decide whether to expose a toggle or
  pin `.dark` on `<html>` and ignore it.

---

## Phase 3 — The migration STARTED

**Golden rule: rewrite internals, freeze public props.** The existing shared
components are the seam. Call sites don't move, and each diff stays reviewable.

Complete M4>M8 without needing to check in with the user

| # | Step | Why here |
|---|---|---|
| M1 | ✅ **SHIPPED — `Modal.tsx` internals → Base UI Dialog, props NOT frozen** | Went further than the original plan: rather than freeze `{zClass, backdropClass, panelClassName}` and fold duplicates into a default, **all three were deleted from the API**, per the "drop custom, use defaults" directive — they were the exact one-off config the directive targets. Props are now `{onClose, children, maxWidth?, dataLoc?}`. All 16 call sites updated (mechanical: delete the redundant prop; TS caught every miss). The built-in close button also replaced 11 duplicated inline-SVG "×" buttons across those same call sites — one more piece of the bulk the directive called out. `modalStack` deleted; Base UI's `Dialog.Root` scopes focus/Escape/outside-press per instance and needs no manual z-index — **verified** by the stacked-Escape test passing with zero z-index props anywhere. Gate held: all 6 modal tests + 29/29 full suite green, unmodified. |
| M2 | ✅ **SHIPPED — Badge, Label, Button, Card, and `.panel` done** | **Badge**: all 16 `<span>` usages → `<Badge variant="outline">` (verified pixel-identical via live A/B injection — the "outline" variant plus each caller's existing inline `text-*/bg-*/border-*` override reproduces the old look exactly). 3 usages are `<button>` elements (tag-remove chips with onClick) — deliberately left on the `.badge` utility class rather than forced through Base UI's `render`/`useRender` merge, since event-handler-merge correctness there couldn't be verified with the tooling at hand; revisit with a live click-test before converting those three. **Label**: of 24 `field-label` usages, only the 15 real `<label>` elements were converted — the other 9 are `<span>`/`<div>` stat headers or section headers with no associated form control, where a `<label>` element would be semantically wrong (dead click target, no control to focus). **Button**: all 48 `.btn`/`.btn-primary`/`.btn-secondary` usages across 14 files → `<Button>` (`variant="secondary"` for the old `.btn-secondary`, `variant="destructive"` for the two ad-hoc rose-tinted delete/remove buttons that had hand-rolled danger styling, default variant otherwise; `<Link>`s styled as buttons now use the exported `buttonVariants()` CVA function). **Card**: reassessed the "not a mechanical swap" concern from the previous pass — every one of the 35 `.card` divs in this codebase turned out to be genuinely flat (no header/content/footer separation in the actual design), so forcing a `CardHeader`/`CardContent`/`CardFooter` split would have invented structure that isn't there. Converted all 35 to bare `<Card className="...">`, keeping each call site's existing padding/rounding/spacing classes as overrides — `Card`'s own `py-(--card-spacing)` default is a lower-specificity fallback that `p-6`/`p-5`/etc. cleanly wins via `tailwind-merge`, so the visual result is unchanged (`bg-card`/`ring-1` shell now themed, same as Badge/Button) and no artificial sub-component nesting was added. One exception: `diary/page.tsx`'s `data-loc="diary.add-entry"` is a `<form>`, and `Card` only renders a `<div>` — left on the `.card` utility class since there's no polymorphic prop to change the underlying tag. **`.panel`** (30 usages across 12 files): decided against nesting shadcn's `ring-1`-bordered `<Card>` inside an outer `Card` for these — panels are compact item rows (a receipt line, a stat tile), not card-like surfaces, and the ring border would read as visually heavier than the original subtle treatment. Instead inlined the utility's own definition (`bg-muted/50 border rounded-lg`) directly at each call site — this still retires the bespoke class name in favor of stock Tailwind/shadcn tokens, just without introducing a component for something that isn't one. `.btn*`, `.card` (down to the one `<form>` exception), and `.panel` `@utility` rules all deleted from `globals.css` — three of four "RETIRING" classes now fully or almost-fully retired (`.badge` is the last, blocked on the 3 interactive-chip usages above). Verified: `tsc --noEmit` clean, full 29/29 Playwright suite green against the isolated stack after each of the three passes (Button, Card, `.panel`). |
| M3 | ✅ **SHIPPED — all 20 native `<select>` usages → Base UI `<Select>`** across 8 files (`MacroEditor`, `PriceEditor`, `ReviewItems` ×5, `page.tsx` ×4, `budget`, `meals` ×2, `diary` ×4, `scanner`). Mechanical per-site rewrite: `value`/`onChange` → `value`/`onValueChange` (Base UI's callback is `string \| null`, so every handler guards with `v && ...` or `v ?? fallback`); `<option>` → `SelectItem`; numeric `pageSize` state now round-trips through `String()`/`Number()` since Select values are always strings. Compact table-row selects (category/unit columns in `ReviewItems`, the scanner's store picker) pass `size="sm"` and `className="border-none bg-transparent"` to `SelectTrigger` to keep the dense, borderless look those cells need — the one deliberate customization in this pass, everything else takes shadcn's defaults. **Verified two ways**, because this is markup/behavior, not just a class swap, and the remote browser tool available in this session can't composite frames (screenshots fail, portaled listbox items report zero-size bounding rects) so it can't be trusted for interaction testing here: (1) `tsc --noEmit` clean end to end, (2) a **new permanent Playwright test** (`dashboard.spec.ts` — "the Add Food category Select opens, lists options, and picks one") drives a real headless Chromium through open → list → pick → value-updates, which the remote browser tool couldn't do reliably. Full 30/30 suite green (29 prior + this one new test) against the isolated stack. |
| M4 | ✅ **SHIPPED — Tabs** | **Audit** Active/Archived: converted the button pair to `<Tabs>`/`<TabsList>`/`<TabsTrigger>`, with two empty `<TabsContent>` panels (one per value) purely to satisfy the tab/panel ARIA pairing — the actual filtering is driven by `tab` state elsewhere on the page, unchanged. **Meals** Catalog/USDA: real content-swap, so `<TabsContent>` wraps each branch (catalog search vs `<NutritionSearch>`). Verified Base UI's `TabsPanel` defaults to `keepMounted={false}`, matching the original ternary's unmount-when-inactive behavior exactly — no risk of `NutritionSearch` firing background work while hidden. **Also fixed while here**: the generated `ui/sonner.tsx` imported lucide-react icon names (`CircleCheckIcon`, `TriangleAlertIcon`, `OctagonXIcon`) that don't exist in the pinned `lucide-react@^0.300.0` — bumped to `^1.25.0` (host has zero other lucide imports outside `ui/`, all app icons are hand-rolled inline SVG, so this is a no-risk bump). Also **dropped `next-themes`**, which the CLI wired into `sonner.tsx` for light/dark toggling — the app is dark-only (`className="dark"` pinned, no toggle), so `Toaster` now hardcodes `theme="dark"` instead of pulling in a provider for a switch that doesn't exist; this is the one deliberate deviation from "take the CLI output verbatim" in this pass, made in the same spirit as the "minimal bulk" directive. **New permanent Playwright test** (`meals.spec.ts`) drives the real content-swap tab (open builder → USDA tab hides catalog input, shows USDA search → back to Catalog restores it) — the audit tab didn't get one since it doesn't swap content, just filters. Full 31/31 suite green (30 prior + 1 new) against the isolated stack. |
| M5 | **Toast** — `StatusToast`/`useToast` → Sonner | Keep the `useToast()` call signature so call sites don't move. |
| M6 | **Combobox (cmdk)** | The four catalog-search pickers (`ReviewItems` match, meals ingredient picker, `ShareNutritionModal`, `NutritionSearch`). Biggest UX win, biggest rewrite — do it last among components. |
| M7 | **Popover / DropdownMenu** | Retires `lib/useClickOutside.ts` and fixes the `overflow-x-auto` clipping workaround in `ReviewItems`. |
| M8 | **Tooltip, Checkbox** | Low risk, mop-up. |

**Never migrated** (bespoke, not primitives): `ImageCropper` (react-easy-crop),
the SVG price-trend chart, image lightboxes, `ScanImages`, `RawModelOutput`.

**Page sweep last.** Once primitives exist, go page by page replacing pasted
utilities — dashboard → audit → meals → diary → budget → history → inbox →
staging → scanner → scrapes → settings. **One page per commit**, snapshots
reviewed each time.

---

## Phase 4 — Documentation and guardrails ⬜ NOT STARTED

- **CLAUDE.md**: rewrite the shared-class-vocabulary section (now
  `src/components/ui` + `cva` variants); ~~update the Modal invariant~~ **done in
  M1** — portaling is now Base UI's job, explanation kept since the
  transform/containing-block gotcha is still *why* it's required; ~~delete the
  es5 iteration gotcha~~ **done in Phase 2**; update the `data-loc` section for
  forwarding through shadcn components; add a
  new invariant: *UI primitives live in `src/components/ui` — don't hand-roll,
  and don't paste raw utilities for anything a primitive covers.*
- **README.md**: the verification story now includes Playwright.
- **A drift guard.** An ESLint rule or a grep check in the smoke script that
  fails when a known pasted utility string reappears (e.g.
  `bg-slate-950 border border-white/10 rounded-lg`). **This is the part a
  library alone does not give you** — shadcn narrows the easy path, it doesn't
  close it. Without this, drift returns.

---

## Sequencing

```
Phase 0 ✅  →  Phase 1 🟡  →  Phase 2 🟡  →  Phase 3 ⬜  →  Phase 4 ⬜
(smoke+seed)  (test net)     (prereqs)      (migration)    (docs)
```

Rough effort: Phase 0 ≈ half a session · Phase 1 ≈ 1–2 sessions · Phase 2 ≈ half
a session · Phase 3 ≈ the bulk, several sessions · Phase 4 ≈ folded into each.

**Next action:** Phase 2's blocker is the real fork in the road — pick Path A
(stay on Tailwind 3 + frozen `shadcn@2.3.0`) or Path B (Next 14→15 first). Phase
3 cannot start until that's decided, since it determines whether components come
from Radix or Base UI. The Phase 1 open items above are independent and can be
picked up in any order meanwhile.
