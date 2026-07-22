-- Create Stores Table
CREATE TABLE IF NOT EXISTS stores (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255),
    logo_url TEXT,
    -- Store geolocation, learned from photo EXIF GPS.
    latitude DECIMAL(9,6),
    longitude DECIMAL(9,6),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Soft delete for stores (same convention as foods/price_logs). NOT a hard delete:
-- price_logs.store_id is ON DELETE CASCADE, so a real DELETE would wipe a store's
-- whole price history. Soft-deleting hides it from the pickers (GET /api/stores
-- filters deleted_at) while old prices/receipts still resolve its name by id.
-- Added post-hoc, so existing DBs need the manual ALTER too (schema.sql gotcha).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Create Foods Table
CREATE TABLE IF NOT EXISTS foods (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    barcode VARCHAR(50) UNIQUE,
    description TEXT,
    category VARCHAR(100),
    unit VARCHAR(50) DEFAULT 'each',
    -- Fraction of the purchased amount that is actually usable, as a percent
    -- (100 = all usable; 70 = 30% waste such as bone; >100 for dry goods that
    -- expand when prepared, e.g. dry lentils). Scales a food's raw price into an
    -- effective cost per *usable* unit; nutrition is unaffected.
    usable_pct DECIMAL(6,2) NOT NULL DEFAULT 100 CHECK (usable_pct > 0),
    -- Density in kilograms per litre, for foods sold by volume. Lets a per-volume
    -- price be expressed per kg on the dashboard (water/most liquids ≈ 1.0; oil
    -- ≈ 0.92; honey ≈ 1.42). Display/value-only; does not affect stored unit_price.
    density DECIMAL(8,4) NOT NULL DEFAULT 1 CHECK (density > 0),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Idempotent add for existing DBs (schema.sql only runs on a fresh volume; apply
-- this manually to a running DB — see CLAUDE.md).
ALTER TABLE foods ADD COLUMN IF NOT EXISTS density DECIMAL(8,4) NOT NULL DEFAULT 1 CHECK (density > 0);

-- Soft delete (same convention as price_logs / consumption_logs / receipts), so a
-- food can be archived out of the catalog and restored. Needed because the
-- cocowest scraper logs every item in a Costco post — including non-food
-- (electronics, luggage) — and the /audit page bulk-archives those. Every catalog
-- read filters `deleted_at IS NULL`; meal/diary history still resolves archived
-- foods by id so past records keep working.
ALTER TABLE foods ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_foods_deleted ON foods(deleted_at);

-- Uploaded scan images (one row per capture). GPS extracted from EXIF when present;
-- used to auto-locate stores. price_logs / scan_jobs link here so every logged
-- price keeps its source photo. Defined before those tables so they can reference it.
CREATE TABLE IF NOT EXISTS images (
    id SERIAL PRIMARY KEY,
    path TEXT NOT NULL,
    original_filename TEXT,
    latitude DECIMAL(9,6),
    longitude DECIMAL(9,6),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- A cropped image links back to the full-resolution original it was derived from
-- (the scanner's crop-before-OCR step stores both; the crop is the row referenced
-- by price_logs/scan_jobs, and it points at its original here). NULL for originals
-- and non-crop uploads. Self-referential, so it must be added after `images` exists.
ALTER TABLE images ADD COLUMN IF NOT EXISTS original_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL;

-- Food icon: a cropped image the user chose to represent this food on the
-- dashboard. NULL falls back to the earliest non-deleted image attached to
-- one of the food's linked price logs (see GET /api/foods `display_image_id`).
-- Must be added here (after `images` exists) since `foods` is defined above it.
ALTER TABLE foods ADD COLUMN IF NOT EXISTS image_id INTEGER REFERENCES images(id) ON DELETE SET NULL;

-- Create Price Logs Table
CREATE TABLE IF NOT EXISTS price_logs (
    id SERIAL PRIMARY KEY,
    food_id INTEGER REFERENCES foods(id) ON DELETE CASCADE,
    store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
    price DECIMAL(10, 2) NOT NULL,
    -- The amount that `price` bought, as entered (e.g. 2 + 'lb', 1 + 'gal', 12 + 'ct').
    amount DECIMAL(10, 3),
    amount_unit VARCHAR(20),
    -- Normalized price per base unit (per gram / ml / each). Wide precision so
    -- per-gram values (e.g. 0.0035) are not truncated to zero.
    unit_price DECIMAL(12, 5),
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_sale BOOLEAN DEFAULT FALSE,
    -- Soft delete so history entries can be restored/reverted.
    deleted_at TIMESTAMP,
    -- Where this price came from: scan | manual | scraper | queue.
    source VARCHAR(20) DEFAULT 'manual',
    -- Source photo for this price observation.
    image_id INTEGER REFERENCES images(id) ON DELETE SET NULL
);

-- When a SALE price stops being valid. Only meaningful with is_sale = true; a
-- regular (non-sale) price never expires, so NULL means "no expiry". Every read
-- that surfaces a food's CURRENT price filters expired sales out (see the
-- ACTIVE_PRICE_SQL predicate in backend/src/server.ts) — history deliberately
-- still shows them, since the sale really did happen.
-- Added post-hoc: existing DBs need the manual ALTER (see the schema.sql gotcha).
ALTER TABLE price_logs ADD COLUMN IF NOT EXISTS sale_ends_at DATE;
CREATE INDEX IF NOT EXISTS idx_price_logs_sale_ends ON price_logs(sale_ends_at) WHERE sale_ends_at IS NOT NULL;

-- App-wide settings, single row (id = 1) — same bootstrap pattern as user_goals
-- and budget_goals. default_sale_days is how long a sale is assumed to run when
-- a scan finds a sale price but no printed end date.
CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    default_sale_days INTEGER NOT NULL DEFAULT 7,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT app_settings_singleton CHECK (id = 1),
    CONSTRAINT app_settings_days_positive CHECK (default_sale_days > 0)
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Background OCR jobs: images uploaded for server-side processing, results
-- held for pending review (never auto-committed).
CREATE TABLE IF NOT EXISTS scan_jobs (
    id SERIAL PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'queued', -- staged|queued|processing|done|failed|reviewed|discarded ('staged' = uploaded, awaiting crop+send on /staging; not yet enqueued)
    image_path TEXT,
    original_filename TEXT,
    store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
    result JSONB,
    error TEXT,
    image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(status);
-- Whether the worker's model pool may use PAID vision models for this job (the
-- per-batch "Use paid models" toggle on /staging). Added post-hoc, so existing
-- DBs need the manual ALTER too (see the schema.sql gotcha in CLAUDE.md).
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS use_paid BOOLEAN NOT NULL DEFAULT false;
-- Per-model attempt log: one record per vision model the worker tried for this
-- job — [{ model, ok, type, item_count, confidence, raw_text, error }]. `result`
-- keeps only the single best body, so without this every other model's output
-- (including the text a model DID read while returning type=unknown) is lost.
-- Written on both the done and failed paths, so a hard failure keeps a trace too.
-- Added post-hoc: existing DBs need the manual ALTER (see the schema.sql gotcha).
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS attempts JSONB;

-- Append-only per-model-call history for scan jobs, never cleared or overwritten
-- (unlike scan_jobs.attempts/result, which restage and reprocessing reset). This
-- is what makes a scan re-processable later: it keeps the exact image, model,
-- prompt version and tag vocabulary used for EVERY call, including calls made
-- before a re-crop or a prompt change, so past runs can be compared against new
-- ones instead of being destroyed by the next attempt. Written direct via the
-- worker's pg pool (bookkeeping, like scan_jobs progress updates) — never
-- audited, same precedent as scrape_jobs progress and the restage endpoint.
CREATE TABLE IF NOT EXISTS scan_runs (
    id SERIAL PRIMARY KEY,
    scan_job_id INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    -- The exact image bytes this call read — a re-crop repoints scan_jobs.image_id,
    -- so this is what lets a later run distinguish "read the crop" from "read the
    -- original" for the same scan_job_id.
    image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
    model VARCHAR(120) NOT NULL,
    use_paid BOOLEAN NOT NULL DEFAULT false,
    -- Hash of the system prompt in force at call time (ocr-service PROMPT_VERSION).
    -- Without this a better result later can't be attributed to a new model vs a
    -- new prompt.
    prompt_version VARCHAR(64),
    -- Tag vocabulary (names) offered to the model for this call — drifts as tags
    -- are added/removed, so it's captured per-run rather than assumed from the
    -- current GET /api/tags.
    tags_vocab JSONB,
    ok BOOLEAN NOT NULL,
    was_winner BOOLEAN NOT NULL DEFAULT false,
    capture_type VARCHAR(20), -- receipt | price_tag | barcode | mixed | unknown, null on hard failure
    item_count INTEGER,
    confidence DECIMAL(4, 3),
    response JSONB, -- full parsed ScanResponse body
    raw_text TEXT,
    error TEXT, -- network/HTTP/parse failure detail, null when ok
    duration_ms INTEGER,
    started_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scan_runs_job ON scan_runs(scan_job_id);

-- Background scrape jobs — progress tracking for both scraper sources (Flipp
-- flyers and cocowest.ca Costco sale posts). One row per POST /api/scrape/:storeId
-- (source='flipp') or POST /api/scrape-cocowest (source='cocowest'). The worker
-- updates phase/counters as it runs and appends a detail record per logged price
-- to `items` (each carries the saved source image_id and a deep link back to
-- where the item came from), so the UI can show live progress and provenance
-- for every scraped price.
CREATE TABLE IF NOT EXISTS scrape_jobs (
    id SERIAL PRIMARY KEY,
    store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
    store_name VARCHAR(255),
    source VARCHAR(20) NOT NULL DEFAULT 'flipp', -- flipp|cocowest
    source_url TEXT,                   -- cocowest only: the post that was scraped
    postal_code VARCHAR(10),           -- flipp only
    query TEXT,                        -- flipp only; NULL = full-catalog scan
    status VARCHAR(20) NOT NULL DEFAULT 'queued', -- queued|processing|done|failed
    phase TEXT,                        -- human-readable current step
    total INTEGER NOT NULL DEFAULT 0,  -- planned units of work (searches / items)
    processed INTEGER NOT NULL DEFAULT 0, -- completed units of work
    logged INTEGER NOT NULL DEFAULT 0, -- prices actually logged
    items JSONB NOT NULL DEFAULT '[]', -- per-logged-price detail (see comment above)
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP
);
ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'flipp';
ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS source_url TEXT;
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status ON scrape_jobs(status);
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_created ON scrape_jobs(created_at);

-- Audit trail: every mutation of a price log, with before/after snapshots so
-- any change can be reverted. entity_type is 'price_log' for now.
CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(30) NOT NULL DEFAULT 'price_log',
    entity_id INTEGER NOT NULL,
    action VARCHAR(20) NOT NULL,          -- create | update | delete | restore | revert
    before_data JSONB,
    after_data JSONB,
    note TEXT,
    reverted_at TIMESTAMP,                -- set when this change has been undone
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- Alternate names for foods, learned from verified OCR matches. The fuzzy matcher
-- scores against these too; the dashboard modal lets the user reorder/rename them.
CREATE TABLE IF NOT EXISTS food_aliases (
    id SERIAL PRIMARY KEY,
    food_id INTEGER REFERENCES foods(id) ON DELETE CASCADE,
    alias VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_food_aliases_unique ON food_aliases(food_id, lower(alias));

-- ── Calorie tracking ────────────────────────────────────────────────────────

-- Nutrition facts per food (1:1). Values are per serving, as printed on the
-- label; serving_size + serving_unit use the same unit vocabulary as
-- price_logs.amount_unit so amounts normalize through the shared units tables.
CREATE TABLE IF NOT EXISTS food_nutrition (
    id SERIAL PRIMARY KEY,
    food_id INTEGER UNIQUE NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    serving_size DECIMAL(10, 3) NOT NULL,
    serving_unit VARCHAR(20) NOT NULL,
    calories DECIMAL(10, 2) NOT NULL,     -- kcal per serving
    protein_g DECIMAL(10, 2),
    carbs_g DECIMAL(10, 2),
    fat_g DECIMAL(10, 2),
    -- Micronutrients (all per serving). Fats/sugars in g, minerals/cholesterol
    -- in mg, vitamins A/D in mcg, vitamin C in mg.
    saturated_fat_g DECIMAL(10, 2),
    trans_fat_g DECIMAL(10, 2),
    cholesterol_mg DECIMAL(10, 2),
    sodium_mg DECIMAL(10, 2),
    fiber_g DECIMAL(10, 2),
    sugar_g DECIMAL(10, 2),
    added_sugar_g DECIMAL(10, 2),
    potassium_mg DECIMAL(10, 2),
    calcium_mg DECIMAL(10, 2),
    iron_mg DECIMAL(10, 2),
    vitamin_a_mcg DECIMAL(10, 2),
    vitamin_c_mg DECIMAL(10, 2),
    vitamin_d_mcg DECIMAL(10, 2),
    -- Where the facts came from: manual | usda (FoodData Central) | scan.
    source VARCHAR(20) DEFAULT 'manual',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Diary entries. Nutrient columns are a snapshot computed at log time, so
-- later edits to a food's nutrition facts never rewrite diary history.
-- food_name is denormalized for the same reason (and food_id survives as NULL
-- if the catalog entry is ever removed). amount_unit may also be 'serving'.
CREATE TABLE IF NOT EXISTS consumption_logs (
    id SERIAL PRIMARY KEY,
    food_id INTEGER REFERENCES foods(id) ON DELETE SET NULL,
    food_name VARCHAR(255) NOT NULL,
    consumed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    meal VARCHAR(20) NOT NULL DEFAULT 'snack', -- breakfast | lunch | dinner | snack
    amount DECIMAL(10, 3) NOT NULL,
    amount_unit VARCHAR(20) NOT NULL,
    calories DECIMAL(10, 2),
    protein_g DECIMAL(10, 2),
    carbs_g DECIMAL(10, 2),
    fat_g DECIMAL(10, 2),
    -- Micronutrient snapshot (per entry, at log time) — same set as food_nutrition.
    saturated_fat_g DECIMAL(10, 2),
    trans_fat_g DECIMAL(10, 2),
    cholesterol_mg DECIMAL(10, 2),
    sodium_mg DECIMAL(10, 2),
    fiber_g DECIMAL(10, 2),
    sugar_g DECIMAL(10, 2),
    added_sugar_g DECIMAL(10, 2),
    potassium_mg DECIMAL(10, 2),
    calcium_mg DECIMAL(10, 2),
    iron_mg DECIMAL(10, 2),
    vitamin_a_mcg DECIMAL(10, 2),
    vitamin_c_mg DECIMAL(10, 2),
    vitamin_d_mcg DECIMAL(10, 2),
    notes TEXT,
    source VARCHAR(20) DEFAULT 'manual',
    -- Soft delete, same convention as price_logs.
    deleted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consumption_logs_consumed ON consumption_logs(consumed_at);
CREATE INDEX IF NOT EXISTS idx_consumption_logs_food ON consumption_logs(food_id);

-- Many-to-many associations. A price observation or a nutrition profile can be
-- shared across multiple foods (e.g. brand variants that share macros, or one
-- receipt line linked to several catalog items), and a food has many of each.
-- price_logs.food_id / food_nutrition.food_id remain as the "origin" owner
-- (audit + back-compat); these join tables are the authoritative food<->x links
-- for reads.
CREATE TABLE IF NOT EXISTS food_prices (
    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    price_log_id INTEGER NOT NULL REFERENCES price_logs(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (food_id, price_log_id)
);
CREATE INDEX IF NOT EXISTS idx_food_prices_price ON food_prices(price_log_id);

CREATE TABLE IF NOT EXISTS food_macros (
    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    nutrition_id INTEGER NOT NULL REFERENCES food_nutrition(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (food_id, nutrition_id)
);
CREATE INDEX IF NOT EXISTS idx_food_macros_nutrition ON food_macros(nutrition_id);

-- ── Meal plans ───────────────────────────────────────────────────────────────

-- A meal (recipe) composed of catalog foods. `servings` is how many portions
-- the recipe makes; totals ÷ servings gives per-portion macros/cost. Macros and
-- cost are always computed live from the ingredients (never stored), so a
-- meal's numbers track the foods' current facts and latest prices.
CREATE TABLE IF NOT EXISTS meals (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    notes TEXT,
    servings DECIMAL(8, 2) NOT NULL DEFAULT 1 CHECK (servings > 0),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Ingredients: an amount of a catalog food. amount_unit uses the shared unit
-- vocabulary plus the diary-only 'serving' (a multiple of the food's serving
-- size). Hard-deleted with the meal (meals are not audited; clone covers
-- recovery).
CREATE TABLE IF NOT EXISTS meal_ingredients (
    id SERIAL PRIMARY KEY,
    meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    amount DECIMAL(10, 3) NOT NULL CHECK (amount > 0),
    amount_unit VARCHAR(20) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_meal_ingredients_meal ON meal_ingredients(meal_id);

-- Provenance for diary entries logged from a meal (source='meal'). Nullable;
-- consumption_logs is defined above, so this is an idempotent add (apply
-- manually to a running DB — see CLAUDE.md).
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS meal_id INTEGER REFERENCES meals(id) ON DELETE SET NULL;

-- Single-row daily targets (single-user app; id=1 always). Functional bootstrap
-- (not demo data): the app and smoke tests expect the id=1 row to exist.
CREATE TABLE IF NOT EXISTS user_goals (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    daily_calories DECIMAL(10, 2) DEFAULT 2000,
    protein_g DECIMAL(10, 2),
    carbs_g DECIMAL(10, 2),
    fat_g DECIMAL(10, 2),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO user_goals (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── Tags ─────────────────────────────────────────────────────────────────────

-- Free-form labels for foods, many-to-many (a food has many tags, a tag has many
-- foods) — unlike `foods.category`, which is single-valued. Created and applied
-- from the /audit page, including by the LLM auto-tagger (which only ever
-- proposes; the user applies). Name is unique case-insensitively.
CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(60) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(lower(name));

CREATE TABLE IF NOT EXISTS food_tags (
    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (food_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_food_tags_tag ON food_tags(tag_id);

-- ── Budget / spending tracking ───────────────────────────────────────────────

-- One row per shopping trip / receipt: the store it came from and the total
-- spent. Populated automatically when a receipt scan is committed in ReviewItems
-- (source='scan', linked to its photo + scan job), and addable by hand for cash
-- or un-scanned purchases (source='manual'). store_name is denormalized so the
-- spend record survives the store being deleted (store_id ON DELETE SET NULL).
-- Soft-deleted like price_logs.
CREATE TABLE IF NOT EXISTS receipts (
    id SERIAL PRIMARY KEY,
    store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
    store_name VARCHAR(255),
    total DECIMAL(10, 2) NOT NULL CHECK (total >= 0),
    purchased_on DATE NOT NULL DEFAULT CURRENT_DATE,
    item_count INTEGER NOT NULL DEFAULT 0,
    source VARCHAR(20) NOT NULL DEFAULT 'manual', -- scan | manual
    notes TEXT,
    image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
    scan_job_id INTEGER REFERENCES scan_jobs(id) ON DELETE SET NULL,
    deleted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_receipts_purchased ON receipts(purchased_on);
CREATE INDEX IF NOT EXISTS idx_receipts_store ON receipts(store_id);

-- Single-row monthly spending target (single-user app; id=1 always), mirroring
-- user_goals. NULL monthly_budget = no target set (tracking still works without one).
CREATE TABLE IF NOT EXISTS budget_goals (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    monthly_budget DECIMAL(10, 2),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO budget_goals (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Create indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_price_logs_food ON price_logs(food_id);
CREATE INDEX IF NOT EXISTS idx_price_logs_store ON price_logs(store_id);
CREATE INDEX IF NOT EXISTS idx_price_logs_scraped ON price_logs(scraped_at);

-- ── Optional demo seed data ──────────────────────────────────────────────────
-- Uncomment the block below to populate a fresh DB with example stores/foods/
-- prices (e.g. so scripts/smoke-test.ps1 has data to assert against). Not run by
-- default. Note: schema.sql only runs on a fresh Postgres volume.
--
-- INSERT INTO stores (name, location, logo_url) VALUES
-- ('SuperMarket Central', 'Downtown', 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&q=80&w=200'),
-- ('Organic Grocer', 'Westside', 'https://images.unsplash.com/photo-1578916171728-46686eac8d58?auto=format&fit=crop&q=80&w=200'),
-- ('Value Foods', 'East End', 'https://images.unsplash.com/photo-1607344645866-009c320c5ab8?auto=format&fit=crop&q=80&w=200')
-- ON CONFLICT DO NOTHING;
--
-- INSERT INTO foods (name, barcode, description, category, unit) VALUES
-- ('Organic Bananas', '000000001', 'Fresh organic bananas', 'Fruits', 'lb'),
-- ('Whole Milk 1G', '000000002', 'Grade A Pasteurized Whole Milk', 'Dairy', 'gal'),
-- ('Sourdough Bread', '000000003', 'Freshly baked sourdough bread loaf', 'Bakery', 'each'),
-- ('Cage Free Brown Eggs Large 12ct', '000000004', 'One dozen cage-free brown eggs', 'Dairy', 'each'),
-- ('Greek Yogurt Honey 32oz', '000000005', 'Strained honey-flavored Greek yogurt', 'Dairy', 'each')
-- ON CONFLICT DO NOTHING;
--
-- INSERT INTO price_logs (food_id, store_id, price, unit_price, is_sale) VALUES
-- (1, 1, 0.89, 0.89, false),
-- (1, 2, 1.19, 1.19, false),
-- (1, 3, 0.79, 0.79, true),
-- (2, 1, 3.49, 3.49, false),
-- (2, 2, 4.29, 4.29, false),
-- (2, 3, 2.99, 2.99, true),
-- (3, 1, 2.99, 2.99, false),
-- (3, 2, 3.99, 3.99, false),
-- (4, 1, 3.99, 3.99, false),
-- (4, 3, 3.49, 3.49, false),
-- (5, 2, 5.49, 5.49, false)
-- ON CONFLICT DO NOTHING;
