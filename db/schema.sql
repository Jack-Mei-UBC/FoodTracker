-- Create Stores Table
CREATE TABLE IF NOT EXISTS stores (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255),
    logo_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Foods Table
CREATE TABLE IF NOT EXISTS foods (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    barcode VARCHAR(50) UNIQUE,
    description TEXT,
    category VARCHAR(100),
    unit VARCHAR(50) DEFAULT 'each',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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
    source VARCHAR(20) DEFAULT 'manual'
);

-- Idempotent upgrades for existing databases (CREATE TABLE only runs on a fresh volume).
ALTER TABLE price_logs ADD COLUMN IF NOT EXISTS amount DECIMAL(10, 3);
ALTER TABLE price_logs ADD COLUMN IF NOT EXISTS amount_unit VARCHAR(20);
ALTER TABLE price_logs ALTER COLUMN unit_price TYPE DECIMAL(12, 5);
ALTER TABLE price_logs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE price_logs ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'manual';

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

-- Background OCR jobs: images uploaded for server-side processing, results
-- held for pending review (never auto-committed).
CREATE TABLE IF NOT EXISTS scan_jobs (
    id SERIAL PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'queued', -- queued|processing|done|failed|reviewed|discarded
    image_path TEXT,
    original_filename TEXT,
    store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
    result JSONB,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(status);

-- Uploaded scan images (one row per capture). GPS extracted from EXIF when present;
-- used to auto-locate stores. price_logs link here so every logged price keeps its
-- source photo.
CREATE TABLE IF NOT EXISTS images (
    id SERIAL PRIMARY KEY,
    path TEXT NOT NULL,
    original_filename TEXT,
    latitude DECIMAL(9,6),
    longitude DECIMAL(9,6),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE price_logs ADD COLUMN IF NOT EXISTS image_id INTEGER REFERENCES images(id) ON DELETE SET NULL;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS image_id INTEGER REFERENCES images(id) ON DELETE SET NULL;

-- Alternate names for foods, learned from verified OCR matches. The fuzzy matcher
-- scores against these too; the dashboard modal lets the user reorder/rename them.
CREATE TABLE IF NOT EXISTS food_aliases (
    id SERIAL PRIMARY KEY,
    food_id INTEGER REFERENCES foods(id) ON DELETE CASCADE,
    alias VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_food_aliases_unique ON food_aliases(food_id, lower(alias));

-- Store geolocation, learned from photo EXIF GPS.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS latitude DECIMAL(9,6);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS longitude DECIMAL(9,6);

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
-- Idempotent micronutrient upgrades (CREATE TABLE only runs on a fresh volume).
ALTER TABLE food_nutrition ADD COLUMN IF NOT EXISTS saturated_fat_g DECIMAL(10, 2);
ALTER TABLE food_nutrition ADD COLUMN IF NOT EXISTS trans_fat_g DECIMAL(10, 2);
ALTER TABLE food_nutrition ADD COLUMN IF NOT EXISTS cholesterol_mg DECIMAL(10, 2);
ALTER TABLE food_nutrition ADD COLUMN IF NOT EXISTS added_sugar_g DECIMAL(10, 2);
ALTER TABLE food_nutrition ADD COLUMN IF NOT EXISTS potassium_mg DECIMAL(10, 2);
ALTER TABLE food_nutrition ADD COLUMN IF NOT EXISTS calcium_mg DECIMAL(10, 2);
ALTER TABLE food_nutrition ADD COLUMN IF NOT EXISTS iron_mg DECIMAL(10, 2);
ALTER TABLE food_nutrition ADD COLUMN IF NOT EXISTS vitamin_a_mcg DECIMAL(10, 2);
ALTER TABLE food_nutrition ADD COLUMN IF NOT EXISTS vitamin_c_mg DECIMAL(10, 2);
ALTER TABLE food_nutrition ADD COLUMN IF NOT EXISTS vitamin_d_mcg DECIMAL(10, 2);

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
-- Idempotent micronutrient snapshot upgrades.
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS saturated_fat_g DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS trans_fat_g DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS cholesterol_mg DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS sodium_mg DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS fiber_g DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS sugar_g DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS added_sugar_g DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS potassium_mg DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS calcium_mg DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS iron_mg DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS vitamin_a_mcg DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS vitamin_c_mg DECIMAL(10, 2);
ALTER TABLE consumption_logs ADD COLUMN IF NOT EXISTS vitamin_d_mcg DECIMAL(10, 2);

-- Many-to-many associations. A price observation or a nutrition profile can be
-- shared across multiple foods (e.g. brand variants that share macros, or one
-- receipt line linked to several catalog items), and a food has many of each.
-- price_logs.food_id / food_nutrition.food_id remain as the "origin" owner
-- (audit + back-compat); these join tables are the authoritative food<->x links
-- for reads. Backfilled below from the origin columns.
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

-- Backfill the join tables from the origin owner columns (idempotent).
INSERT INTO food_prices (food_id, price_log_id)
    SELECT food_id, id FROM price_logs WHERE food_id IS NOT NULL
    ON CONFLICT DO NOTHING;
INSERT INTO food_macros (food_id, nutrition_id)
    SELECT food_id, id FROM food_nutrition WHERE food_id IS NOT NULL
    ON CONFLICT DO NOTHING;

-- Single-row daily targets (single-user app; id=1 always).
CREATE TABLE IF NOT EXISTS user_goals (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    daily_calories DECIMAL(10, 2) DEFAULT 2000,
    protein_g DECIMAL(10, 2),
    carbs_g DECIMAL(10, 2),
    fat_g DECIMAL(10, 2),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO user_goals (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Create indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_price_logs_food ON price_logs(food_id);
CREATE INDEX IF NOT EXISTS idx_price_logs_store ON price_logs(store_id);
CREATE INDEX IF NOT EXISTS idx_price_logs_scraped ON price_logs(scraped_at);

-- Insert Seed Data
INSERT INTO stores (name, location, logo_url) VALUES
('SuperMarket Central', 'Downtown', 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&q=80&w=200'),
('Organic Grocer', 'Westside', 'https://images.unsplash.com/photo-1578916171728-46686eac8d58?auto=format&fit=crop&q=80&w=200'),
('Value Foods', 'East End', 'https://images.unsplash.com/photo-1607344645866-009c320c5ab8?auto=format&fit=crop&q=80&w=200')
ON CONFLICT DO NOTHING;

INSERT INTO foods (name, barcode, description, category, unit) VALUES
('Organic Bananas', '000000001', 'Fresh organic bananas', 'Fruits', 'lb'),
('Whole Milk 1G', '000000002', 'Grade A Pasteurized Whole Milk', 'Dairy', 'gal'),
('Sourdough Bread', '000000003', 'Freshly baked sourdough bread loaf', 'Bakery', 'each'),
('Cage Free Brown Eggs Large 12ct', '000000004', 'One dozen cage-free brown eggs', 'Dairy', 'each'),
('Greek Yogurt Honey 32oz', '000000005', 'Strained honey-flavored Greek yogurt', 'Dairy', 'each')
ON CONFLICT DO NOTHING;

INSERT INTO price_logs (food_id, store_id, price, unit_price, is_sale) VALUES
(1, 1, 0.89, 0.89, false),
(1, 2, 1.19, 1.19, false),
(1, 3, 0.79, 0.79, true),
(2, 1, 3.49, 3.49, false),
(2, 2, 4.29, 4.29, false),
(2, 3, 2.99, 2.99, true),
(3, 1, 2.99, 2.99, false),
(3, 2, 3.99, 3.99, false),
(4, 1, 3.99, 3.99, false),
(4, 3, 3.49, 3.49, false),
(5, 2, 5.49, 5.49, false)
ON CONFLICT DO NOTHING;
