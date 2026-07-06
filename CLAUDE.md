# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## How to work in this repo (the loop)
This file is the source of truth. It records the invariants and gotchas that a change will otherwise get wrong — read it before editing, and write anything non-obvious you learn back into it. The development loop is: **plan against these invariants → implement across services → let the `Stop` hook run `scripts/smoke-test.ps1` against the running stack → fix any regression before finishing → humans approve anything OCR extracted.** There is no unit-test suite; the smoke tests are the regression net, so keep them green and extend them when you add a contract. See [README.md](README.md) for the architecture and a fuller description of this loop.

## Project context
FoodTracker is a grocery price-intelligence app. Core entities: **stores, foods, price_logs**. The OCR service is a data-ingestion supplement — it turns photos of receipts / shelf price tags into structured price data that maps onto the `foods` / `price_logs` schema. Nothing extracted by OCR is ever saved without passing through a human review step first.

## Services & how to run
Six containers orchestrated by `docker-compose.yml` (no root package.json — each service is its own package):

| Service | Stack | Port | Role |
|---|---|---|---|
| `frontend` | Next.js 14 App Router, TS, Tailwind | 3000 | PWA UI |
| `backend` | Express, TS | 4000 | REST API; owns Postgres; enqueues jobs |
| `worker` | BullMQ + Playwright, Node/TS | — | Processes `scraping-queue` **and** `ocr-queue` |
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

### History, audit & revert
Every price_log create/update/delete flows through `backend/src/audit.ts` `recordAudit` **inside the same transaction** as the mutation. Deletes are soft (`deleted_at`); revert (`POST /api/audit-log/:id/revert`) applies the inverse and is itself audited (so reverts are revertible). Any query that surfaces a "current" price — `GET /api/foods` `latest_prices` subquery and `GET /api/prices/efficiency` — must filter `deleted_at IS NULL`. UI: `frontend/src/app/history/page.tsx`.

### Scraper (pre-existing)
`worker/src/worker.ts` also runs a Playwright scraper on `scraping-queue` (triggered by `POST /api/scrape/:storeId`) that inserts price_logs directly (these are **not** audited).
