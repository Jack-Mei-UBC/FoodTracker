# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## How to work in this repo (the loop)
This file is the source of truth. It records the invariants and gotchas that a change will otherwise get wrong — read it before editing, and write anything non-obvious you learn back into it. The development loop is: **plan against these invariants → implement across services → let the `Stop` hook run `scripts/smoke-test.ps1` against the running stack → fix any regression before finishing → humans approve anything OCR extracted → close the loop by updating the docs.** There is no unit-test suite; the smoke tests are the regression net, so keep them green and extend them when you add a contract. See [README.md](README.md) for the architecture and a fuller description of this loop.

**Closing the loop — the last step of any change is documentation.** Before you report a change as done, update the docs to match reality: **CLAUDE.md** for a new/changed contract, invariant, endpoint, gotcha, schema shape, or architectural rule; **README.md** when the change alters the architecture, service roles, the data model, the page list, or the verification story. If a change genuinely touches none of those (a pure bug fix, a refactor with no contract change, a docs-only edit), say so explicitly in your final message — "no doc update needed because …" — so the omission is a decision, not an oversight. When in doubt, add the line to CLAUDE.md; a stale spec costs the next session more than an extra sentence costs you.

**When the user corrects an approach mid-task** (wrong assumption, rejected pattern, a gotcha that bit them), add it to this file in the moment — under Critical gotchas if it's a durable invariant, or inline near the relevant section otherwise — rather than only fixing the immediate diff. This file is shared by every future session in this repo, so a correction recorded here won't need to be repeated.

## Project context
FoodTracker is a grocery price-intelligence app. Core entities: **stores, foods, price_logs**. The OCR service is a data-ingestion supplement — it turns photos of receipts / shelf price tags into structured price data that maps onto the `foods` / `price_logs` schema. Nothing extracted by OCR is ever saved without passing through a human review step first.

## Services & how to run
Six containers orchestrated by `docker-compose.yml` (no root package.json — each service is its own package):

| Service | Stack | Port | Role |
|---|---|---|---|
| `frontend` | Next.js 14 App Router, TS, Tailwind | 3000 | PWA UI |
| `backend` | Express, TS | 4000 | REST API; owns Postgres; enqueues jobs |
| `worker` | BullMQ, Node/TS | — | Processes `scraping-queue` **and** `ocr-queue` |
| `ocr-service` | FastAPI, Python 3.12 | 8000 (loopback only) | Vision-LLM extraction via OpenRouter |
| `db` | Postgres 15 | 5432 | Relational data |
| `redis` | Redis 7 | 6379 | BullMQ queues |

```bash
docker compose up -d --build            # whole stack
docker compose up -d --build backend    # rebuild one service (do this after editing it)
docker compose logs -f worker           # follow a service's logs
docker compose exec -T db psql -U postgres -d foodtracker -c "\dt"
```

Per-service dev (outside Docker): `npm run dev | build | start` in `backend/`, `worker/`, `frontend/`. For ocr-service: `uvicorn app.main:app --port 8000` (needs `OPENROUTER_API_KEY`).

There is **no automated test suite.** Verify changes with `curl` against `http://127.0.0.1:4000`, the UI at `http://localhost:3000`, and `docker compose logs`.

## Critical gotchas
- **`db/schema.sql` only runs on a *fresh* Postgres volume** (via `docker-entrypoint-initdb.d`). On an existing DB it does **not** re-run. So every schema change must be (1) added to `schema.sql` as idempotent `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` / `ALTER`, **and** (2) applied to the running DB manually via `docker compose exec -T db psql -U postgres -d foodtracker <<'SQL' ... SQL`.
- **Three contracts are duplicated across languages/packages and must be kept in sync by hand** (each file says so in a comment):
  - OCR response shape: `ocr-service/app/models.py` ↔ `frontend/src/types/scan.ts`
  - Unit-conversion tables: `backend/src/units.ts` ↔ `frontend/src/lib/units.ts`
  - Nutrition scaling: `backend/src/nutrition.ts` (source of truth at commit) ↔ `frontend/src/lib/nutrition.ts` (live preview)
- **Frontend tsconfig targets pre-ES2015 iteration** — spreading a `Set`/`Map` (`[...set]`) fails the build. Use `Array.from(...)` / `.concat(...)`.
- **The OpenRouter free vision model is slow (~60–90s) and flaky** (often returns `type: "unknown"`). `ocr-service/app/openrouter.py` does one reprompt-retry and degrades to `unknown` gracefully; the worker/UI expect this. For reliable/fast runs, set `OCR_MODEL` in root `.env` to a paid model (e.g. `google/gemini-2.5-flash`).
- `ocr-service` is bound to `127.0.0.1:8000` (host curl only). Internal callers use `http://ocr-service:8000` via `OCR_SERVICE_URL` (frontend proxy route and worker).

## Architecture

### OCR ingestion — two paths, both end in human review
1. **Synchronous** (`/scanner`): browser → Next.js proxy `frontend/src/app/api/scan/route.ts` → `ocr-service POST /scan` → `ScanResponse` → rendered in `<ReviewItems>` for edit/approve/commit.
2. **Background queue** ("Queue for Later" / `/inbox`): browser → Express `POST /api/scan-jobs` (multer writes the image to the shared `uploads` volume) → `addOcrJob` enqueues `ocr-queue` → `worker` reads the image, calls `ocr-service`, stores the `ScanResponse` JSON on the `scan_jobs` row → `/inbox` polls status and opens the result in the **same** `<ReviewItems>` for review.

`ocr-service` sends the image **directly to a vision model** (no Tesseract/OCR engine): one call classifies `receipt | price_tag | unknown` and extracts structured fields. Model is `OCR_MODEL` (env). Pipeline: `imaging.py` (EXIF-rotate, downscale, JPEG) → `openrouter.py` → validated against `models.py`.

### Review & commit are centralized
`frontend/src/components/ReviewItems.tsx` is shared by the scanner and the inbox. It:
- fuzzy-matches each extracted item to the existing catalog via `frontend/src/lib/match.ts` (`bestCatalogMatch`, a dependency-free `token_set_ratio` with abbreviation/size normalization),
- flags items as `new_product` / `price_anomaly` (>30% vs latest) / low-confidence,
- computes live price-per-unit via `frontend/src/lib/units.ts` (`formatUnitPrice`),
- commits by `POST /api/foods` (create if new) + `POST /api/foods/:id/prices`.

### Data model (`db/schema.sql`)
- `foods` (name, barcode, category, unit), `stores`.
- `price_logs`: `price`, `amount` + `amount_unit`, normalized `unit_price` (`DECIMAL(12,5)`), `is_sale`, `source` (`scan|manual|scraper|queue`), and `deleted_at` (**soft delete**).
- `audit_log`: before/after JSONB snapshot of every price_log **and consumption_log** mutation, with `reverted_at`. Revert (`POST /api/audit-log/:id/revert`) only supports `price_log` entries.
- `scan_jobs`: background OCR jobs (`status`, `image_path`, `result` JSONB, `store_id`).

### Calorie tracking
- `food_nutrition` (1:1 with `foods`): per-serving label facts (`serving_size` + `serving_unit` in the shared unit vocabulary, `calories`, macros, and micronutrients). Upsert via `PUT /api/foods/:id/nutrition`; included in `GET /api/foods` as `nutrition`. The full nutrient column set is defined once as `NUTRIENT_FIELDS` in `backend/src/nutrition.ts` — server.ts builds its nutrition/consumption `INSERT`/`UPDATE`/`SUM` column lists from it, so **adding a nutrient = a schema migration + one entry in that array** (and matching display metadata in `frontend/src/lib/nutrition.ts` `MACRO_META`/`MICRO_META`).
- `consumption_logs`: diary entries. All nutrients (calories + macros + micros) are a **snapshot computed at log time** (`backend/src/nutrition.ts` `scaleNutrients` — supports the diary-only unit `serving`, deliberately not added to the synced `units.ts`); editing a food's facts never rewrites history. `food_name` is denormalized; soft delete + audited (`entity_type='consumption_log'`). `GET /api/diary` sums every nutrient column for the day's micronutrient totals.
- `user_goals`: single row (id=1) of daily calorie/macro targets. `GET /api/diary?date=YYYY-MM-DD` returns a day's entries + totals + goals. `consumed_at` is a naive timestamp — the client owns timezone handling (send local `consumed_at` and an explicit `?date=`).
- USDA FoodData Central lookup: `GET /api/nutrition-search?q=<text or barcode>` (`backend/src/fdc.ts`) proxies FDC search (key: `FDC_API_KEY` in root `.env`) and returns per-serving candidates; the nutrition editor in the dashboard food modal prefills from a picked candidate (`source: 'usda'`) and the user confirms before saving.
- `frontend/src/components/FoodDetailModal.tsx`: reusable food modal opened from a **diary** entry and the **inbox** review. Lists a food's names, prices, and nutrition; add/remove names inline (`POST/DELETE /api/foods/:id/aliases`); view a price log's attached photo in a lightbox (`image_id` → `GET /api/images/:id`). Price and macro editing are delegated to the two shared popups below — it only lists and launches them. Loads via `GET /api/foods/:id`.

### Foods ↔ prices/nutrition are many-to-many
- Join tables `food_prices(food_id, price_log_id)` and `food_macros(food_id, nutrition_id)` are the authoritative food→x links for reads; `price_logs.food_id` / `food_nutrition.food_id` remain as the **origin owner** (audit + back-compat) and are kept in sync on create. A food's list/detail prices and its effective nutrition (owned preferred, else first linked) are read **through the joins**. Backfilled from the origin columns; the audit-log join still uses `pl.food_id`.
- Link/unlink an existing price or nutrition profile to additional foods: `POST/DELETE /api/foods/:id/prices/:priceLogId/link` and `POST/DELETE /api/foods/:id/macros/:nutritionId/link`.
- `food_nutrition.food_id` keeps a UNIQUE (one owned profile per food); sharing across foods happens via `food_macros`.

### Two shared popups for entering price / macros — reuse these, don't fork
There are exactly **two** input surfaces for a food's price and nutrition, both **popup modals** (`z-[80]`), reused everywhere:
- `frontend/src/components/PriceEditor.tsx` — one price log. **Add** (no `log` → `POST /api/foods/:foodId/prices`) or **edit** (`log` → audited `PUT /api/price-logs/:id`, optional `DELETE`). Props: `{ foodId, foodName?, log?, stores?, onClose, onSaved, onDeleted? }`.
- `frontend/src/components/MacroEditor.tsx` — one food's per-serving nutrition facts (serving, calories, macros, collapsible micros) + USDA search. `PUT /api/foods/:id/nutrition`. Props: `{ foodId, foodName?, barcode?, nutrition?, onClose, onSaved }`.

Both are launched (never re-implemented) from: the **dashboard** food modal, the **diary**/**inbox** `FoodDetailModal`, and — PriceEditor also — the **history** table (Edit → popup). If you need a price/macro form anywhere, open one of these. (`ReviewItems`' bulk scan grid is a separate concern: it edits *extracted* items pre-commit, not existing price_logs/foods.) Known names are add/rename/delete-able from the dashboard food modal and add/delete-able from `FoodDetailModal`.

### Price-per-unit normalization
`amount` + `amount_unit` (e.g. `2 lb`) normalize to a base unit (grams / ml / each) to produce `unit_price` (price per base unit) for cross-package comparison. The backend (`units.ts`, used in `POST/PUT /api/foods/:id/prices`) is the source of truth; the frontend copy is display-only.

**Canonical dashboard display (kg standard).** Every price shown on the dashboard cards / PriceEditor preview / FoodDetailModal price lines goes through `formatCanonicalUnitPrice` (`frontend/src/lib/units.ts`, display-only, no backend twin) which reads the price in **one standard unit per dimension** so rows are comparable regardless of how they were entered: **mass → per kg**, **volume → per kg** (via `foods.density`, see below), **count → per each**. When the as-entered unit isn't already the canonical one it's appended in brackets **as purchased** — total price over the purchased amount, not reduced to a per-single-unit figure (so a 600 g pack reads `$7.48/kg ($4.49/600g)`, never `$0.01/g`). The purchased amount is omitted when it's 1: `$4.41/kg ($2.00/lb)`, `$1.20/kg ($1.20/L)`, `$0.25/each ($3.00/dozen)`. This required the `GET /api/foods` `latest_prices` subquery to also select `pl.amount, pl.amount_unit` (the card computes the per-kg value client-side from price+amount+unit, not from `unit_price`). Count can't be expressed per kg without a per-item weight (not modelled), so count stays per-each.

### Density (`foods.density`)
`foods.density` (`DECIMAL(8,4)`, default 1, must be > 0) is kilograms per litre, used **only** to convert a per-volume price into a per-kg price for the canonical display above (water ≈ 1, oil ≈ 0.92, honey ≈ 1.42). Display/value-only: it does **not** touch the stored `unit_price` (still per ml) nor nutrition. Accepted on `POST`/`PUT /api/foods` (validated > 0), returned via `SELECT f.*`. Edited from the dashboard food modal and `FoodDetailModal`, where the density input is shown **only when the food's `unit` is a volume unit** (`normalizeUnit(unit)?.dimension === 'volume'`); passed as `density` into `PriceEditor` for its live preview.

### Usable portion (`foods.usable_pct`)
`foods.usable_pct` (`DECIMAL(6,2)`, default 100, must be > 0) is the percent of a purchased amount that is actually usable — e.g. 70 for chicken drumsticks (30% bone), or **>100** for dry goods that expand when prepared (dry lentils → cooked). Edited via `PUT /api/foods/:id` (accepted on `POST` too); returned on every `GET /api/foods*` via `SELECT f.*`. It is **display/value-only**: `frontend/src/lib/units.ts` `formatUnitPrice(price, amount, unit, usablePct?)` divides the per-unit price by `usablePct/100` and suffixes " usable" (an effective cost per *usable* unit). It deliberately does **not** touch nutrition scaling (labels are already per edible serving) nor the stored `unit_price` (raw, audited, and shareable across foods via the M:N join). The efficiency endpoint compares prices within one food, so `usable_pct` cancels there — no change. Editable from the dashboard food modal and `FoodDetailModal`; passed as `usablePct` into `PriceEditor` for its live preview.

### History, audit & revert
Every price_log create/update/delete flows through `backend/src/audit.ts` `recordAudit` **inside the same transaction** as the mutation. Deletes are soft (`deleted_at`); revert (`POST /api/audit-log/:id/revert`) applies the inverse and is itself audited (so reverts are revertible). Any query that surfaces a "current" price — `GET /api/foods` `latest_prices` subquery and `GET /api/prices/efficiency` — must filter `deleted_at IS NULL`. UI: `frontend/src/app/history/page.tsx`.

### Scraper (Flipp flyers)
`worker/src/worker.ts` also processes `scraping-queue` (triggered by `POST /api/scrape/:storeId`, body `{ postal_code?, query? }`; postal code falls back to `FLIPP_POSTAL_CODE` in root `.env`). `worker/src/flipp.ts` hits Flipp's public flyer JSON API (`backflipp.wishabi.com/flipp/items/search` — the flipp.com backend; **no Playwright/browser**, the worker image is plain `node:20-slim`) and keeps items whose merchant fuzzy-matches the store name — so the store must be named like the Flipp merchant ("Walmart", "Save-On-Foods"). With a `query` it logs up to 15 matching deals (creating foods with category `Scraped` when nothing in the catalog matches); without one it searches each catalog food (capped at 50, rate-limited) and logs the single best-scoring current deal per food. Pack sizes are parsed from flyer item names/affixes ("473mL", "2 x 96g", "/lb", "2/" multi-buys) into `amount` + `amount_unit`. The worker writes **through the backend REST API** (`BACKEND_URL`, i.e. `POST /api/foods/:id/prices` with `source: 'scraper'`) — never direct SQL — so scraped prices get unit normalization, their `food_prices` join row (without it they'd be invisible to reads), and an audit entry like every other source.

**Progress tracking + source images.** `POST /api/scrape/:storeId` first inserts a `scrape_jobs` row (`db/schema.sql`) and passes its id on the queue job as `scrapeJobId`; the response includes `scrapeJobId`. The worker updates that row's `status`/`phase`/`total`/`processed`/`logged` as it runs and **appends one detail record per logged price** to `items` JSONB (food, flyer name, price, `image_id`, `flyer_url`). These progress writes go **direct via the worker's pg pool** (bookkeeping, like the OCR path's `scan_jobs` updates) — only the *prices* go through the audited backend API. For each logged price the worker downloads the item's Flipp **clipping image** (`clipping_image_url`) and registers it as an `images` row by POSTing multipart to `POST /api/images` (reusing the photo path), then attaches the returned `image_id` to the price log — so scraped prices show their real flyer artwork in the existing `image_id` lightbox everywhere (FoodDetailModal, history). `flipp.ts` `flippItemUrl` builds `https://flipp.com/en-ca/item/<flyer_item_id>` — the deep link to the flyer page the item came from (**Flipp's JSON API exposes only per-item clipping images, no full-page rasters**, so "the relevant page" is a link, not a saved image). Reads: `GET /api/scrape-jobs` (list, `item_count` only) and `GET /api/scrape-jobs/:id` (full `items`). UI: `frontend/src/app/scrapes/page.tsx` — live progress list (polls every 2s while any job is `queued`/`processing`), expandable per-run to show each logged price with its saved flyer thumbnail (lightbox) and a "Flyer page ↗" link; the dashboard scrape form redirects to `/scrapes?job=<id>` (auto-expands, needs a `<Suspense>` boundary for `useSearchParams`).

### Second scraper source: cocowest.ca Costco sale posts
`worker/src/cocowest.ts` scrapes cocowest.ca "weekend update" blog posts, which list Costco BC/AB/SK/MB flyer sale items. Triggered by `POST /api/scrape-cocowest`, body `{ store_id, url }` (`url` must match `cocowest.ca`) — no postal code or merchant matching, since the whole post belongs to whichever store the caller selects (create a "Costco" store first). Shares the same `scrape_jobs` table and `scraping-queue` as Flipp: `backend/src/queue.ts` `addCocowestScrapeJob` enqueues `{ ..., source: 'cocowest', url }`, and `worker/src/worker.ts`'s queue handler branches on `job.data.source` (`'flipp'` is the default for back-compat with jobs already in flight) to call `scrapeCocowest` instead of `scrapeFlippFlyers`. `scrapeCocowest` mirrors Flipp's *query mode*: log a price for **every** parseable item, creating a food with **category `Costco`** when nothing in the catalog fuzzy-matches (the confirmed scope choice — the post mixes grocery with electronics/appliances/toys, and everything gets logged rather than filtered).

- **No JSON API, no DOM parser.** cocowest is a WordPress blog; each item is one `<img>` whose `alt` text carries `ITEM# NAME SIZE ($SAVINGS INSTANT SAVINGS EXPIRES ON YYYY-MM-DD)? $PRICE` and whose `data-src` (not `src`, which is an inline SVG lazyload placeholder) is the real product photo. `cocowest.ts` parses this with regex, not an HTML/DOM parser — it keeps the worker's plain `node:20-slim` image dependency-free, and is actually more robust here: some product names contain an unescaped `"` (e.g. `ACER 27"...`), which truncates the `alt` attribute in the raw HTML itself (not a parser bug). Those items have no trailing `$price` after truncation and are silently skipped — in practice this is ~40 of ~380 images per post, almost all non-grocery electronics/TVs.
- **Shared parsing/matching.** Amount/unit parsing (`parseAmount`) and catalog fuzzy-matching (`nameMatchScore`, `symmetricMatchScore`) were pulled out of `flipp.ts` into `worker/src/scrape-common.ts` so both scrapers use one implementation; `flipp.ts`'s `parseFlippAmount` is now a thin wrapper that reads the multi-buy quantity from Flipp's `pre_price_text` and delegates. `scrape-common.ts` also adds a `PACK OF (\d+)` pattern (cocowest phrasing) alongside Flipp's `N PK`/`N CT` forms.
- **Images and progress.** Per logged item, `saveFlyerImage(item.image_url)` downloads the cocowest product photo and registers it via `POST /api/images` exactly like the Flipp path, so cocowest-sourced prices get the same `image_id` lightbox everywhere. `flyer_url` in each `scrape_jobs.items` record is the cocowest **post URL** (not a per-item deep link — cocowest has no per-item page).
- **Schema:** `scrape_jobs.source` (`'flipp'|'cocowest'`, default `'flipp'`) and `scrape_jobs.source_url` (cocowest's post URL) — added via the usual `ADD COLUMN IF NOT EXISTS` pattern in `db/schema.sql`, so existing DBs need the manual `ALTER TABLE` too (see the schema.sql gotcha above).
