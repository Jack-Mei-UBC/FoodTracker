# FoodTracker

![FoodTracker](docs/banner.svg)

[![smoke](https://github.com/Jack-Mei-UBC/FoodTracker/actions/workflows/smoke.yml/badge.svg)](https://github.com/Jack-Mei-UBC/FoodTracker/actions/workflows/smoke.yml)
&nbsp;![Next.js](https://img.shields.io/badge/Next.js-15-000?logo=next.js)
&nbsp;![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
&nbsp;![FastAPI](https://img.shields.io/badge/FastAPI-Python%203.12-009688?logo=fastapi&logoColor=white)
&nbsp;![Postgres](https://img.shields.io/badge/Postgres-15-4169e1?logo=postgresql&logoColor=white)
&nbsp;![Docker](https://img.shields.io/badge/Docker-compose-2496ed?logo=docker&logoColor=white)
&nbsp;![License](https://img.shields.io/badge/License-MIT-a78bfa)

**Grocery price-intelligence + calorie tracking, built as a polyglot microservice stack — and developed with a disciplined agentic loop.**

FoodTracker turns photos of receipts and shelf tags into structured price data, tracks prices across stores, and doubles as a nutrition diary (with USDA FoodData Central lookup). It's a real, running system: six containers, three languages, a human-in-the-loop OCR pipeline, and a full audit/revert trail on every price mutation.

This README covers both **how the system works** and **how it's built** — the second half describes the agent loop used to develop it, which is the part I'm most deliberate about.

---

## Screenshots

> Captured against the seeded dev stack — see [`docs/screenshots/CAPTURE.md`](docs/screenshots/CAPTURE.md) to regenerate.

| Dashboard — sortable catalog, canonical per-kg prices | Price history — trend + per-serving & per-100 |
|---|---|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Price history](docs/screenshots/price-history.png) |
| **Inbox — OCR review, crop beside original, raw model output** | **Audit — bulk clean-up, tags, merge** |
| ![Inbox review](docs/screenshots/inbox-review.png) | ![Audit](docs/screenshots/audit.png) |
| **Meals — live macro & cost preview** | **Budget — spend vs. target, by store & month** |
| ![Meals](docs/screenshots/meals.png) | ![Budget](docs/screenshots/budget.png) |

---

## Table of contents
- [Architecture](#architecture)
- [Data model](#data-model)
- [Running it](#running-it)
- [The agentic development loop](#the-agentic-development-loop)
- [Verification](#verification)
- [Conventions & invariants](#conventions--invariants)
- [Repo layout](#repo-layout)

---

## Architecture

Six containers orchestrated by `docker-compose.yml`. Each service is its own package — there is no root `package.json`, so services version and deploy independently.

| Service | Stack | Port | Role |
|---|---|---|---|
| `frontend` | Next.js 15 (App Router), TS, Tailwind 4, shadcn/ui + Base UI | 3000 | PWA UI |
| `backend` | Express, TypeScript | 4000 | REST API; owns Postgres; enqueues jobs |
| `worker` | BullMQ, Node/TS | — | Processes the scraping **and** OCR queues |
| `ocr-service` | FastAPI, Python 3.12 | 8000 (loopback) | Vision-LLM extraction via OpenRouter |
| `db` | Postgres 15 | 5432 | Relational data |
| `redis` | Redis 7 | 6379 | BullMQ queues |

```mermaid
flowchart LR
  UI[Next.js PWA] -->|REST| API[Express API]
  API -->|enqueue scan/scrape| Q[(Redis / BullMQ)]
  W[Worker] -->|dequeue| Q
  W -->|flyer JSON| Flipp[(Flipp flyer API)]
  W -->|sale post HTML| Cocowest[(cocowest.ca)]
  W -->|write prices via REST| API
  W -->|extract, one model per scan| OCR[FastAPI OCR]
  OCR -->|vision LLM| OR[OpenRouter]
  API -->|meal drafting LLM| OR
  API --> DB[(Postgres)]
  W --> DB
  API -->|nutrition lookup| FDC[USDA FoodData Central]
```

**One OCR ingestion path, ending in human review — nothing extracted is ever saved without a person approving it:**

**Intake → Staging → background OCR → Inbox** (`/scanner` → `/staging` → `/inbox`): the **Scanner** is a pure uploader — browser → `POST /api/scan-jobs` stores each image as a **staged** job (nothing runs yet). On **Staging** the user crops the ones that need it and sends them for processing (with an optional "use paid models" toggle) → the worker runs them through its **multi-model pool** → each result is held on a `scan_jobs` row → reviewed in the shared review grid in the **Inbox** for edit/approve/commit.

**Multi-model pool for throughput.** Free vision models are individually slow (~60–90s) and flaky, so the worker runs the `ocr-queue` in parallel — **all free models busy at once, each on a different scan** — and **retries a scan on the next model** if one fails. Model selection lives entirely in the worker (`worker/src/modelPool.ts`); the OCR service is a dumb per-model executor that sends the image **directly to one vision model** (no Tesseract), extracting structured fields with a reprompt-retry and graceful `unknown`+`raw_text` degradation. The four model lists (free/paid × image/text) are configured by env — see `.env.example`.

**One photo, several regions.** A capture isn't a single classification — a photo can hold a receipt next to a shelf tag, or a loose barcode, all at once. The model segments each photo into `captures[]` (`receipt | price_tag | barcode`, each with its own extracted items), and the worker fetches the catalog's tag vocabulary (`GET /api/tags`) to pass along so extracted items come back with `tags: string[]` — constrained to that vocabulary, never invented. The Inbox groups a mixed scan's review rows by which region they came from and lets you add/remove tags per row before committing.

Cropping uses a shared **`<ImageCropper>`** (also reused by the food-icon picker) on the **Staging** page, letting you crop a whole batch before sending it. The cropped image is what gets read and what committed prices reference; the full original is stored too and linked back from the crop (`images.original_image_id`), so nothing is lost. The Inbox shows **both** — the crop beside its uncropped original — so a crop that cut off the product name is obvious rather than a mystery.

**When a scan comes back useless, the Inbox is where it gets fixed** (the loop runs backwards, not into the bin):
- **Every model's output is kept — permanently.** The worker tries several models and stores only the best result on `scan_jobs.result`/`attempts`, but that gets overwritten on every re-run and cleared on re-crop. `scan_runs` is the append-only record underneath: one row per model call, ever, including before a restage — model, prompt version, tag vocabulary offered, full response — so nothing is lost across a re-crop or a re-process. The Inbox surfaces the current attempts in a collapsible "Raw model output" panel (auto-expanded when nothing parsed, including on **failed** jobs) plus the full run history underneath. A scan often reads fine and merely fails to *parse* — that text is now recoverable instead of discarded.
- **Send it back to Staging to re-crop.** `POST /api/scan-jobs/:id/restage` returns the job to `staged` and **restores the uncropped original**, so the re-crop starts from the full photo rather than tightening a bad one.

**Flyer scraping (two sources, one queue).** The worker drains a `scraping-queue` shared by both scrapers, branching on a `source` field in the job payload:
- **Flipp** (`source: 'flipp'`, default): hits Flipp's public flyer JSON API (`backflipp.wishabi.com` — **no headless browser**, the worker image is plain `node:20-slim`), fuzzy-matches merchants to the store name, and either logs one deal per tracked food (catalog mode) or every matching deal for a search query (query mode).
- **cocowest.ca** (`source: 'cocowest'`): given a cocowest.ca "weekend update" post URL, regex-parses the `<img alt>` text of every product photo (item number, name, size, savings, expiry, price — no JSON API, no DOM parser needed) and logs a price for **every** item against a chosen store (typically "Costco"), creating foods (category `Costco`) for anything unmatched.

Both parse pack sizes into `amount`/`amount_unit` with a shared regex-based parser (`worker/src/scrape-common.ts`) and write each deal **through the backend REST API** so scraped prices get the same unit normalization, `food_prices` join, and audit entry as every other source. Each run is tracked on a `scrape_jobs` row (status/phase/progress + a per-price detail list) surfaced live on the `/scrapes` page; each logged price also saves its source image (Flipp clipping image or cocowest product photo, attached via `image_id`, shown in the same lightbox as receipt photos) and a link back to where it came from. Progress bookkeeping is written direct via the worker's pg pool; only the prices go through the audited API.

---

## Data model

Core entities are **stores, foods, price_logs**; calorie tracking adds **food_nutrition, consumption_logs, user_goals**; meal planning adds **meals, meal_ingredients**; budget tracking adds **receipts, budget_goals**. A few decisions worth calling out because they show up throughout the code:

- **Many-to-many by design.** Foods relate to prices and nutrition through join tables (`food_prices`, `food_macros`), so one price observation or nutrition profile can be shared across foods — two different products can point at the same nutrition facts, and editing them updates both. The origin `food_id` columns are retained for the audit trail and back-compat.
- **Audit + revert on every price mutation.** Create / update / delete each write a before/after JSONB snapshot in the same transaction as the mutation. Deletes are soft; reverts are themselves audited, so reverts are revertible.
- **History is immutable by snapshot.** Diary entries store the nutrient values computed *at log time* — editing a food's facts later never rewrites your history.
- **Sales expire, so sale prices do too.** A price logged as a sale carries the last day it's valid (`price_logs.sale_ends_at`), and once that day passes it stops counting as a current price — it drops out of the dashboard, best-price comparisons and meal costs, while History keeps it, because the sale really did happen. The date comes from whatever knows best: the scan reads it off the receipt or shelf tag, flyer scrapes take the flyer's own end date, and anything left over falls back to a configurable default duration (**Settings** page) that you can override per item while reviewing a scan. Without this a one-week special would be quoted as the item's price forever.
- **One array drives the schema.** The full nutrient column set is declared once (`NUTRIENT_FIELDS` in `backend/src/nutrition.ts`); the server builds its `INSERT` / `UPDATE` / `SUM` column lists from it. Adding a nutrient is a migration plus one array entry.
- **Meals are recipes, computed live.** A meal is a named list of ingredient amounts; its macros and cost are never stored — every read scales each ingredient's current facts and prices it against the food's latest tracked purchase (density-converting mass↔volume where needed). Logging a meal writes **one** diary entry (per-serving nutrients × portions, snapshotted like any other entry), and an LLM can draft a meal from selected "fridge" foods against macro targets — always returned as an unsaved draft the user reviews in the builder, same human-in-the-loop rule as OCR.
- **Foods carry an optional dashboard icon** (`foods.image_id`, nullable FK → `images`). When unset it falls back to the earliest image attached to one of the food's linked price logs, so most foods get a sensible thumbnail automatically; the user can override it with any saved scan/scrape photo or a freshly cropped upload.
- **The catalog is auditable in bulk.** The Costco scraper logs everything in a flyer post — including phones and luggage — so the **Audit** page lets you sweep the whole catalog, filter it, and archive, recategorize, tag, or **merge** items en masse. Archiving is a soft delete (`foods.deleted_at`): archived items disappear from every list but keep their data and can be restored. Merging collapses duplicate rows (three "pork tenderloin" entries → one) into a chosen survivor that inherits every source's prices, names, nutrition and tags — done by hand, or from an LLM "find duplicates" scan you review before anything merges.
- **Receipts track spending, not just prices.** Committing a receipt scan records **one** `receipts` row — the store source and the receipt's total cost — linked to its photo and scan job; you can also add receipts by hand for cash trips. The **Budget** page tracks the month's spend against an optional monthly target, broken down by store and over time. This is separate from `price_logs`: prices answer "what does milk cost?", receipts answer "how much did I spend this month?".

---

## Running it

Requires Docker and a `.env` (copy `.env.example`). Two API keys are optional but unlock features: `OPENROUTER_API_KEY` (OCR) and `FDC_API_KEY` (USDA nutrition lookup).

```bash
cp .env.example .env          # then fill in keys
docker compose up -d --build  # whole stack
```

- UI: http://localhost:3000
- API: http://127.0.0.1:4000/api/health
- Rebuild one service after editing it: `docker compose up -d --build backend`
- Follow logs: `docker compose logs -f worker`

**Schema note:** `db/schema.sql` only runs on a *fresh* Postgres volume. Migrations are written idempotently (`ADD COLUMN IF NOT EXISTS`, …) and applied to a running DB by hand via `psql` — documented in [CLAUDE.md](CLAUDE.md).

### Mobile (iOS / Android)

The frontend is a client-side SPA that talks to the REST API, so it packages into native App Store / Play Store apps via [Capacitor](https://capacitorjs.com/) with no rewrite. `frontend/next.config.js` produces a static bundle when `BUILD_TARGET=static`; `capacitor.config.ts` wraps `./out` in a native WebView shell.

```bash
cd frontend
npx cap add android          # and/or:  npx cap add ios   (iOS requires macOS)
NEXT_PUBLIC_API_URL=https://your-public-backend npm run mobile:sync   # build:mobile + cap sync
npm run mobile:open:android  # opens Android Studio / Xcode to build & sign
```

The one requirement is infrastructure, not code: the backend stack must be hosted publicly over **HTTPS**, and `NEXT_PUBLIC_API_URL` (baked in at build time) must point at it — a phone has no `localhost:4000`. The backend already sends permissive CORS for the Capacitor origin.

---

## The agentic development loop

This project is built with [Claude Code](https://claude.com/claude-code) as the primary implementer, driven by a **spec-first, verify-every-turn** loop rather than ad-hoc prompting. The scaffolding for that loop lives in the repo, not just in my head:

```mermaid
flowchart TD
  Spec[CLAUDE.md<br/>invariants, gotchas, hand-synced contracts] --> Plan
  Plan[Agent plans a change] --> Impl[Agent implements across services]
  Impl -.->|checkpoints| Agents[Subagents<br/>contract-guard · invariant-reviewer · verifier]
  Agents -.-> Impl
  Impl --> Hook{Stop hooks}
  Hook -->|tsc + smoke-test.ps1| Verify[Typecheck + read-only checks vs the running stack]
  Verify -->|regression| Impl
  Verify -->|green| Gate{Push gate}
  Gate -->|big diff, no doc updates| DocSync[doc-sync agent rectifies the docs]
  DocSync --> Gate
  Gate -->|pass| Human[Human review + OCR approval]
  Human --> Spec
```

**1. `CLAUDE.md` is the living spec.** It's not a stale doc — it encodes the invariants an agent (or a new contributor) will otherwise get wrong: the three hand-synced cross-language contracts, the "schema.sql only runs on a fresh volume" trap, the pre-ES2015 iteration constraint in the frontend build, and the architectural rules (e.g. *there are exactly two input surfaces for price and macros; reuse them, don't fork*). Every non-obvious constraint learned during development is written back here, so the next change starts from accumulated context instead of rediscovering the same landmines.

**2. Every turn is verified.** Two `Stop` hooks (`.claude/settings.json`) run when the agent finishes a turn: a per-service `tsc --noEmit` for any service with uncommitted changes, then `scripts/smoke-test.ps1` — read-only checks against the live backend and frontend (API contracts, the M:N join reads, diary micronutrient sums, USDA proxy, every page returning 200). It's deliberately safe to run on a loop: it *skips* when the stack is down (loudly — "NOTHING WAS VERIFIED", with a `STRICT=1` mode that fails instead, which CI uses) and only fails on a real regression, feeding the failure back to the agent to fix. No green, no done.

**3. Guardrails are enforced, not remembered.** A `PreToolUse` hook (`scripts/hooks/pre-bash-guard.ps1`) denies state-destroying commands outright — `docker compose down -v` (the Postgres volume *is* the price history), `docker volume rm`, force-pushes, destructive SQL — and a **doc-sync push gate** blocks pushing a large diff that touches no documentation until the docs are rectified or the bypass is used deliberately. The rules in CLAUDE.md are also wired into the harness, so an agent can't drift past them by accident.

**4. Specialized subagents are checkpoints of the loop** (`.claude/agents/`): **contract-guard** re-verifies the hand-synced cross-language contract pairs after either side changes; **invariant-reviewer** reads the branch diff against CLAUDE.md's invariants before a change is called done; **doc-sync** rectifies CLAUDE.md/README/the migration plan against the diff before a PR (it's what the push gate demands); **verifier** runs the full ladder — typecheck ×3, STRICT smoke, Playwright, and the static-export build gate — before a merge. Each is scoped to the minimum tools it needs (the reviewers are read-only).

**5. Humans stay in the loop where it matters.** OCR is treated as an ingestion *supplement*, never an oracle: extracted items always pass through a review-and-approve step before they touch the database. The same rule applies to every LLM surface — meal drafts, auto-tagging, duplicate-merge suggestions are all unsaved drafts until a person approves them. The agent builds the pipeline; a person confirms the data.

**6. Single sources of truth over copy-paste.** Recurring logic is consolidated so a change lands in one place: two shared popup components for all price/macros entry (`PriceEditor`, `MacroEditor`), one `NUTRIENT_FIELDS` array driving both schema and SQL, one fuzzy matcher, one unit-normalization table per side of the wire. Where a contract *must* be duplicated across languages, it's labeled in-file and listed in `CLAUDE.md`.

The result is a loop where the agent can make cross-cutting changes (a new nutrient touches Postgres, Express, and two React surfaces) and immediately know whether it broke anything.

---

## Verification

There is no unit-test suite by design — this is an integration-heavy system where the meaningful signal is "does the running stack still honor its contracts." That signal is captured in `scripts/smoke-test.ps1`:

```bash
# runs automatically as a Stop hook; run it by hand any time:
powershell -File scripts/smoke-test.ps1
```

It gates on backend health, then asserts the foods/diary/goals/efficiency endpoints, the join-table reads, micronutrient aggregation, the scraper contract (unknown-store 404 + the `scrape-jobs` progress feed), the budget/receipts contract (summary shape + negative-total 400), the USDA lookup, and every page. Exit `0` = green, `2` = regression, and it no-ops when the stack isn't running.

The same checks run in **CI** (`.github/workflows/smoke.yml`) via a portable bash twin, `scripts/smoke-test.sh`, so the "every change is verified" guarantee holds for outside contributors too — not just on my machine. CI boots only the services the checks need (`db`, `redis`, `backend`, `frontend`) and runs in strict mode (`STRICT=1` — a stack that fails to boot is a failing build, never a silent skip).

On top of the smoke net sits a **Playwright UI test net** (`frontend/e2e/` — [its README](frontend/e2e/README.md), 35 tests and counting): route smoke for every page plus style-agnostic *interaction contracts* — modal viewport-centering and stacked-Escape ordering, dashboard search/sort/filter, the per-100 kcal basis, the expired-sale rule, and (added alongside the shadcn/ui migration) real click-driven tests for the Base UI primitives that replaced hand-rolled markup: a `Select` opening and picking an option, a `Tabs` swap, a `Checkbox` toggling via its label text (not just the control itself), a `Command` combobox's `onSelect`, and a `Badge` rendered as a clickable filter chip. Seeded from a deterministic fixture set inserted through the REST API. It's deliberately **not** wired to the per-turn Stop hook (too slow) — run it with the stack up: `docker compose up -d --wait`, then `npm run seed && npm run test:e2e` from `frontend/`.

---

## Conventions & invariants

The full list lives in [CLAUDE.md](CLAUDE.md). The load-bearing ones:

- **Two input surfaces, reused everywhere.** `PriceEditor` and `MacroEditor` are the only ways to enter a price or nutrition facts — launched from the dashboard, diary, inbox, and history. Don't build a third form.
- **One shared `Modal` for every popup**, now a thin wrapper over Base UI's `Dialog` — it portals into `document.body`, which is what keeps it out of any transformed ancestor's containing block (the bug behind "modals open in the middle of the page"; the app no longer has a transformed ancestor to trigger it, but the portal is what makes that a non-issue going forward too). Don't hand-roll a `fixed inset-0` overlay.
- **UI primitives live in `frontend/src/components/ui/`** (shadcn/ui generated components over Base UI, not Radix). The old hand-rolled Tailwind class vocabulary (`.card`, `.field-input`, `.field-label`, `.btn*`, `.badge`) has been migrated to real components (`Card`, `Input`, `Label`, `Button`, `Badge`, plus `Select`/`Tabs`/`Checkbox`/`Command`/`Popover`/`DropdownMenu`/Sonner) — see [SHADCN-MIGRATION.md](SHADCN-MIGRATION.md) for the full record. Reuse the primitive, don't paste raw utilities or hand-roll a new one. Major JSX regions carry a `{/* ═══ Section: … ═══ */}` banner so they're easy to point at.
- **Three hand-synced contracts** (OCR response shape — now a composite `captures[]` per photo — unit tables, nutrition scaling) are duplicated across languages and kept in sync by hand; each file says so.
- **Every "current price" query filters `deleted_at IS NULL`.**
- **`consumed_at` is a naive local timestamp** — the client owns timezone handling.

---

## Repo layout

```
backend/       Express API, audit trail, unit + nutrition + FDC logic
frontend/      Next.js PWA (dashboard, meals, diary, scanner, staging, inbox, scrapes, history, budget, audit, settings)
worker/        BullMQ consumer: Flipp + cocowest.ca flyer scrapers + OCR job runner
ocr-service/   FastAPI vision-LLM extraction
db/schema.sql  Idempotent schema + seed data
scripts/       smoke-test.ps1 + .sh twins (the verification loop), manual-ai-tests.ps1, hooks/
.claude/       settings.json (hooks wiring the loop) + agents/ (the four subagents)
CLAUDE.md      The living spec: invariants, gotchas, architecture
ROADMAP.md     Candidate future features (shopping lists, weekly planner, …)
SHADCN-MIGRATION.md  shadcn/ui restyle plan + record (phased, test-gated — Phase 3 shipped)
```
