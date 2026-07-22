import express, { Request, Response } from 'express';
import cors from 'cors';
import { PoolClient } from 'pg';
import * as db from './db';
import { addScrapingJob, addCocowestScrapeJob, addOcrJob } from './queue';
import { computeUnitPrice } from './units';
import { scaleNutrients, NutritionFacts, NUTRIENT_FIELDS } from './nutrition';
import { summarizeMeal, validateIngredient, IngredientRow } from './meals';
import { chatJson, LlmError } from './llm';
import { searchFdc } from './fdc';
import { recordAudit } from './audit';
import multer from 'multer';
import exifr from 'exifr';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Shared volume where uploaded images are stored for background OCR processing.
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname) || '.jpg'}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
});

// Registers an uploaded file as an images row, extracting EXIF GPS when present.
// GPS failures are non-fatal — most screenshots/scans simply have no location.
// `originalImageId` links a cropped upload back to the full-res original it was
// derived from (the scanner's crop-before-OCR path); null for originals/non-crops.
// (Note: a canvas crop strips EXIF, so GPS must be read from the *original* upload.)
async function registerImage(
  file: Express.Multer.File,
  originalImageId: number | null = null
): Promise<{ id: number; latitude: number | null; longitude: number | null; original_image_id: number | null }> {
  let latitude: number | null = null;
  let longitude: number | null = null;
  try {
    const gps = await exifr.gps(file.path);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      latitude = gps.latitude;
      longitude = gps.longitude;
    }
  } catch { /* no EXIF or unreadable — fine */ }

  const result = await db.query(
    'INSERT INTO images (path, original_filename, latitude, longitude, original_image_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [file.path, file.originalname, latitude, longitude, originalImageId]
  );
  return { id: result.rows[0].id, latitude, longitude, original_image_id: originalImageId };
}

// Parses the optional `original_image_id` multipart field and confirms it points
// at an existing images row. Returns null when absent/blank; throws a 400-tagged
// error on a malformed id or one that references no image.
async function parseOriginalImageId(raw: unknown): Promise<number | null> {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = parseInt(String(raw), 10);
  if (!Number.isInteger(id) || id <= 0) {
    const e: any = new Error('original_image_id must be a positive integer');
    e.status = 400;
    throw e;
  }
  const exists = await db.query('SELECT 1 FROM images WHERE id = $1', [id]);
  if (exists.rows.length === 0) {
    const e: any = new Error('original_image_id does not reference a known image');
    e.status = 400;
    throw e;
  }
  return id;
}

app.use(cors());
app.use(express.json());

// 1. Health Check
app.get('/api/health', async (req: Request, res: Response) => {
  try {
    // Check database connection
    const dbCheck = await db.query('SELECT NOW()');
    
    res.json({
      status: 'healthy',
      timestamp: new Date(),
      database: dbCheck.rows.length > 0 ? 'connected' : 'error',
    });
  } catch (err: any) {
    res.status(500).json({
      status: 'unhealthy',
      error: err.message,
    });
  }
});

// (The old synchronous OCR proxy `POST /api/scan` was removed — all OCR now goes
// through the background queue path: POST /api/scan-jobs → /staging → the worker's
// multi-model pool → /inbox review. See CLAUDE.md "OCR ingestion".)

// 2. Get All Stores (excludes soft-deleted; those still resolve by id in
// history/receipt joins, they're just hidden from the pickers).
app.get('/api/stores', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM stores WHERE deleted_at IS NULL ORDER BY name ASC');
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Create Store
app.post('/api/stores', async (req: Request, res: Response) => {
  const { name, location, logo_url } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Store name is required' });
  }
  try {
    const result = await db.query(
      'INSERT INTO stores (name, location, logo_url) VALUES ($1, $2, $3) RETURNING *',
      [name, location || null, logo_url || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Is this price_logs row still a price you could actually pay today?
//
// A sale price stops being real the day the sale ends, so every read that
// surfaces a food's CURRENT price (the dashboard's latest_prices, the efficiency
// comparison, a meal ingredient's cost) must apply this on top of the usual
// `deleted_at IS NULL`. A non-sale price and a sale with no recorded end date
// never expire. Reads that show the PAST — the history table, the audit log —
// deliberately do NOT apply it: the sale genuinely happened and its record
// shouldn't vanish.
//
// Expects the price_logs table to be aliased `pl`. Defined once here because
// three separate queries depend on it agreeing; a drift means the dashboard
// quotes a price the store stopped honouring.
const ACTIVE_PRICE_SQL = `(pl.is_sale = false OR pl.sale_ends_at IS NULL OR pl.sale_ends_at >= CURRENT_DATE)`;

// The app-wide default sale length, used when a scan finds a sale price with no
// printed end date. Single row (id = 1), same bootstrap pattern as user_goals.
const DEFAULT_SALE_DAYS_FALLBACK = 7;
async function getDefaultSaleDays(client?: any): Promise<number> {
  const q = client ?? db;
  try {
    const r = await q.query('SELECT default_sale_days FROM app_settings WHERE id = 1');
    const days = r.rows[0]?.default_sale_days;
    return Number.isInteger(days) && days > 0 ? days : DEFAULT_SALE_DAYS_FALLBACK;
  } catch {
    // Settings row missing (fresh DB mid-migration) — don't fail a price write.
    return DEFAULT_SALE_DAYS_FALLBACK;
  }
}

// Resolve the sale end date for a price write. An explicit date from the caller
// always wins (the inbox lets the user override per item); a sale with no date
// falls back to today + the configured default, which is the whole point of that
// setting. A non-sale price never expires, so any date passed with it is dropped.
async function resolveSaleEndsAt(isSale: boolean, saleEndsAt: unknown, client?: any): Promise<string | null> {
  if (!isSale) return null;
  if (saleEndsAt) {
    const d = new Date(String(saleEndsAt));
    if (isNaN(d.getTime())) throw Object.assign(new Error('sale_ends_at must be a valid date (YYYY-MM-DD)'), { status: 400 });
    return String(saleEndsAt).slice(0, 10);
  }
  const days = await getDefaultSaleDays(client);
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// A food's dashboard icon: the user's explicit choice, falling back to the
// earliest non-deleted image attached to one of its linked price logs. Shared
// by GET /api/foods and GET /api/foods/:id so the fallback rule can't drift
// between the list and detail views.
const DISPLAY_IMAGE_ID_SQL = `
  COALESCE(
    f.image_id,
    (
      SELECT pl.image_id FROM price_logs pl
      JOIN food_prices fp2 ON fp2.price_log_id = pl.id
      WHERE fp2.food_id = f.id AND pl.image_id IS NOT NULL AND pl.deleted_at IS NULL
      ORDER BY pl.scraped_at ASC, pl.id ASC LIMIT 1
    )
  ) AS display_image_id
`;

// A food's tags (many-to-many via food_tags). Shared by the list read and the
// single-food read so both expose the same `tags` shape.
const FOOD_TAGS_SQL = `
  (
    SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name)
    FROM food_tags ft JOIN tags t ON t.id = ft.tag_id
    WHERE ft.food_id = f.id
  ) as tags
`;

// Appends the shared category/search predicates (used by both the row query
// and the count query in the paginated GET /api/foods branch) to keep them
// from drifting apart as filters are added.
// `deleted` selects the archive side of the catalog (the /audit page's Archived
// tab); by default archived foods are hidden from every catalog read.
function appendFoodFilters(base: string, params: any[], category: unknown, search: unknown, deleted?: unknown): string {
  base += deleted ? ' AND f.deleted_at IS NOT NULL' : ' AND f.deleted_at IS NULL';
  if (category) {
    params.push(category);
    base += ` AND f.category = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    base += ` AND (f.name ILIKE $${params.length} OR f.description ILIKE $${params.length} OR f.barcode ILIKE $${params.length})`;
  }
  return base;
}

// 4. Get All Foods (with latest prices)
app.get('/api/foods', async (req: Request, res: Response) => {
  const { category, search, deleted } = req.query;
  try {
    let queryText = `
      SELECT f.*,
        (
          SELECT json_agg(prices)
          FROM (
            SELECT pl.price, pl.unit_price, pl.amount, pl.amount_unit, pl.scraped_at, pl.is_sale, pl.sale_ends_at, s.name as store_name, s.id as store_id
            FROM price_logs pl
            JOIN food_prices fp ON fp.price_log_id = pl.id
            JOIN stores s ON pl.store_id = s.id
            WHERE fp.food_id = f.id AND pl.deleted_at IS NULL AND ${ACTIVE_PRICE_SQL}
            ORDER BY pl.scraped_at DESC
            LIMIT 3
          ) prices
        ) as latest_prices,
        (
          SELECT json_agg(json_build_object('id', fa.id, 'alias', fa.alias) ORDER BY fa.id)
          FROM food_aliases fa WHERE fa.food_id = f.id
        ) as aliases,
        ${FOOD_TAGS_SQL},
        (
          SELECT row_to_json(fn) FROM food_nutrition fn
          JOIN food_macros fm ON fm.nutrition_id = fn.id
          WHERE fm.food_id = f.id
          ORDER BY (fn.food_id = f.id) DESC, fn.id LIMIT 1
        ) as nutrition,
        ${DISPLAY_IMAGE_ID_SQL}
      FROM foods f
      WHERE 1=1
    `;
    const params: any[] = [];
    queryText = appendFoodFilters(queryText, params, category, search, deleted);

    queryText += ' ORDER BY f.name ASC';

    // limit absent -> legacy plain-array response (back-compat for callers
    // that need the full catalog: ReviewItems fuzzy-match, meals/diary pickers).
    const hasLimit = req.query.limit !== undefined;
    if (hasLimit) {
      const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit), 10) || 24));
      const offset = Math.max(0, parseInt(String(req.query.offset), 10) || 0);
      const pagedParams = [...params, limit, offset];
      const pagedQuery = queryText + ` LIMIT $${pagedParams.length - 1} OFFSET $${pagedParams.length}`;

      const countParams: any[] = [];
      const countQuery = appendFoodFilters('SELECT COUNT(*)::int AS count FROM foods f WHERE 1=1', countParams, category, search, deleted);

      const [rowsResult, countResult, categoriesResult] = await Promise.all([
        db.query(pagedQuery, pagedParams),
        db.query(countQuery, countParams),
        db.query(`SELECT DISTINCT category FROM foods WHERE category IS NOT NULL AND deleted_at IS NULL ORDER BY category`),
      ]);

      res.json({
        foods: rowsResult.rows,
        total: countResult.rows[0].count,
        categories: categoriesResult.rows.map((r: any) => r.category),
      });
      return;
    }

    const result = await db.query(queryText, params);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Create Food
app.post('/api/foods', async (req: Request, res: Response) => {
  const { name, barcode, description, category, unit, usable_pct, density } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Food name is required' });
  }
  // Usable-portion percent: optional, must be > 0 when supplied; defaults to 100.
  if (usable_pct !== undefined && usable_pct !== null && !(Number(usable_pct) > 0)) {
    return res.status(400).json({ error: 'usable_pct must be a positive number' });
  }
  // Density (kg/L) for per-volume foods: optional, must be > 0; defaults to 1.
  if (density !== undefined && density !== null && !(Number(density) > 0)) {
    return res.status(400).json({ error: 'density must be a positive number' });
  }
  try {
    const result = await db.query(
      'INSERT INTO foods (name, barcode, description, category, unit, usable_pct, density) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [name, barcode || null, description || null, category || 'Other', unit || 'each', usable_pct != null ? Number(usable_pct) : 100, density != null ? Number(density) : 1]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    // barcode is UNIQUE — a clashing scan should link to the existing food, not
    // create a duplicate. Return a clear 409 (not a raw 500) so the UI can say why.
    if (err.code === '23505') {
      return res.status(409).json({ error: `A food with barcode "${barcode}" already exists — link the price to it instead of creating a duplicate.` });
    }
    res.status(500).json({ error: err.message });
  }
});

// 5a. Bulk catalog audit actions (the /audit page). `archive` soft-deletes foods
// out of every catalog read (the scrapers log non-food — electronics, luggage —
// from Costco flyer posts); `restore` brings them back; `category` recategorizes.
// Not audited (audit_log revert only supports price_log) — archive/restore IS the
// recovery path, which is why this never hard-deletes.
app.post('/api/foods/bulk', async (req: Request, res: Response) => {
  const { ids, action, category } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const parsed = ids.map((n: any) => parseInt(n)).filter((n: number) => Number.isInteger(n));
  if (parsed.length === 0) return res.status(400).json({ error: 'ids must contain integers' });
  try {
    let result;
    if (action === 'archive') {
      result = await db.query(
        'UPDATE foods SET deleted_at = now() WHERE id = ANY($1::int[]) AND deleted_at IS NULL RETURNING id',
        [parsed]
      );
    } else if (action === 'restore') {
      result = await db.query(
        'UPDATE foods SET deleted_at = NULL WHERE id = ANY($1::int[]) AND deleted_at IS NOT NULL RETURNING id',
        [parsed]
      );
    } else if (action === 'category') {
      if (!category || !String(category).trim()) {
        return res.status(400).json({ error: 'category is required for action=category' });
      }
      result = await db.query(
        'UPDATE foods SET category = $2 WHERE id = ANY($1::int[]) RETURNING id',
        [parsed, String(category).trim()]
      );
    } else if (action === 'tag' || action === 'untag') {
      // Apply/remove the SAME tags across every selected food.
      const tagIds = Array.isArray(req.body.tag_ids)
        ? req.body.tag_ids.map((n: any) => parseInt(n)).filter((n: number) => Number.isInteger(n))
        : [];
      if (tagIds.length === 0) return res.status(400).json({ error: 'tag_ids must be a non-empty array' });
      if (action === 'tag') {
        result = await db.query(
          `INSERT INTO food_tags (food_id, tag_id)
           SELECT f, t FROM unnest($1::int[]) f CROSS JOIN unnest($2::int[]) t
           ON CONFLICT DO NOTHING RETURNING food_id AS id`,
          [parsed, tagIds]
        );
      } else {
        result = await db.query(
          'DELETE FROM food_tags WHERE food_id = ANY($1::int[]) AND tag_id = ANY($2::int[]) RETURNING food_id AS id',
          [parsed, tagIds]
        );
      }
    } else {
      return res.status(400).json({ error: "action must be 'archive', 'restore', 'category', 'tag' or 'untag'" });
    }
    res.json({ action, affected: result.rows.length, ids: result.rows.map((r: any) => r.id) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5a-2. Merge duplicate foods into one survivor (the /audit "merge 3 pork
// tenderloins into one" case). Repoints every reference from the source foods onto
// the target — price links, nutrition links, aliases, tags, meal ingredients and
// diary history — then soft-deletes the sources. Not audited (like /api/foods/bulk);
// the soft-deleted sources are the trace, though their data has moved to the survivor.
app.post('/api/foods/merge', async (req: Request, res: Response) => {
  const targetId = parseInt(req.body?.target_id);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'target_id is required' });
  const sourceIds = Array.isArray(req.body?.source_ids)
    ? req.body.source_ids.map((n: any) => parseInt(n)).filter((n: number) => Number.isInteger(n) && n !== targetId)
    : [];
  if (sourceIds.length === 0) return res.status(400).json({ error: 'source_ids must contain at least one other food' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query('SELECT id, name FROM foods WHERE id = $1', [targetId]);
    if (target.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'target food not found' }); }

    // Keep the survivor matching scans of the merged products: add each source's
    // primary name, then its aliases, as aliases of the target (deduped).
    await client.query(
      `INSERT INTO food_aliases (food_id, alias)
       SELECT $1, f.name FROM foods f WHERE f.id = ANY($2::int[])
       ON CONFLICT (food_id, lower(alias)) DO NOTHING`,
      [targetId, sourceIds]
    );
    await client.query(
      `INSERT INTO food_aliases (food_id, alias)
       SELECT $1, fa.alias FROM food_aliases fa WHERE fa.food_id = ANY($2::int[])
       ON CONFLICT (food_id, lower(alias)) DO NOTHING`,
      [targetId, sourceIds]
    );
    await client.query('DELETE FROM food_aliases WHERE food_id = ANY($1::int[])', [sourceIds]);

    // Price + nutrition links (M:N) and tags: union onto the target, drop source rows.
    await client.query(
      `INSERT INTO food_prices (food_id, price_log_id)
       SELECT $1, fp.price_log_id FROM food_prices fp WHERE fp.food_id = ANY($2::int[])
       ON CONFLICT DO NOTHING`,
      [targetId, sourceIds]
    );
    await client.query('DELETE FROM food_prices WHERE food_id = ANY($1::int[])', [sourceIds]);
    await client.query(
      `INSERT INTO food_macros (food_id, nutrition_id)
       SELECT $1, fm.nutrition_id FROM food_macros fm WHERE fm.food_id = ANY($2::int[])
       ON CONFLICT DO NOTHING`,
      [targetId, sourceIds]
    );
    await client.query('DELETE FROM food_macros WHERE food_id = ANY($1::int[])', [sourceIds]);
    await client.query(
      `INSERT INTO food_tags (food_id, tag_id)
       SELECT $1, ft.tag_id FROM food_tags ft WHERE ft.food_id = ANY($2::int[])
       ON CONFLICT DO NOTHING`,
      [targetId, sourceIds]
    );
    await client.query('DELETE FROM food_tags WHERE food_id = ANY($1::int[])', [sourceIds]);

    // Repoint recipe ingredients + diary history so they follow the survivor.
    await client.query('UPDATE meal_ingredients SET food_id = $1 WHERE food_id = ANY($2::int[])', [targetId, sourceIds]);
    await client.query('UPDATE consumption_logs SET food_id = $1 WHERE food_id = ANY($2::int[])', [targetId, sourceIds]);
    // Repoint the price_logs origin owner (audit-log join reads pl.food_id) so
    // history resolves to the survivor. food_nutrition.food_id is left as-is — it's
    // UNIQUE, and the profile is already linked to the target via food_macros above.
    await client.query('UPDATE price_logs SET food_id = $1 WHERE food_id = ANY($2::int[])', [targetId, sourceIds]);

    // Soft-delete the sources (never hard-delete a food — same convention as bulk archive).
    const archived = await client.query(
      'UPDATE foods SET deleted_at = now() WHERE id = ANY($1::int[]) AND deleted_at IS NULL RETURNING id',
      [sourceIds]
    );
    await client.query('COMMIT');
    const full = await db.query(SINGLE_FOOD_SQL, [targetId]);
    res.json({ target: full.rows[0], merged: archived.rows.length });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 5a-3. LLM duplicate-finder for /audit's "Find duplicates". Proposes clusters of
// foods that are really the same product; never merges (the user reviews each group,
// picks a survivor, and applies via POST /api/foods/merge — same human-in-the-loop
// rule as OCR / auto-tag / meal drafting). Uses MERGE_MODEL (falls back to MEAL_MODEL).
const MERGE_SUGGEST_MAX_FOODS = 60;
app.post('/api/foods/merge-suggestions', async (req: Request, res: Response) => {
  const foodIds = Array.isArray(req.body?.food_ids)
    ? req.body.food_ids.map((n: any) => parseInt(n)).filter((n: number) => Number.isInteger(n))
    : [];
  if (foodIds.length === 0) return res.status(400).json({ error: 'food_ids must be a non-empty array' });
  if (foodIds.length > MERGE_SUGGEST_MAX_FOODS) {
    return res.status(400).json({ error: `Send at most ${MERGE_SUGGEST_MAX_FOODS} foods per duplicate-scan batch (got ${foodIds.length}).` });
  }
  try {
    const foods = await db.query(
      'SELECT id, name, category, barcode FROM foods WHERE id = ANY($1::int[]) AND deleted_at IS NULL',
      [foodIds]
    );
    if (foods.rows.length < 2) return res.json({ groups: [], model: process.env.MERGE_MODEL || process.env.MEAL_MODEL || null });

    const system = [
      'You find duplicate grocery-catalog items — different rows that are really the SAME product.',
      'You are given ITEMS (id + name + category + barcode).',
      'Group ids that refer to the same underlying product, ignoring brand/store/size wording, packaging, or minor spelling.',
      'Only group items you are confident are the same product. A group needs at least two ids. Most items belong to no group.',
      'Never put an id in more than one group. Only use ids from the list, copied exactly.',
      'Respond ONLY with JSON: {"groups":[{"food_ids":[<id>,...],"reason":"<short why>"}]}',
    ].join(' ');
    const user = JSON.stringify({ items: foods.rows.map((f: any) => ({ id: f.id, name: f.name, category: f.category, barcode: f.barcode })) });

    const raw = await chatJson(system, user, process.env.MERGE_MODEL);

    // Validate hard: keep only known ids, no id in two groups, groups of ≥2.
    const known = new Set<number>(foods.rows.map((f: any) => f.id));
    const nameById = new Map<number, string>(foods.rows.map((f: any) => [f.id, f.name]));
    const seen = new Set<number>();
    const groups: { food_ids: number[]; foods: { id: number; name: string }[]; reason: string | null }[] = [];
    for (const g of Array.isArray(raw?.groups) ? raw.groups : []) {
      const ids: number[] = [];
      for (const x of Array.isArray(g?.food_ids) ? g.food_ids : []) {
        const id = parseInt(x);
        if (known.has(id) && !seen.has(id) && ids.indexOf(id) === -1) ids.push(id);
      }
      if (ids.length < 2) continue;
      for (const id of ids) seen.add(id);
      groups.push({
        food_ids: ids,
        foods: ids.map((id) => ({ id, name: nameById.get(id)! })),
        reason: typeof g?.reason === 'string' ? g.reason : null,
      });
    }
    res.json({ groups, model: process.env.MERGE_MODEL || process.env.MEAL_MODEL || null });
  } catch (err: any) {
    if (err instanceof LlmError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Tags (many-to-many labels on foods; managed from /audit) ─────────────────

// 5b. List tags with how many (non-archived) foods carry each.
app.get('/api/tags', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT t.id, t.name,
              (SELECT COUNT(*)::int FROM food_tags ft
               JOIN foods f ON f.id = ft.food_id
               WHERE ft.tag_id = t.id AND f.deleted_at IS NULL) AS food_count
       FROM tags t ORDER BY t.name`
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5c. Create a tag. Idempotent by (case-insensitive) name — re-creating an
// existing tag returns it rather than 409-ing, so the inline "new tag" box in
// the audit UI can't fail on a duplicate.
app.post('/api/tags', async (req: Request, res: Response) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 60) return res.status(400).json({ error: 'name must be 60 characters or fewer' });
  try {
    const existing = await db.query('SELECT id, name FROM tags WHERE lower(name) = lower($1)', [name]);
    if (existing.rows.length > 0) return res.status(200).json({ ...existing.rows[0], food_count: 0, existed: true });
    const result = await db.query('INSERT INTO tags (name) VALUES ($1) RETURNING id, name', [name]);
    res.status(201).json({ ...result.rows[0], food_count: 0 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5d. Delete a tag (its food_tags links cascade).
app.delete('/api/tags/:id', async (req: Request, res: Response) => {
  try {
    const result = await db.query('DELETE FROM tags WHERE id = $1 RETURNING id', [parseInt(req.params.id)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'tag not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5e. Apply per-food tag assignments (what the /audit page calls to commit a
// reviewed auto-tag draft). Unlike bulk tag/untag, each food gets its own set.
app.post('/api/foods/apply-tags', async (req: Request, res: Response) => {
  const assignments = req.body?.assignments;
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return res.status(400).json({ error: 'assignments must be a non-empty array' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    let linked = 0;
    for (const a of assignments) {
      const foodId = parseInt(a?.food_id);
      const tagIds = Array.isArray(a?.tag_ids)
        ? a.tag_ids.map((n: any) => parseInt(n)).filter((n: number) => Number.isInteger(n))
        : [];
      if (!Number.isInteger(foodId) || tagIds.length === 0) continue;
      const r = await client.query(
        `INSERT INTO food_tags (food_id, tag_id)
         SELECT $1, t FROM unnest($2::int[]) t ON CONFLICT DO NOTHING RETURNING tag_id`,
        [foodId, tagIds]
      );
      linked += r.rows.length;
    }
    await client.query('COMMIT');
    res.json({ linked });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 5f. AI auto-tagger: ask an LLM which of the CHOSEN tags fit each of the
// CHOSEN foods. Returns an **unsaved draft** — the user reviews it on /audit and
// applies via POST /api/foods/apply-tags. Same human-in-the-loop rule as OCR and
// AI meal drafting: the model never writes to the catalog.
// Capped because free models have small contexts and get flaky on long lists.
const AUTO_TAG_MAX_FOODS = 50;
app.post('/api/foods/auto-tag', async (req: Request, res: Response) => {
  const foodIds = Array.isArray(req.body?.food_ids)
    ? req.body.food_ids.map((n: any) => parseInt(n)).filter((n: number) => Number.isInteger(n))
    : [];
  const tagIds = Array.isArray(req.body?.tag_ids)
    ? req.body.tag_ids.map((n: any) => parseInt(n)).filter((n: number) => Number.isInteger(n))
    : [];
  if (foodIds.length === 0) return res.status(400).json({ error: 'food_ids must be a non-empty array' });
  if (tagIds.length === 0) return res.status(400).json({ error: 'tag_ids must be a non-empty array' });
  if (foodIds.length > AUTO_TAG_MAX_FOODS) {
    return res.status(400).json({ error: `Select at most ${AUTO_TAG_MAX_FOODS} items per auto-tag run (got ${foodIds.length}).` });
  }
  try {
    const [foods, tags] = await Promise.all([
      db.query('SELECT id, name, category FROM foods WHERE id = ANY($1::int[])', [foodIds]),
      db.query('SELECT id, name FROM tags WHERE id = ANY($1::int[])', [tagIds]),
    ]);
    if (foods.rows.length === 0) return res.status(400).json({ error: 'no matching foods' });
    if (tags.rows.length === 0) return res.status(400).json({ error: 'no matching tags' });

    const tagNames: string[] = tags.rows.map((t: any) => t.name);
    const system = [
      'You label grocery-catalog items with tags.',
      'You are given a list of ITEMS (id + name + category) and a list of allowed TAGS.',
      'For each item, choose every tag from the allowed list that applies. An item may get zero, one, or many tags.',
      'Only ever use tags from the allowed list, copied exactly. Never invent tags.',
      'Respond ONLY with JSON: {"assignments":[{"id":<item id>,"tags":["<tag>",...]}]}',
      'Include an entry for every item, using an empty array when no tag applies.',
    ].join(' ');
    const user = JSON.stringify({
      allowed_tags: tagNames,
      hint: typeof req.body?.hint === 'string' ? req.body.hint.slice(0, 400) : undefined,
      items: foods.rows.map((f: any) => ({ id: f.id, name: f.name, category: f.category })),
    });

    let usedModel: string | null = null;
    const raw = await chatJson(system, user, process.env.TAG_MODEL, (m) => { usedModel = m; });

    // Validate hard: keep only known food ids and map tag names back to ids,
    // dropping anything the model invented.
    const byName = new Map<string, number>();
    for (const t of tags.rows) byName.set(String(t.name).toLowerCase(), t.id);
    const knownFood = new Map<number, string>();
    for (const f of foods.rows) knownFood.set(f.id, f.name);

    const suggestions: { food_id: number; food_name: string; tag_ids: number[] }[] = [];
    for (const a of Array.isArray(raw?.assignments) ? raw.assignments : []) {
      const fid = parseInt(a?.id);
      if (!knownFood.has(fid)) continue;
      const ids: number[] = [];
      for (const n of Array.isArray(a?.tags) ? a.tags : []) {
        const tid = byName.get(String(n).trim().toLowerCase());
        if (tid !== undefined && ids.indexOf(tid) === -1) ids.push(tid);
      }
      suggestions.push({ food_id: fid, food_name: knownFood.get(fid)!, tag_ids: ids });
    }
    res.json({ suggestions, model: usedModel });
  } catch (err: any) {
    if (err instanceof LlmError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Single food with its aliases + nutrition + display image — the shape every
// food read returns. Reused by GET /api/foods/:id and POST /api/foods/from-nutrition.
const SINGLE_FOOD_SQL = `
  SELECT f.*,
    (SELECT json_agg(json_build_object('id', fa.id, 'alias', fa.alias) ORDER BY fa.id)
     FROM food_aliases fa WHERE fa.food_id = f.id) as aliases,
    ${FOOD_TAGS_SQL},
    (SELECT row_to_json(n) FROM (
       SELECT fn.*,
         (SELECT COUNT(*)::int FROM food_macros fm2 WHERE fm2.nutrition_id = fn.id) AS shared_food_count
       FROM food_nutrition fn
       JOIN food_macros fm ON fm.nutrition_id = fn.id
       WHERE fm.food_id = f.id
       ORDER BY (fn.food_id = f.id) DESC, fn.id LIMIT 1
     ) n) as nutrition,
    ${DISPLAY_IMAGE_ID_SQL}
  FROM foods f WHERE f.id = $1`;

// 5b. Get a single food with its aliases + nutrition (same shape as the list).
app.get('/api/foods/:id', async (req: Request, res: Response) => {
  try {
    const result = await db.query(SINGLE_FOOD_SQL, [parseInt(req.params.id)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Food not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5c. Link/unlink an existing price log to a food (many-to-many). The price
// log keeps its origin owner; this adds/removes an additional association.
app.post('/api/foods/:id/prices/:priceLogId/link', async (req: Request, res: Response) => {
  try {
    await db.query(
      'INSERT INTO food_prices (food_id, price_log_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [parseInt(req.params.id), parseInt(req.params.priceLogId)]
    );
    res.status(201).json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/foods/:id/prices/:priceLogId/link', async (req: Request, res: Response) => {
  try {
    await db.query(
      'DELETE FROM food_prices WHERE food_id = $1 AND price_log_id = $2',
      [parseInt(req.params.id), parseInt(req.params.priceLogId)]
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5d. Link/unlink an existing nutrition profile to a food (many-to-many).
app.post('/api/foods/:id/macros/:nutritionId/link', async (req: Request, res: Response) => {
  try {
    await db.query(
      'INSERT INTO food_macros (food_id, nutrition_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [parseInt(req.params.id), parseInt(req.params.nutritionId)]
    );
    res.status(201).json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/foods/:id/macros/:nutritionId/link', async (req: Request, res: Response) => {
  try {
    await db.query(
      'DELETE FROM food_macros WHERE food_id = $1 AND nutrition_id = $2',
      [parseInt(req.params.id), parseInt(req.params.nutritionId)]
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get Food Price Logs
app.get('/api/foods/:id/prices', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT pl.*, s.name as store_name
       FROM price_logs pl
       JOIN food_prices fp ON fp.price_log_id = pl.id
       JOIN stores s ON pl.store_id = s.id
       WHERE fp.food_id = $1 AND pl.deleted_at IS NULL
       ORDER BY pl.scraped_at DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6b. Add Food Price Log manually (e.g. from OCR scanner)
app.post('/api/foods/:id/prices', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { store_id, price, is_sale, amount, amount_unit, source, image_id, sale_ends_at } = req.body;
  if (!store_id || price === undefined) {
    return res.status(400).json({ error: 'store_id and price are required' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Normalize to a price per base unit (per gram / ml / each) when the caller
    // supplies an amount + recognizable unit; otherwise leave unit_price null.
    const normalized = computeUnitPrice(Number(price), amount, amount_unit);
    // A sale with no end date gets the configured default, so it expires on its
    // own instead of being quoted forever (see resolveSaleEndsAt).
    const saleEndsAt = await resolveSaleEndsAt(!!is_sale, sale_ends_at, client);
    const result = await client.query(
      `INSERT INTO price_logs (food_id, store_id, price, amount, amount_unit, unit_price, is_sale, source, image_id, sale_ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        parseInt(id),
        parseInt(store_id),
        price,
        amount ?? null,
        amount_unit ?? null,
        normalized ? normalized.unitPrice : null,
        is_sale || false,
        source || 'manual',
        image_id ?? null,
        saleEndsAt,
      ]
    );
    const row = result.rows[0];
    // Link the new price to this food in the many-to-many table (origin owner).
    await client.query(
      'INSERT INTO food_prices (food_id, price_log_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [parseInt(id), row.id]
    );
    await recordAudit(client, { entityId: row.id, action: 'create', after: row });
    await client.query('COMMIT');
    res.status(201).json(row);
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 7. Manually Trigger a Flipp Flyer Scrape for a Store
// Body: { postal_code?, query? }. postal_code falls back to FLIPP_POSTAL_CODE
// (root .env). query narrows the scrape to one flyer search; without it the
// worker matches the whole food catalog against the store's current flyers.
// The store's name must resemble the Flipp merchant name (e.g. "Walmart").
app.post('/api/scrape/:storeId', async (req: Request, res: Response) => {
  const { storeId } = req.params;
  const { postal_code, query } = req.body || {};

  try {
    // Check if store exists
    const storeResult = await db.query('SELECT * FROM stores WHERE id = $1', [storeId]);
    if (storeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Store not found' });
    }

    const postal = String(postal_code || process.env.FLIPP_POSTAL_CODE || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(postal)) {
      return res.status(400).json({
        error: 'A Canadian postal code is required (postal_code in the body, or FLIPP_POSTAL_CODE in .env), e.g. V5A3J2',
      });
    }

    const storeName = storeResult.rows[0].name;
    const trimmedQuery = typeof query === 'string' && query.trim() ? query.trim() : undefined;

    // Track this scrape so the UI can show live progress. The worker updates this
    // row (phase/counters/items) as it runs; its id rides along on the queue job.
    const scrapeJob = await db.query(
      `INSERT INTO scrape_jobs (store_id, store_name, postal_code, query, status, phase)
       VALUES ($1, $2, $3, $4, 'queued', 'Queued') RETURNING id`,
      [parseInt(storeId), storeName, postal, trimmedQuery ?? null]
    );
    const scrapeJobId = scrapeJob.rows[0].id;
    const job = await addScrapingJob(scrapeJobId, parseInt(storeId), storeName, postal, trimmedQuery);

    res.json({
      message: `Flipp flyer scrape queued for store ${storeName}`,
      jobId: job.id,
      scrapeJobId,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7a. Manually Trigger a cocowest.ca Costco Sale-Post Scrape for a Store
// Body: { store_id, url }. url must be a cocowest.ca post — the whole post is
// treated as one store's current sale list (no postal/merchant targeting, unlike
// Flipp). Logs a price for every parseable item, creating foods (category
// 'Costco') for anything not already in the catalog.
app.post('/api/scrape-cocowest', async (req: Request, res: Response) => {
  const { store_id, url } = req.body || {};

  try {
    if (!store_id) {
      return res.status(400).json({ error: 'store_id is required' });
    }
    const trimmedUrl = typeof url === 'string' ? url.trim() : '';
    if (!/^https?:\/\/([a-z0-9-]+\.)*cocowest\.ca\//i.test(trimmedUrl)) {
      return res.status(400).json({ error: 'A cocowest.ca post URL is required' });
    }

    const storeResult = await db.query('SELECT * FROM stores WHERE id = $1', [store_id]);
    if (storeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Store not found' });
    }
    const storeName = storeResult.rows[0].name;

    const scrapeJob = await db.query(
      `INSERT INTO scrape_jobs (store_id, store_name, source, source_url, status, phase)
       VALUES ($1, $2, 'cocowest', $3, 'queued', 'Queued') RETURNING id`,
      [parseInt(store_id), storeName, trimmedUrl]
    );
    const scrapeJobId = scrapeJob.rows[0].id;
    const job = await addCocowestScrapeJob(scrapeJobId, parseInt(store_id), storeName, trimmedUrl);

    res.json({
      message: `cocowest scrape queued for store ${storeName}`,
      jobId: job.id,
      scrapeJobId,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7b. List scrape jobs (progress dashboard). Compact — no per-item detail.
app.get('/api/scrape-jobs', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT id, store_id, store_name, source, source_url, postal_code, query, status, phase,
              total, processed, logged, error, created_at, updated_at, finished_at,
              jsonb_array_length(items) AS item_count
       FROM scrape_jobs
       ORDER BY created_at DESC
       LIMIT 50`
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7c. One scrape job with its full per-item detail (saved flyer images + links).
app.get('/api/scrape-jobs/:id', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM scrape_jobs WHERE id = $1', [parseInt(req.params.id)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Scrape job not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Price Efficiency/Discrepancy Metrics
// Highlights foods with the largest price spread between stores
app.get('/api/prices/efficiency', async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      WITH latest_prices AS (
        SELECT DISTINCT ON (pl.food_id, pl.store_id)
          pl.food_id,
          pl.store_id,
          pl.price,
          s.name as store_name
        FROM price_logs pl
        JOIN stores s ON pl.store_id = s.id
        WHERE pl.deleted_at IS NULL AND ${ACTIVE_PRICE_SQL}
        ORDER BY pl.food_id, pl.store_id, pl.scraped_at DESC
      ),
      spreads AS (
        SELECT 
          food_id,
          MIN(price) as min_price,
          MAX(price) as max_price,
          AVG(price) as avg_price,
          (MAX(price) - MIN(price)) as spread,
          CASE 
            WHEN MIN(price) > 0 THEN ((MAX(price) - MIN(price)) / MIN(price)) * 100
            ELSE 0
          END as savings_percent
        FROM latest_prices
        GROUP BY food_id
        HAVING COUNT(store_id) > 1
      )
      SELECT 
        s.*, 
        f.name as food_name,
        f.category,
        f.unit,
        (
          SELECT store_name FROM latest_prices 
          WHERE food_id = s.food_id AND price = s.min_price LIMIT 1
        ) as best_store,
        (
          SELECT store_name FROM latest_prices 
          WHERE food_id = s.food_id AND price = s.max_price LIMIT 1
        ) as worst_store
      FROM spreads s
      JOIN foods f ON s.food_id = f.id
      WHERE f.deleted_at IS NULL
      ORDER BY savings_percent DESC;
    `);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Price-log history, edit/delete, audit & revert ─────────────────────────

// Columns a client may edit on a price log.
// `sale_ends_at` is deliberately NOT here — it's derived by resolveSaleEndsAt in
// the update handler so it can't be left contradicting is_sale.
const EDITABLE_PRICE_FIELDS = ['store_id', 'price', 'amount', 'amount_unit', 'is_sale', 'scraped_at'] as const;

// 9. List all price logs (history), joined to food + store names.
app.get('/api/price-logs', async (req: Request, res: Response) => {
  const { food_id, store_id, include_deleted } = req.query;
  try {
    const params: any[] = [];
    let where = 'WHERE 1=1';
    if (!include_deleted || include_deleted === 'false') {
      where += ' AND pl.deleted_at IS NULL';
    }
    if (food_id) {
      params.push(parseInt(food_id as string));
      where += ` AND pl.food_id = $${params.length}`;
    }
    if (store_id) {
      params.push(parseInt(store_id as string));
      where += ` AND pl.store_id = $${params.length}`;
    }
    const result = await db.query(
      `SELECT pl.*, f.name AS food_name, f.category, s.name AS store_name
       FROM price_logs pl
       JOIN foods f ON pl.food_id = f.id
       LEFT JOIN stores s ON pl.store_id = s.id
       ${where}
       ORDER BY pl.scraped_at DESC, pl.id DESC`,
      params
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Update a price log (audited).
app.put('/api/price-logs/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM price_logs WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Price log not found' });
    }
    const before = existing.rows[0];

    // Merge only the editable fields the caller provided.
    const next: any = { ...before };
    for (const field of EDITABLE_PRICE_FIELDS) {
      if (req.body[field] !== undefined) next[field] = req.body[field];
    }
    // Recompute unit_price from the (possibly changed) price/amount.
    const normalized = computeUnitPrice(Number(next.price), next.amount, next.amount_unit);
    next.unit_price = normalized ? normalized.unitPrice : null;
    // Keep the sale/expiry pair coherent: clearing is_sale drops the end date,
    // and turning is_sale ON without one applies the configured default. An
    // explicitly-sent sale_ends_at (including via the edit form) always wins.
    next.sale_ends_at = await resolveSaleEndsAt(
      !!next.is_sale,
      req.body.sale_ends_at !== undefined ? req.body.sale_ends_at : before.sale_ends_at,
      client
    );

    const updated = await client.query(
      `UPDATE price_logs
       SET store_id = $1, price = $2, amount = $3, amount_unit = $4,
           unit_price = $5, is_sale = $6, scraped_at = $7, sale_ends_at = $8
       WHERE id = $9 RETURNING *`,
      [next.store_id, next.price, next.amount ?? null, next.amount_unit ?? null,
       next.unit_price, next.is_sale, next.scraped_at, next.sale_ends_at, id]
    );
    const after = updated.rows[0];
    await recordAudit(client, { entityId: id, action: 'update', before, after });
    await client.query('COMMIT');
    res.json(after);
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 11. Soft-delete a price log (audited).
app.delete('/api/price-logs/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM price_logs WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Price log not found' });
    }
    const before = existing.rows[0];
    if (before.deleted_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Price log is already deleted' });
    }
    await client.query('UPDATE price_logs SET deleted_at = now() WHERE id = $1', [id]);
    await recordAudit(client, { entityId: id, action: 'delete', before });
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 12. Audit-log feed (change history).
app.get('/api/audit-log', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT a.*, f.name AS food_name
       FROM audit_log a
       LEFT JOIN price_logs pl ON a.entity_id = pl.id AND a.entity_type = 'price_log'
       LEFT JOIN foods f ON pl.food_id = f.id
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 200`
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Revert a specific change; records the revert as a new audit entry.
app.post('/api/audit-log/:id/revert', async (req: Request, res: Response) => {
  const auditId = parseInt(req.params.id);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const auditRes = await client.query('SELECT * FROM audit_log WHERE id = $1 FOR UPDATE', [auditId]);
    if (auditRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Audit entry not found' });
    }
    const entry = auditRes.rows[0];
    if (entry.reverted_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This change has already been reverted' });
    }
    // This handler applies snapshots to the price_logs table; entity ids from
    // other audited tables (e.g. consumption_log) must not be applied to it.
    if (entry.entity_type !== 'price_log') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Revert is not supported for '${entry.entity_type}' entries` });
    }

    const rowRes = await client.query('SELECT * FROM price_logs WHERE id = $1 FOR UPDATE', [entry.entity_id]);
    if (rowRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Target price log no longer exists' });
    }
    const current = rowRes.rows[0];
    let after = current;

    if (entry.action === 'update') {
      // Restore the pre-update snapshot.
      const b = entry.before_data;
      // sale_ends_at is restored from the snapshot like every other field; a
      // snapshot taken before the column existed reverts it to NULL (no expiry),
      // which matches how those rows already behave.
      const upd = await client.query(
        `UPDATE price_logs
         SET store_id = $1, price = $2, amount = $3, amount_unit = $4,
             unit_price = $5, is_sale = $6, scraped_at = $7, deleted_at = $8, sale_ends_at = $9
         WHERE id = $10 RETURNING *`,
        [b.store_id, b.price, b.amount ?? null, b.amount_unit ?? null,
         b.unit_price ?? null, b.is_sale, b.scraped_at, b.deleted_at ?? null,
         b.sale_ends_at ?? null, entry.entity_id]
      );
      after = upd.rows[0];
    } else if (entry.action === 'delete') {
      const upd = await client.query(
        'UPDATE price_logs SET deleted_at = NULL WHERE id = $1 RETURNING *', [entry.entity_id]);
      after = upd.rows[0];
    } else if (entry.action === 'create') {
      const upd = await client.query(
        'UPDATE price_logs SET deleted_at = now() WHERE id = $1 RETURNING *', [entry.entity_id]);
      after = upd.rows[0];
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot revert a '${entry.action}' entry` });
    }

    await client.query('UPDATE audit_log SET reverted_at = now() WHERE id = $1', [auditId]);
    await recordAudit(client, {
      entityId: entry.entity_id,
      action: 'revert',
      before: current,
      after,
      note: `Reverted change #${auditId} (${entry.action})`,
    });
    await client.query('COMMIT');
    res.json({ success: true, entity: after });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── Background OCR scan jobs (inbox) ───────────────────────────────────────

// 14. Upload one or more images for background processing.
app.post('/api/scan-jobs', upload.array('images', 20), async (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No images uploaded (field name: images)' });
  }
  const storeId = req.body.store_id ? parseInt(req.body.store_id) : null;
  try {
    const created: any[] = [];
    for (const file of files) {
      // Stage each upload as its full-res original — cropping happens later on the
      // /staging page (PUT /api/scan-jobs/:id/image). Staged jobs are NOT enqueued
      // for OCR until the user sends them for processing (POST /api/scan-jobs/process).
      const image = await registerImage(file);
      const insert = await db.query(
        `INSERT INTO scan_jobs (status, image_path, original_filename, store_id, image_id)
         VALUES ('staged', $1, $2, $3, $4) RETURNING *`,
        [file.path, file.originalname, storeId, image.id]
      );
      const row = insert.rows[0];
      created.push({ id: row.id, status: row.status, original_filename: row.original_filename });
    }
    res.status(201).json({ jobs: created });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 15. List scan jobs (inbox).
app.get('/api/scan-jobs', async (req: Request, res: Response) => {
  const { status } = req.query;
  try {
    const params: any[] = [];
    // Staged jobs live on the /staging page (crop-before-processing), not the
    // inbox — exclude them from the default view; ?status=staged still returns them.
    let where = "WHERE status NOT IN ('discarded', 'staged')";
    if (status) {
      params.push(status);
      where = `WHERE status = $${params.length}`;
    }
    const result = await db.query(
      `SELECT j.id, j.status, j.original_filename, j.store_id, s.name AS store_name,
              j.image_id, j.error, j.created_at, j.processed_at,
              CASE WHEN j.result IS NULL THEN NULL ELSE j.result->>'type' END AS result_type,
              CASE
                WHEN j.result IS NULL THEN 0
                -- Composite scans carry captures[] (one entry per region found —
                -- a mixed photo's receipt AND price_tag regions both count).
                -- Mirrors worker.ts captureItemCount; keep the two in sync.
                WHEN jsonb_typeof(j.result->'captures') = 'array' AND jsonb_array_length(j.result->'captures') > 0 THEN (
                  SELECT COALESCE(SUM(
                    CASE
                      WHEN jsonb_typeof(cap->'data'->'items') = 'array' THEN jsonb_array_length(cap->'data'->'items')
                      WHEN cap->>'type' = 'price_tag' AND (cap->'data'->>'name') IS NOT NULL THEN 1
                      ELSE 0
                    END
                  ), 0)
                  FROM jsonb_array_elements(j.result->'captures') AS cap
                )
                -- Rows written before captures[] existed: fall back to the
                -- single-type shape.
                WHEN j.result->>'type' = 'receipt' THEN jsonb_array_length(COALESCE(j.result->'data'->'items', '[]'::jsonb))
                -- price_tag now carries items[] (several tags per photo); rows
                -- written before that hold ONE flat tag, which still counts as 1.
                WHEN j.result->>'type' = 'price_tag' THEN
                  CASE WHEN jsonb_typeof(j.result->'data'->'items') = 'array'
                       THEN jsonb_array_length(j.result->'data'->'items')
                       ELSE 1 END
                WHEN j.result->>'type' = 'barcode' THEN jsonb_array_length(COALESCE(j.result->'data'->'items', '[]'::jsonb))
                ELSE 0
              END AS item_count
       FROM scan_jobs j
       LEFT JOIN stores s ON j.store_id = s.id
       ${where}
       ORDER BY j.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 16. Full scan job detail (with the raw OCR result + image GPS for review).
// `original_image_id` is the full-res upload this job's image was cropped from
// (NULL when it was never cropped) — the inbox shows both side by side so a bad
// crop is obvious. `j.*` also carries `attempts`, the per-model OCR trace.
app.get('/api/scan-jobs/:id', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT j.*, i.latitude, i.longitude, i.original_image_id
       FROM scan_jobs j LEFT JOIN images i ON j.image_id = i.id
       WHERE j.id = $1`,
      [parseInt(req.params.id)]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Scan job not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 16b. Full per-model call history for a scan job — every scan_runs row, newest
// first. Unlike `result`/`attempts` on the job itself (overwritten on every run,
// cleared on restage), this never shrinks: it's what shows "gemma read this fine
// three weeks ago under the old prompt" even after a re-crop or a re-run.
app.get('/api/scan-jobs/:id/runs', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT id, image_id, model, use_paid, prompt_version, tags_vocab, ok, was_winner,
              capture_type, item_count, confidence, raw_text, error, duration_ms,
              started_at, created_at
       FROM scan_runs WHERE scan_job_id = $1 ORDER BY started_at DESC`,
      [parseInt(req.params.id)]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 17. Mark a scan job reviewed (called after the user commits its items).
app.post('/api/scan-jobs/:id/reviewed', async (req: Request, res: Response) => {
  try {
    await db.query("UPDATE scan_jobs SET status = 'reviewed' WHERE id = $1", [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 18. Re-queue a failed job.
app.post('/api/scan-jobs/:id/retry', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  try {
    const job = await db.query('SELECT * FROM scan_jobs WHERE id = $1', [id]);
    if (job.rows.length === 0) return res.status(404).json({ error: 'Scan job not found' });
    await db.query("UPDATE scan_jobs SET status = 'queued', error = NULL WHERE id = $1", [id]);
    await addOcrJob(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 18b. Re-run OCR on a job's CURRENT image without touching its state otherwise
// — unlike /restage (which reverts to the original image for a re-crop) or
// /retry (failed jobs only), this is "the prompt/model pool just changed, redo
// this scan and see if it does better." Appends a fresh scan_runs history on
// top of whatever's already there; result/attempts get overwritten with the new
// outcome same as any run, but nothing is destroyed — see scan_runs above.
app.post('/api/scan-jobs/:id/reprocess', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const usePaid = req.body?.use_paid === true || req.body?.use_paid === 'true';
  try {
    const job = await db.query('SELECT status, use_paid FROM scan_jobs WHERE id = $1', [id]);
    if (job.rows.length === 0) return res.status(404).json({ error: 'Scan job not found' });
    if (['staged', 'queued', 'processing'].includes(job.rows[0].status)) {
      return res.status(400).json({ error: `Job is ${job.rows[0].status} — nothing to reprocess yet` });
    }
    const nextUsePaid = req.body?.use_paid != null ? usePaid : job.rows[0].use_paid;
    await db.query("UPDATE scan_jobs SET status = 'queued', use_paid = $2, error = NULL WHERE id = $1", [id, nextUsePaid]);
    await addOcrJob(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 19. Discard a scan job (and delete its image file).
app.delete('/api/scan-jobs/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  try {
    const job = await db.query('SELECT image_path FROM scan_jobs WHERE id = $1', [id]);
    if (job.rows.length > 0 && job.rows[0].image_path) {
      fs.promises.unlink(job.rows[0].image_path).catch(() => {});
    }
    await db.query("UPDATE scan_jobs SET status = 'discarded' WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 19a. Send a processed job BACK to /staging so it can be re-cropped and re-run.
// This is the recovery path for a bad crop: OCR read the wrong region and the
// inbox result is unusable. Resetting the OCR state (result/attempts/error) and
// repointing the job at the crop's ORIGINAL means the user re-crops the full
// photo rather than tightening an already-bad crop. The superseded crop's
// `images` row is deliberately left in place — images are shared/immutable
// elsewhere (scrapes, scans, icons), so orphans are an accepted tradeoff.
app.post('/api/scan-jobs/:id/restage', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  try {
    const cur = await db.query(
      `SELECT sj.status, sj.image_id, i.original_image_id, o.id AS orig_id, o.path AS orig_path
       FROM scan_jobs sj
       LEFT JOIN images i ON i.id = sj.image_id
       LEFT JOIN images o ON o.id = i.original_image_id
       WHERE sj.id = $1`,
      [id]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Scan job not found' });
    const row = cur.rows[0];
    if (row.status === 'staged') return res.status(400).json({ error: 'Job is already staged' });
    if (row.status === 'discarded') return res.status(400).json({ error: 'Discarded jobs cannot be re-staged' });
    if (row.status === 'queued' || row.status === 'processing') {
      return res.status(400).json({ error: 'Job is still processing — wait for it to finish' });
    }
    // Revert to the uncropped original when this job's image is a crop; a job
    // that was never cropped just goes back as-is for a first crop.
    const revertToOriginal = row.orig_id != null && row.orig_path != null;
    const upd = await db.query(
      `UPDATE scan_jobs
       SET status = 'staged', result = NULL, attempts = NULL, error = NULL, processed_at = NULL,
           image_id = COALESCE($2, image_id), image_path = COALESCE($3, image_path)
       WHERE id = $1
       RETURNING id, status, image_id, original_filename, store_id`,
      [id, revertToOriginal ? row.orig_id : null, revertToOriginal ? row.orig_path : null]
    );
    res.json({ ...upd.rows[0], reverted_to_original: revertToOriginal });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 19b. Re-crop a STAGED job's image (from the /staging page). Registers the crop
// linked to the job's original, then repoints the job (image_id + image_path) at
// it so the worker OCRs the crop once processed. Only staged jobs may be cropped.
app.put('/api/scan-jobs/:id/image', upload.single('image'), async (req: Request, res: Response) => {
  const file = req.file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ error: 'No image uploaded (field name: image)' });
  const id = parseInt(req.params.id);
  try {
    const cur = await db.query(
      `SELECT sj.status, i.id AS image_id, i.original_image_id
       FROM scan_jobs sj LEFT JOIN images i ON i.id = sj.image_id WHERE sj.id = $1`,
      [id]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Scan job not found' });
    if (cur.rows[0].status !== 'staged') return res.status(400).json({ error: 'Only staged jobs can be cropped' });
    // Link the crop to the job's TRUE original (follow through if the current image
    // is itself a crop, so re-cropping never chains crop→crop).
    const origId = cur.rows[0].image_id ? (cur.rows[0].original_image_id ?? cur.rows[0].image_id) : null;
    const crop = await registerImage(file, origId);
    const upd = await db.query(
      `UPDATE scan_jobs SET image_path = $1, image_id = $2 WHERE id = $3
       RETURNING id, status, image_id, original_filename, store_id`,
      [file.path, crop.id, id]
    );
    res.status(200).json(upd.rows[0]);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 19c. Send staged jobs for background OCR: staged → queued + enqueue. With `ids`,
// only those staged jobs are sent; otherwise every staged job. `use_paid` (per
// batch) records whether the worker's model pool may use paid vision models for
// these jobs (higher accuracy at token cost) — persisted on each row so the
// worker reads it when it picks up the job.
app.post('/api/scan-jobs/process', async (req: Request, res: Response) => {
  const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : null;
  const ids = rawIds ? rawIds.map((n: any) => parseInt(n)).filter((n: number) => Number.isInteger(n)) : null;
  const usePaid = req.body?.use_paid === true || req.body?.use_paid === 'true';
  try {
    const rows = ids && ids.length
      ? (await db.query("SELECT id FROM scan_jobs WHERE status = 'staged' AND id = ANY($1)", [ids])).rows
      : (await db.query("SELECT id FROM scan_jobs WHERE status = 'staged'")).rows;
    const processed: number[] = [];
    for (const r of rows) {
      await db.query("UPDATE scan_jobs SET status = 'queued', use_paid = $2 WHERE id = $1", [r.id, usePaid]);
      await addOcrJob(r.id);
      processed.push(r.id);
    }
    res.json({ processed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Images (scan photo attachments) ─────────────────────────────────────────

// 20. Upload a single image (sync-scan path); returns id + EXIF GPS if present.
app.post('/api/images', upload.single('image'), async (req: Request, res: Response) => {
  const file = req.file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ error: 'No image uploaded (field name: image)' });
  try {
    // Optional link to the full-res original: the scanner's crop-before-OCR path
    // POSTs the original first, then the crop with original_image_id set. Absent
    // for the icon picker and the worker's flyer images (backward compatible).
    const originalImageId = await parseOriginalImageId(req.body.original_image_id);
    const image = await registerImage(file, originalImageId);
    res.status(201).json(image);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 21. Serve a stored image.
app.get('/api/images/:id', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT path FROM images WHERE id = $1', [parseInt(req.params.id)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Image not found' });
    res.sendFile(result.rows[0].path);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Food aliases (learned name memory) ──────────────────────────────────────

// 22. Add an alias (verified OCR match). Duplicates are silently ignored.
app.post('/api/foods/:id/aliases', async (req: Request, res: Response) => {
  const { alias } = req.body;
  if (!alias || !String(alias).trim()) return res.status(400).json({ error: 'alias is required' });
  try {
    const result = await db.query(
      `INSERT INTO food_aliases (food_id, alias) VALUES ($1, $2)
       ON CONFLICT (food_id, lower(alias)) DO NOTHING RETURNING *`,
      [parseInt(req.params.id), String(alias).trim()]
    );
    res.status(201).json(result.rows[0] ?? { duplicate: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 23. Rename an alias.
app.put('/api/foods/:id/aliases/:aliasId', async (req: Request, res: Response) => {
  const { alias } = req.body;
  if (!alias || !String(alias).trim()) return res.status(400).json({ error: 'alias is required' });
  try {
    const result = await db.query(
      'UPDATE food_aliases SET alias = $1 WHERE id = $2 AND food_id = $3 RETURNING *',
      [String(alias).trim(), parseInt(req.params.aliasId), parseInt(req.params.id)]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Alias not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 24. Delete an alias.
app.delete('/api/foods/:id/aliases/:aliasId', async (req: Request, res: Response) => {
  try {
    await db.query('DELETE FROM food_aliases WHERE id = $1 AND food_id = $2',
      [parseInt(req.params.aliasId), parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 25. Promote an alias to the food's primary name (the old name becomes an alias).
app.post('/api/foods/:id/aliases/:aliasId/make-primary', async (req: Request, res: Response) => {
  const foodId = parseInt(req.params.id);
  const aliasId = parseInt(req.params.aliasId);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const aliasRes = await client.query(
      'SELECT * FROM food_aliases WHERE id = $1 AND food_id = $2 FOR UPDATE', [aliasId, foodId]);
    if (aliasRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Alias not found' });
    }
    const foodRes = await client.query('SELECT name FROM foods WHERE id = $1 FOR UPDATE', [foodId]);
    const oldName = foodRes.rows[0].name;
    const newName = aliasRes.rows[0].alias;

    // Swap: alias becomes the primary name; old primary becomes an alias.
    await client.query('UPDATE foods SET name = $1 WHERE id = $2', [newName, foodId]);
    await client.query('UPDATE food_aliases SET alias = $1 WHERE id = $2', [oldName, aliasId]);
    await client.query('COMMIT');
    res.json({ success: true, name: newName });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 26. Update food fields (rename primary name, category, unit, description).
app.put('/api/foods/:id', async (req: Request, res: Response) => {
  const { name, category, unit, description, barcode, usable_pct, density } = req.body;
  if (usable_pct !== undefined && usable_pct !== null && !(Number(usable_pct) > 0)) {
    return res.status(400).json({ error: 'usable_pct must be a positive number' });
  }
  if (density !== undefined && density !== null && !(Number(density) > 0)) {
    return res.status(400).json({ error: 'density must be a positive number' });
  }
  // image_id is presence-based, not COALESCE: the key being absent leaves the
  // icon untouched, but {image_id: null} must be able to CLEAR it back to the
  // display_image_id fallback (COALESCE alone can never express "set to null").
  const hasImageId = Object.prototype.hasOwnProperty.call(req.body, 'image_id');
  const imageId = req.body.image_id;
  if (hasImageId && imageId !== null && !(Number.isInteger(imageId) && imageId > 0)) {
    return res.status(400).json({ error: 'image_id must be a positive integer or null' });
  }
  try {
    if (hasImageId && imageId !== null) {
      const imgCheck = await db.query('SELECT 1 FROM images WHERE id = $1', [imageId]);
      if (imgCheck.rows.length === 0) {
        return res.status(400).json({ error: 'image_id does not reference a saved image' });
      }
    }
    const result = await db.query(
      `UPDATE foods SET
         name = COALESCE($1, name), category = COALESCE($2, category),
         unit = COALESCE($3, unit), description = COALESCE($4, description),
         barcode = COALESCE($5, barcode), usable_pct = COALESCE($6, usable_pct),
         density = COALESCE($8, density),
         image_id = CASE WHEN $9::boolean THEN $10::int ELSE image_id END
       WHERE id = $7 RETURNING *`,
      [name ?? null, category ?? null, unit ?? null, description ?? null, barcode ?? null,
       usable_pct != null ? Number(usable_pct) : null, parseInt(req.params.id),
       density != null ? Number(density) : null,
       hasImageId, hasImageId && imageId != null ? Number(imageId) : null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Food not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 27. Save a store's geolocation (learned from photo EXIF GPS).
app.put('/api/stores/:id/location', async (req: Request, res: Response) => {
  const { latitude, longitude } = req.body;
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'latitude and longitude are required' });
  }
  try {
    const result = await db.query(
      'UPDATE stores SET latitude = $1, longitude = $2 WHERE id = $3 RETURNING *',
      [latitude, longitude, parseInt(req.params.id)]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Store not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 28. How many rows reference a store — shown in the remove-store confirm so the
// user knows what they're reallocating before they commit to it.
app.get('/api/stores/:id/usage', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  try {
    const q = await db.query(
      `SELECT
         (SELECT count(*) FROM price_logs  WHERE store_id = $1 AND deleted_at IS NULL) AS price_logs,
         (SELECT count(*) FROM receipts    WHERE store_id = $1 AND deleted_at IS NULL) AS receipts,
         (SELECT count(*) FROM scan_jobs   WHERE store_id = $1) AS scan_jobs,
         (SELECT count(*) FROM scrape_jobs WHERE store_id = $1) AS scrape_jobs`,
      [id]
    );
    const r = q.rows[0];
    res.json({
      price_logs: Number(r.price_logs), receipts: Number(r.receipts),
      scan_jobs: Number(r.scan_jobs), scrape_jobs: Number(r.scrape_jobs),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 29. Remove a store (SOFT delete) and reallocate everything that referenced it.
// Body `{ reassign_to }`: a store id moves all its rows to that store; null/omitted
// leaves them unassigned (store_id NULL). Never a hard DELETE — price_logs and
// scrape_jobs are ON DELETE CASCADE, so a real delete would wipe the store's whole
// price history. Denormalized `store_name` (receipts/scrape_jobs) follows the new
// store when reassigning, but is KEPT when unassigning so the record still shows
// where the spend came from. Not audited — same precedent as /api/foods/merge,
// which likewise repoints price_logs in bulk. Idempotent (404 once gone).
app.delete('/api/stores/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const raw = req.body?.reassign_to;
  const reassignTo = raw == null || raw === '' ? null : parseInt(raw);
  if (reassignTo != null && !Number.isInteger(reassignTo)) {
    return res.status(400).json({ error: 'reassign_to must be a store id or null' });
  }
  if (reassignTo != null && reassignTo === id) {
    return res.status(400).json({ error: 'Cannot reassign a store to itself' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const store = await client.query('SELECT id FROM stores WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (store.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Store not found' }); }

    let targetName: string | null = null;
    if (reassignTo != null) {
      const t = await client.query('SELECT id, name FROM stores WHERE id = $1 AND deleted_at IS NULL', [reassignTo]);
      if (t.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'reassign_to store not found' }); }
      targetName = t.rows[0].name;
    }

    const priceLogs = await client.query('UPDATE price_logs SET store_id = $2 WHERE store_id = $1', [id, reassignTo]);
    const scanJobs = await client.query('UPDATE scan_jobs SET store_id = $2 WHERE store_id = $1', [id, reassignTo]);
    const scrapeJobs = reassignTo != null
      ? await client.query('UPDATE scrape_jobs SET store_id = $2, store_name = $3 WHERE store_id = $1', [id, reassignTo, targetName])
      : await client.query('UPDATE scrape_jobs SET store_id = NULL WHERE store_id = $1', [id]);
    const receipts = reassignTo != null
      ? await client.query('UPDATE receipts SET store_id = $2, store_name = $3 WHERE store_id = $1', [id, reassignTo, targetName])
      : await client.query('UPDATE receipts SET store_id = NULL WHERE store_id = $1', [id]);

    await client.query('UPDATE stores SET deleted_at = now() WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({
      success: true,
      id,
      reassigned_to: reassignTo,
      moved: {
        price_logs: priceLogs.rowCount ?? 0,
        scan_jobs: scanJobs.rowCount ?? 0,
        scrape_jobs: scrapeJobs.rowCount ?? 0,
        receipts: receipts.rowCount ?? 0,
      },
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── Calorie tracking: nutrition facts, diary, goals ─────────────────────────

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Inserts one diary row (+ its audit entry) inside the caller's transaction.
// Shared by POST /api/consumption-logs and POST /api/meals/:id/log so every
// diary entry goes through the same snapshot + audit path.
async function insertConsumptionLog(client: PoolClient, entry: {
  food_id: number | null;
  meal_id?: number | null;
  food_name: string;
  consumed_at: string | null;
  meal: string;
  amount: number;
  amount_unit: string;
  nutrients: Record<string, number | null>;
  notes: string | null;
  source: string;
}) {
  const cols = ['food_id', 'meal_id', 'food_name', 'consumed_at', 'meal', 'amount', 'amount_unit', ...NUTRIENT_FIELDS, 'notes', 'source'];
  const values = [entry.food_id, entry.meal_id ?? null, entry.food_name, entry.consumed_at, entry.meal,
    entry.amount, entry.amount_unit,
    ...NUTRIENT_FIELDS.map(f => entry.nutrients[f] ?? null), entry.notes, entry.source];
  // consumed_at defaults to now() when the caller omits it.
  const placeholders = cols.map((c, i) => (c === 'consumed_at' ? `COALESCE($${i + 1}, now())` : `$${i + 1}`)).join(', ');
  const result = await client.query(
    `INSERT INTO consumption_logs (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  const row = result.rows[0];
  await recordAudit(client, { entityType: 'consumption_log', entityId: row.id, action: 'create', after: row });
  return row;
}

// 28. Get a food's nutrition facts (null when none recorded).
app.get('/api/foods/:id/nutrition', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT fn.* FROM food_nutrition fn
       JOIN food_macros fm ON fm.nutrition_id = fn.id
       WHERE fm.food_id = $1
       ORDER BY (fn.food_id = $1) DESC, fn.id LIMIT 1`,
      [parseInt(req.params.id)]
    );
    res.json(result.rows[0] ?? null);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 29. Upsert a food's nutrition facts (per serving, as printed on the label).
// Nutrient columns (calories + macros + micros) are driven by NUTRIENT_FIELDS.
app.put('/api/foods/:id/nutrition', async (req: Request, res: Response) => {
  const foodId = parseInt(req.params.id);
  const { serving_size, serving_unit, calories, source } = req.body;
  if (!(Number(serving_size) > 0) || !serving_unit || calories === undefined || calories === null) {
    return res.status(400).json({ error: 'serving_size (> 0), serving_unit and calories are required' });
  }
  try {
    const food = await db.query('SELECT id FROM foods WHERE id = $1', [foodId]);
    if (food.rows.length === 0) return res.status(404).json({ error: 'Food not found' });

    // Nutrition is shareable: a profile can be linked to several foods via
    // food_macros. If this food already links one, UPDATE that profile in place
    // so the edit propagates to every food sharing it (that's the point of
    // sharing). Only when the food has no linked profile do we create one and
    // link it. (Sharing happens purely through food_macros — we never insert a
    // second owned row for the same food_id, so the UNIQUE(food_id) still holds.)
    const linked = await db.query(
      `SELECT fn.id FROM food_nutrition fn
       JOIN food_macros fm ON fm.nutrition_id = fn.id
       WHERE fm.food_id = $1
       ORDER BY (fn.food_id = $1) DESC, fn.id LIMIT 1`,
      [foodId]
    );

    let result;
    if (linked.rows.length > 0) {
      const setCols = ['serving_size', 'serving_unit', ...NUTRIENT_FIELDS, 'source'];
      const setValues = [serving_size, serving_unit,
        ...NUTRIENT_FIELDS.map(f => req.body[f] ?? null), source || 'manual'];
      const setClause = setCols.map((c, i) => `${c} = $${i + 1}`).concat('updated_at = now()').join(', ');
      result = await db.query(
        `UPDATE food_nutrition SET ${setClause} WHERE id = $${setCols.length + 1} RETURNING *`,
        [...setValues, linked.rows[0].id]
      );
    } else {
      const cols = ['food_id', 'serving_size', 'serving_unit', ...NUTRIENT_FIELDS, 'source'];
      const values = [foodId, serving_size, serving_unit,
        ...NUTRIENT_FIELDS.map(f => req.body[f] ?? null), source || 'manual'];
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      // A food may own a profile it isn't linked to (legacy back-compat); keep the
      // upsert-on-food_id so we reuse it instead of erroring on the UNIQUE.
      const updates = cols.slice(1).map(c => `${c} = EXCLUDED.${c}`).concat('updated_at = now()').join(', ');
      result = await db.query(
        `INSERT INTO food_nutrition (${cols.join(', ')}) VALUES (${placeholders})
         ON CONFLICT (food_id) DO UPDATE SET ${updates}
         RETURNING *`,
        values
      );
      await db.query(
        'INSERT INTO food_macros (food_id, nutrition_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [foodId, result.rows[0].id]
      );
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 29a. Share nutrition across two different products: point this food at the
// nutrition profile another food already uses (the user's "two different items,
// same underlying facts" case). Unlinks whatever this food currently uses and
// links the source food's effective profile; a profile this food *owned* and now
// nobody links is garbage-collected so we don't leave orphans. From then on,
// editing either food's facts updates the one shared profile.
app.post('/api/foods/:id/nutrition/copy-from/:sourceId', async (req: Request, res: Response) => {
  const foodId = parseInt(req.params.id);
  const sourceId = parseInt(req.params.sourceId);
  if (!Number.isInteger(foodId) || !Number.isInteger(sourceId)) {
    return res.status(400).json({ error: 'invalid food ids' });
  }
  if (foodId === sourceId) return res.status(400).json({ error: 'Pick a different food to share nutrition from' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // The source food's effective profile (owned-first, same ordering as reads).
    const src = await client.query(
      `SELECT fn.id FROM food_nutrition fn
       JOIN food_macros fm ON fm.nutrition_id = fn.id
       WHERE fm.food_id = $1 ORDER BY (fn.food_id = $1) DESC, fn.id LIMIT 1`,
      [sourceId]
    );
    if (src.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That food has no nutrition facts to share' });
    }
    const nutritionId = src.rows[0].id;

    // Unlink this food's current profile(s), remembering them for GC.
    const current = await client.query('SELECT nutrition_id FROM food_macros WHERE food_id = $1', [foodId]);
    await client.query('DELETE FROM food_macros WHERE food_id = $1', [foodId]);
    await client.query(
      'INSERT INTO food_macros (food_id, nutrition_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [foodId, nutritionId]
    );
    // Drop any profile this food just unlinked that nobody else links now.
    for (const row of current.rows) {
      if (row.nutrition_id === nutritionId) continue;
      const still = await client.query('SELECT 1 FROM food_macros WHERE nutrition_id = $1 LIMIT 1', [row.nutrition_id]);
      if (still.rows.length === 0) await client.query('DELETE FROM food_nutrition WHERE id = $1', [row.nutrition_id]);
    }
    await client.query('COMMIT');
    const full = await db.query(SINGLE_FOOD_SQL, [foodId]);
    res.json(full.rows[0]);
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 30. Remove a food's nutrition facts. Unlinks the profile(s) from this food and
// deletes any that no other food still shares (a profile linked by another food
// is left intact — see the sharing model above). Diary snapshots are unaffected.
app.delete('/api/foods/:id/nutrition', async (req: Request, res: Response) => {
  const foodId = parseInt(req.params.id);
  try {
    const linked = await db.query('SELECT nutrition_id FROM food_macros WHERE food_id = $1', [foodId]);
    await db.query('DELETE FROM food_macros WHERE food_id = $1', [foodId]);
    for (const row of linked.rows) {
      const still = await db.query('SELECT 1 FROM food_macros WHERE nutrition_id = $1 LIMIT 1', [row.nutrition_id]);
      if (still.rows.length === 0) await db.query('DELETE FROM food_nutrition WHERE id = $1', [row.nutrition_id]);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 30b. Create a catalog food straight from a nutrition candidate (USDA/manual) with
// NO price required. Called by the meals builder's USDA tab in **save-on-pick** mode
// (only the item the user actually adds to a recipe is saved — a search no longer
// bulk-adds every result; the old `autoSave` path in NutritionSearch is retired). If
// the barcode already matches a food, reuses it and (re)attaches the nutrition rather
// than 409-ing on the UNIQUE barcode. Returns the food in the standard single-food shape.
app.post('/api/foods/from-nutrition', async (req: Request, res: Response) => {
  const { name, barcode, category, unit, serving_size, serving_unit, calories, source } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  if (!(Number(serving_size) > 0) || !serving_unit || calories === undefined || calories === null) {
    return res.status(400).json({ error: 'serving_size (> 0), serving_unit and calories are required' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Reuse an existing food when the barcode already exists (avoids a duplicate-
    // barcode violation); otherwise create a new one. No price is created.
    let foodId: number | null = null;
    if (barcode) {
      const existing = await client.query('SELECT id FROM foods WHERE barcode = $1', [String(barcode)]);
      if (existing.rows.length > 0) foodId = existing.rows[0].id;
    }
    // No barcode to dedup on (Foundation/SR foods): reuse an existing same-name
    // food so repeated searches (esp. with auto-save) don't pile up duplicates —
    // but only when that food has no nutrition or its nutrition is USDA-sourced,
    // so we never clobber a hand-entered/scanned food's facts.
    if (foodId == null && !barcode) {
      const byName = await client.query(
        `SELECT f.id, fn.source AS nutrition_source
         FROM foods f LEFT JOIN food_nutrition fn ON fn.food_id = f.id
         WHERE lower(f.name) = lower($1) ORDER BY f.id LIMIT 1`,
        [String(name).trim()]
      );
      if (byName.rows.length > 0 && (byName.rows[0].nutrition_source == null || byName.rows[0].nutrition_source === 'usda')) {
        foodId = byName.rows[0].id;
      }
    }
    if (foodId == null) {
      const created = await client.query(
        'INSERT INTO foods (name, barcode, category, unit) VALUES ($1, $2, $3, $4) RETURNING id',
        [String(name).trim(), barcode || null, category || 'Other', unit || serving_unit || 'each']
      );
      foodId = created.rows[0].id;
    }
    // Deliberately re-adding a food that was archived on /audit un-archives it —
    // otherwise the save would silently land on a food hidden from every list.
    // No-op for a freshly inserted food.
    await client.query('UPDATE foods SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL', [foodId]);

    // Upsert the per-serving nutrition and link it in the M:N table (same as
    // PUT /api/foods/:id/nutrition).
    const cols = ['food_id', 'serving_size', 'serving_unit', ...NUTRIENT_FIELDS, 'source'];
    const values = [foodId, serving_size, serving_unit,
      ...NUTRIENT_FIELDS.map(f => req.body[f] ?? null), source || 'usda'];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const updates = cols.slice(1).map(c => `${c} = EXCLUDED.${c}`).concat('updated_at = now()').join(', ');
    const nut = await client.query(
      `INSERT INTO food_nutrition (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (food_id) DO UPDATE SET ${updates} RETURNING id`,
      values
    );
    await client.query(
      'INSERT INTO food_macros (food_id, nutrition_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [foodId, nut.rows[0].id]
    );
    await client.query('COMMIT');
    const full = await db.query(SINGLE_FOOD_SQL, [foodId]);
    res.status(201).json(full.rows[0]);
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 31. List consumption logs, optionally for one day (?date=YYYY-MM-DD).
app.get('/api/consumption-logs', async (req: Request, res: Response) => {
  const { date, food_id, include_deleted } = req.query;
  try {
    const params: any[] = [];
    let where = 'WHERE 1=1';
    if (!include_deleted || include_deleted === 'false') {
      where += ' AND cl.deleted_at IS NULL';
    }
    if (date) {
      if (!DATE_RE.test(String(date))) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      params.push(date);
      where += ` AND cl.consumed_at::date = $${params.length}::date`;
    }
    if (food_id) {
      params.push(parseInt(food_id as string));
      where += ` AND cl.food_id = $${params.length}`;
    }
    const result = await db.query(
      `SELECT cl.*, f.category
       FROM consumption_logs cl
       LEFT JOIN foods f ON cl.food_id = f.id
       ${where}
       ORDER BY cl.consumed_at DESC, cl.id DESC`,
      params
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 32. Log something eaten (audited).
// Two shapes: { food_id, amount, amount_unit } computes the nutrient snapshot
// from the food's facts ('serving' is a valid unit); explicit calories/macros
// in the body override the computation — required when the food has no facts,
// and how quick-add entries without a catalog food (food_name only) work.
app.post('/api/consumption-logs', async (req: Request, res: Response) => {
  const { food_id, food_name, amount, amount_unit, meal, consumed_at, notes, calories, source } = req.body;
  const mealValue = meal || 'snack';
  if (!MEALS.includes(mealValue)) {
    return res.status(400).json({ error: `meal must be one of: ${MEALS.join(', ')}` });
  }
  if (!food_id && !(food_name && String(food_name).trim())) {
    return res.status(400).json({ error: 'food_id or food_name is required' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    let name: string = String(food_name ?? '').trim();
    let facts: NutritionFacts | null = null;
    if (food_id) {
      const foodRes = await client.query(
        `SELECT f.name,
           (SELECT row_to_json(fn) FROM food_nutrition fn
            JOIN food_macros fm ON fm.nutrition_id = fn.id
            WHERE fm.food_id = f.id
            ORDER BY (fn.food_id = f.id) DESC, fn.id LIMIT 1) AS nutrition
         FROM foods f WHERE f.id = $1`,
        [parseInt(food_id)]
      );
      if (foodRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Food not found' });
      }
      name = name || foodRes.rows[0].name;
      const nut = foodRes.rows[0].nutrition;
      if (nut && nut.serving_size != null) facts = nut;
    }

    // Quick-add entries default to 1 serving; catalog entries need a real amount.
    const amt = amount !== undefined ? Number(amount) : food_id ? NaN : 1;
    const unit = amount_unit ?? (food_id ? null : 'serving');
    if (!(amt > 0) || !unit) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'amount (> 0) and amount_unit are required' });
    }

    // Explicit nutrients in the body win (macros/micros too if provided);
    // otherwise scale the food's facts to the amount.
    let nutrients: Record<string, number | null> = {};
    for (const f of NUTRIENT_FIELDS) nutrients[f] = req.body[f] ?? null;
    if (nutrients.calories == null && facts) {
      const scaled = scaleNutrients(facts, amt, String(unit));
      if (!scaled) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Cannot convert ${amt} ${unit} against a serving of ${facts.serving_size} ${facts.serving_unit}; use a matching unit or 'serving'`,
        });
      }
      nutrients = scaled;
    }
    if (nutrients.calories == null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This food has no nutrition facts; supply calories explicitly or add facts first' });
    }

    const row = await insertConsumptionLog(client, {
      food_id: food_id ?? null,
      food_name: name,
      consumed_at: consumed_at ?? null,
      meal: mealValue,
      amount: amt,
      amount_unit: String(unit),
      nutrients,
      notes: notes ?? null,
      source: source || 'manual',
    });
    await client.query('COMMIT');
    res.status(201).json(row);
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 33. Update a diary entry (audited). Changing the amount recomputes the
// nutrient snapshot from the food's current facts unless explicit values are
// passed alongside.
app.put('/api/consumption-logs/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM consumption_logs WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Consumption log not found' });
    }
    const before = existing.rows[0];

    const next: any = { ...before };
    const editable = ['food_name', 'meal', 'consumed_at', 'amount', 'amount_unit', 'notes', ...NUTRIENT_FIELDS];
    for (const field of editable) {
      if (req.body[field] !== undefined) next[field] = req.body[field];
    }
    if (!MEALS.includes(next.meal)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `meal must be one of: ${MEALS.join(', ')}` });
    }

    // If the amount changed and the caller didn't pass explicit calories,
    // recompute the whole nutrient snapshot from the food's current facts.
    const amountChanged = req.body.amount !== undefined || req.body.amount_unit !== undefined;
    const explicitNutrients = req.body.calories !== undefined;
    if (amountChanged && !explicitNutrients && next.food_id) {
      const factsRes = await client.query(
        `SELECT fn.* FROM food_nutrition fn
         JOIN food_macros fm ON fm.nutrition_id = fn.id
         WHERE fm.food_id = $1
         ORDER BY (fn.food_id = $1) DESC, fn.id LIMIT 1`,
        [next.food_id]
      );
      if (factsRes.rows.length > 0) {
        const scaled = scaleNutrients(factsRes.rows[0], Number(next.amount), String(next.amount_unit));
        if (!scaled) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Cannot convert ${next.amount} ${next.amount_unit} for this food's serving unit` });
        }
        Object.assign(next, scaled);
      }
    }

    const cols = ['food_name', 'meal', 'consumed_at', 'amount', 'amount_unit', 'notes', ...NUTRIENT_FIELDS];
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const values = cols.map(c => next[c]);
    values.push(id);
    const updated = await client.query(
      `UPDATE consumption_logs SET ${setClause} WHERE id = $${cols.length + 1} RETURNING *`,
      values
    );
    const after = updated.rows[0];
    await recordAudit(client, { entityType: 'consumption_log', entityId: id, action: 'update', before, after });
    await client.query('COMMIT');
    res.json(after);
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 34. Soft-delete a diary entry (audited).
app.delete('/api/consumption-logs/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM consumption_logs WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Consumption log not found' });
    }
    if (existing.rows[0].deleted_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Consumption log is already deleted' });
    }
    await client.query('UPDATE consumption_logs SET deleted_at = now() WHERE id = $1', [id]);
    await recordAudit(client, { entityType: 'consumption_log', entityId: id, action: 'delete', before: existing.rows[0] });
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 35. Day view: entries + totals vs. goals. Defaults to today.
app.get('/api/diary', async (req: Request, res: Response) => {
  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const [entries, totals, goals] = await Promise.all([
      db.query(
        `SELECT cl.*, f.category
         FROM consumption_logs cl LEFT JOIN foods f ON cl.food_id = f.id
         WHERE cl.consumed_at::date = $1::date AND cl.deleted_at IS NULL
         ORDER BY cl.consumed_at ASC, cl.id ASC`,
        [date]
      ),
      db.query(
        `SELECT ${NUTRIENT_FIELDS.map(f => `COALESCE(SUM(${f}), 0)::float AS ${f}`).join(', ')},
                COUNT(*)::int AS entry_count
         FROM consumption_logs
         WHERE consumed_at::date = $1::date AND deleted_at IS NULL`,
        [date]
      ),
      db.query('SELECT * FROM user_goals WHERE id = 1'),
    ]);
    res.json({
      date,
      entries: entries.rows,
      totals: totals.rows[0],
      goals: goals.rows[0] ?? null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 35b. Search USDA FoodData Central for nutrition facts (proxied so the API
// key stays server-side). ?q= takes free text or a barcode. Results are
// per-serving candidates in the food_nutrition shape — the user picks one in
// the UI and confirms before anything is saved.
app.get('/api/nutrition-search', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  const apiKey = process.env.FDC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'FDC_API_KEY is not configured' });
  try {
    res.json(await searchFdc(q, apiKey));
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// 36. Get daily targets.
app.get('/api/goals', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM user_goals WHERE id = 1');
    res.json(result.rows[0] ?? null);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 37. Update daily targets (partial; only provided fields change).
app.put('/api/goals', async (req: Request, res: Response) => {
  const { daily_calories, protein_g, carbs_g, fat_g } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO user_goals (id, daily_calories, protein_g, carbs_g, fat_g)
       VALUES (1, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         daily_calories = COALESCE($1, user_goals.daily_calories),
         protein_g = COALESCE($2, user_goals.protein_g),
         carbs_g = COALESCE($3, user_goals.carbs_g),
         fat_g = COALESCE($4, user_goals.fat_g),
         updated_at = now()
       RETURNING *`,
      [daily_calories ?? null, protein_g ?? null, carbs_g ?? null, fat_g ?? null]
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Meal plans (recipes composed of catalog foods) ──────────────────────────

// Per-ingredient detail used by every meal read: the food's effective
// nutrition (join-preferred, same rule as GET /api/foods) and its latest
// non-deleted price that has a usable unit_price (needed to cost the amount).
const MEAL_INGREDIENT_SELECT = `
  SELECT mi.id, mi.meal_id, mi.food_id, mi.amount, mi.amount_unit, mi.sort_order,
         f.name AS food_name, f.unit AS food_unit, f.density,
         (SELECT row_to_json(fn) FROM food_nutrition fn
          JOIN food_macros fm ON fm.nutrition_id = fn.id
          WHERE fm.food_id = mi.food_id
          ORDER BY (fn.food_id = mi.food_id) DESC, fn.id LIMIT 1) AS nutrition,
         (SELECT row_to_json(lp) FROM (
            SELECT pl.price, pl.unit_price, pl.amount, pl.amount_unit, pl.scraped_at, pl.is_sale, pl.sale_ends_at, s.name AS store_name
            FROM price_logs pl
            JOIN food_prices fp ON fp.price_log_id = pl.id
            LEFT JOIN stores s ON pl.store_id = s.id
            WHERE fp.food_id = mi.food_id AND pl.deleted_at IS NULL AND pl.unit_price IS NOT NULL AND ${ACTIVE_PRICE_SQL}
            ORDER BY pl.scraped_at DESC LIMIT 1
          ) lp) AS latest_price
  FROM meal_ingredients mi
  JOIN foods f ON mi.food_id = f.id
`;

// Validates and bulk-inserts a meal's ingredient list inside a transaction.
// Returns an error message (caller responds 400 + rolls back) or null.
async function insertMealIngredients(client: PoolClient, mealId: number, ingredients: any[]): Promise<string | null> {
  for (const ing of ingredients) {
    const err = validateIngredient(ing);
    if (err) return err;
  }
  for (let i = 0; i < ingredients.length; i++) {
    const ing = ingredients[i];
    await client.query(
      `INSERT INTO meal_ingredients (meal_id, food_id, amount, amount_unit, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [mealId, parseInt(ing.food_id), Number(ing.amount), String(ing.amount_unit).trim(), ing.sort_order ?? i]
    );
  }
  return null;
}

// 38. List meals with live totals (macros + cost) and per-serving figures.
app.get('/api/meals', async (req: Request, res: Response) => {
  try {
    const [meals, ingredients] = await Promise.all([
      db.query('SELECT * FROM meals ORDER BY updated_at DESC, id DESC'),
      db.query(`${MEAL_INGREDIENT_SELECT} ORDER BY mi.meal_id, mi.sort_order, mi.id`),
    ]);
    const byMeal = new Map<number, IngredientRow[]>();
    for (const row of ingredients.rows) {
      const list = byMeal.get(row.meal_id) ?? [];
      list.push(row);
      byMeal.set(row.meal_id, list);
    }
    res.json(meals.rows.map((meal) => {
      const summary = summarizeMeal(byMeal.get(meal.id) ?? [], Number(meal.servings));
      return {
        ...meal,
        ingredient_count: (byMeal.get(meal.id) ?? []).length,
        totals: summary.totals,
        per_serving: summary.per_serving,
        nutrition_complete: summary.nutrition_complete,
        cost_complete: summary.cost_complete,
      };
    }));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 39. Draft a meal with an LLM from selected "fridge" foods and macro targets.
// Returns an UNSAVED draft in the POST /api/meals ingredients shape — the user
// reviews/edits it in the builder and saves explicitly (nothing auto-commits,
// same review invariant as OCR). Registered before the :id routes.
app.post('/api/meals/generate', async (req: Request, res: Response) => {
  const { food_ids, targets, notes } = req.body || {};
  if (!Array.isArray(food_ids) || food_ids.length === 0) {
    return res.status(400).json({ error: 'food_ids (non-empty array) is required' });
  }
  try {
    const foods = await db.query(
      `SELECT f.id, f.name,
         (SELECT row_to_json(fn) FROM food_nutrition fn
          JOIN food_macros fm ON fm.nutrition_id = fn.id
          WHERE fm.food_id = f.id
          ORDER BY (fn.food_id = f.id) DESC, fn.id LIMIT 1) AS nutrition
       FROM foods f WHERE f.id = ANY($1::int[])`,
      [food_ids.map((id: any) => parseInt(id))]
    );
    const usable = foods.rows.filter((f) => f.nutrition && f.nutrition.serving_size != null);
    if (usable.length === 0) {
      return res.status(400).json({ error: 'None of the selected foods have nutrition facts' });
    }

    const foodLines = usable.map((f) => {
      const n = f.nutrition;
      return `- food_id ${f.id}: ${f.name} — serving ${n.serving_size} ${n.serving_unit}, ` +
        `${n.calories} kcal, protein ${n.protein_g ?? '?'}g, carbs ${n.carbs_g ?? '?'}g, fat ${n.fat_g ?? '?'}g`;
    }).join('\n');
    const targetLines = ['calories', 'protein_g', 'carbs_g', 'fat_g']
      .filter((k) => targets && targets[k] != null)
      .map((k) => `${k}: ${targets[k]}`).join(', ');

    const system =
      'You are a meal-planning assistant. Compose ONE realistic meal using ONLY the provided foods (a subset is fine). ' +
      'Per-serving nutrition targets apply to one serving of the meal. ' +
      'Respond with a single JSON object: {"name": string, "servings": number, ' +
      '"ingredients": [{"food_id": number, "amount": number, "amount_unit": string}], "rationale": string}. ' +
      "amount_unit must be 'serving' (a multiple of that food's serving size, decimals allowed) " +
      "or the food's own serving unit (e.g. g, ml). Keep amounts sensible for a real recipe.";
    const user =
      `Available foods (per-serving facts):\n${foodLines}\n\n` +
      (targetLines ? `Targets per serving of the meal: ${targetLines}\n` : 'No specific macro targets; make a balanced meal.\n') +
      (notes ? `Additional instructions: ${String(notes).slice(0, 500)}\n` : '');

    const draft = await chatJson(system, user);

    // Keep only ingredients that reference the provided foods with valid
    // amounts/units; the model's output is a suggestion, not trusted input.
    const allowedIds = new Set(usable.map((f) => f.id));
    const nameById = new Map(usable.map((f) => [f.id, f.name]));
    const ingredients = (Array.isArray(draft?.ingredients) ? draft.ingredients : [])
      .filter((ing: any) => allowedIds.has(parseInt(ing?.food_id)) && !validateIngredient(ing))
      .map((ing: any) => ({
        food_id: parseInt(ing.food_id),
        food_name: nameById.get(parseInt(ing.food_id)),
        amount: Number(ing.amount),
        amount_unit: String(ing.amount_unit).trim(),
      }));
    if (ingredients.length === 0) {
      return res.status(502).json({ error: 'The model did not return any usable ingredients — try again' });
    }

    res.json({
      draft: {
        name: typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : 'Generated meal',
        servings: Number(draft.servings) > 0 ? Number(draft.servings) : 1,
        ingredients,
        rationale: typeof draft.rationale === 'string' ? draft.rationale : null,
      },
    });
  } catch (err: any) {
    const status = err instanceof LlmError ? err.status : 500;
    res.status(status).json({ error: err.message });
  }
});

// 40. Create a meal with its ingredients.
app.post('/api/meals', async (req: Request, res: Response) => {
  const { name, servings, notes, ingredients } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Meal name is required' });
  if (servings !== undefined && servings !== null && !(Number(servings) > 0)) {
    return res.status(400).json({ error: 'servings must be a positive number' });
  }
  if (ingredients !== undefined && !Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'ingredients must be an array' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const meal = await client.query(
      'INSERT INTO meals (name, notes, servings) VALUES ($1, $2, $3) RETURNING *',
      [String(name).trim(), notes ?? null, servings != null ? Number(servings) : 1]
    );
    const err = await insertMealIngredients(client, meal.rows[0].id, ingredients ?? []);
    if (err) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: err });
    }
    await client.query('COMMIT');
    res.status(201).json(meal.rows[0]);
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 41. One meal with full per-ingredient detail (scaled nutrients, latest price
// + cost) and live totals / per-serving figures.
app.get('/api/meals/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  try {
    const [meal, ingredients] = await Promise.all([
      db.query('SELECT * FROM meals WHERE id = $1', [id]),
      db.query(`${MEAL_INGREDIENT_SELECT} WHERE mi.meal_id = $1 ORDER BY mi.sort_order, mi.id`, [id]),
    ]);
    if (meal.rows.length === 0) return res.status(404).json({ error: 'Meal not found' });
    const summary = summarizeMeal(ingredients.rows, Number(meal.rows[0].servings));
    res.json({
      ...meal.rows[0],
      ingredients: summary.ingredients,
      totals: summary.totals,
      per_serving: summary.per_serving,
      nutrition_complete: summary.nutrition_complete,
      cost_complete: summary.cost_complete,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 42. Update a meal. When `ingredients` is provided the list is replaced
// wholesale (delete + reinsert) — simplest correct semantics for a small list.
app.put('/api/meals/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { name, servings, notes, ingredients } = req.body || {};
  if (servings !== undefined && servings !== null && !(Number(servings) > 0)) {
    return res.status(400).json({ error: 'servings must be a positive number' });
  }
  if (ingredients !== undefined && !Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'ingredients must be an array' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE meals SET
         name = COALESCE($1, name), notes = COALESCE($2, notes),
         servings = COALESCE($3, servings), updated_at = now()
       WHERE id = $4 RETURNING *`,
      [name != null ? String(name).trim() : null, notes ?? null,
       servings != null ? Number(servings) : null, id]
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Meal not found' });
    }
    if (Array.isArray(ingredients)) {
      await client.query('DELETE FROM meal_ingredients WHERE meal_id = $1', [id]);
      const err = await insertMealIngredients(client, id, ingredients);
      if (err) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: err });
      }
    }
    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 43. Delete a meal (hard delete; ingredients cascade, diary entries keep
// their snapshot with meal_id nulled).
app.delete('/api/meals/:id', async (req: Request, res: Response) => {
  try {
    const result = await db.query('DELETE FROM meals WHERE id = $1 RETURNING id', [parseInt(req.params.id)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Meal not found' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 44. Clone a meal (with its ingredients) so a previous meal can be tweaked
// without losing the original.
app.post('/api/meals/:id/clone', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const copy = await client.query(
      `INSERT INTO meals (name, notes, servings)
       SELECT 'Copy of ' || name, notes, servings FROM meals WHERE id = $1 RETURNING *`,
      [id]
    );
    if (copy.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Meal not found' });
    }
    await client.query(
      `INSERT INTO meal_ingredients (meal_id, food_id, amount, amount_unit, sort_order)
       SELECT $1, food_id, amount, amount_unit, sort_order FROM meal_ingredients WHERE meal_id = $2`,
      [copy.rows[0].id, id]
    );
    await client.query('COMMIT');
    res.status(201).json(copy.rows[0]);
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 45. Log portions of a meal to the diary as ONE consumption entry: the meal's
// per-serving nutrients × portions, snapshotted at log time like any other
// diary entry (audited, source='meal', meal_id for provenance).
app.post('/api/meals/:id/log', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { meal, portions, consumed_at, notes } = req.body || {};
  const mealValue = meal || 'snack';
  if (!MEALS.includes(mealValue)) {
    return res.status(400).json({ error: `meal must be one of: ${MEALS.join(', ')}` });
  }
  const qty = portions !== undefined ? Number(portions) : 1;
  if (!(qty > 0)) return res.status(400).json({ error: 'portions must be a positive number' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const [mealRes, ingredients] = await Promise.all([
      client.query('SELECT * FROM meals WHERE id = $1', [id]),
      client.query(`${MEAL_INGREDIENT_SELECT} WHERE mi.meal_id = $1 ORDER BY mi.sort_order, mi.id`, [id]),
    ]);
    if (mealRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Meal not found' });
    }
    const summary = summarizeMeal(ingredients.rows, Number(mealRes.rows[0].servings));
    if (summary.per_serving.calories === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No ingredient in this meal has nutrition facts — add facts before logging it' });
    }

    const nutrients: Record<string, number | null> = {};
    for (const f of NUTRIENT_FIELDS) {
      const v = summary.per_serving[f];
      nutrients[f] = v === null ? null : Math.round(v * qty * 100) / 100;
    }
    const row = await insertConsumptionLog(client, {
      food_id: null,
      meal_id: id,
      food_name: mealRes.rows[0].name,
      consumed_at: consumed_at ?? null,
      meal: mealValue,
      amount: qty,
      amount_unit: 'serving',
      nutrients,
      notes: notes ?? null,
      source: 'meal',
    });
    await client.query('COMMIT');
    res.status(201).json({ ...row, nutrition_complete: summary.nutrition_complete });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── Budget / spending tracking ──────────────────────────────────────────────
// Receipts are the spending record: one row per shopping trip, carrying the
// store source and total cost. Written automatically when a receipt scan is
// committed (ReviewItems, source='scan') and by hand from the budget page
// (source='manual'). See CLAUDE.md "Budget / spending tracking".

const MONTH_RE = /^\d{4}-\d{2}$/;

// Resolve the denormalized store_name for a given store_id (kept on the receipt
// so spend history survives the store being deleted).
async function storeNameFor(storeId: number | null): Promise<string | null> {
  if (storeId == null) return null;
  const r = await db.query('SELECT name FROM stores WHERE id = $1', [storeId]);
  return r.rows[0]?.name ?? null;
}

// 42. List receipts (spending records), newest first. Filters: ?month=YYYY-MM,
// ?store_id=, ?from=YYYY-MM-DD&to=YYYY-MM-DD. Excludes soft-deleted.
app.get('/api/receipts', async (req: Request, res: Response) => {
  const { month, store_id, from, to } = req.query as Record<string, string>;
  const where: string[] = ['r.deleted_at IS NULL'];
  const params: any[] = [];
  if (month) {
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
    params.push(month); where.push(`to_char(r.purchased_on, 'YYYY-MM') = $${params.length}`);
  }
  if (from) {
    if (!DATE_RE.test(from)) return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
    params.push(from); where.push(`r.purchased_on >= $${params.length}`);
  }
  if (to) {
    if (!DATE_RE.test(to)) return res.status(400).json({ error: 'to must be YYYY-MM-DD' });
    params.push(to); where.push(`r.purchased_on <= $${params.length}`);
  }
  if (store_id) { params.push(parseInt(store_id)); where.push(`r.store_id = $${params.length}`); }
  try {
    const result = await db.query(
      `SELECT r.*, COALESCE(s.name, r.store_name) AS store_name
       FROM receipts r LEFT JOIN stores s ON r.store_id = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY r.purchased_on DESC, r.id DESC`,
      params
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 43. Spending summary for the budget page: this month's spend vs. the monthly
// budget target, a by-month series (last 12 months), and a per-store breakdown
// for the selected month (defaults to the current month).
app.get('/api/receipts/summary', async (req: Request, res: Response) => {
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  try {
    const [monthAgg, byStore, byMonth, budget] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(total), 0)::float AS spent, COUNT(*)::int AS receipt_count
         FROM receipts WHERE deleted_at IS NULL AND to_char(purchased_on, 'YYYY-MM') = $1`,
        [month]
      ),
      db.query(
        `SELECT r.store_id, COALESCE(s.name, r.store_name, 'Unknown') AS store_name,
                COALESCE(SUM(r.total), 0)::float AS spent, COUNT(*)::int AS receipt_count
         FROM receipts r LEFT JOIN stores s ON r.store_id = s.id
         WHERE r.deleted_at IS NULL AND to_char(r.purchased_on, 'YYYY-MM') = $1
         GROUP BY r.store_id, COALESCE(s.name, r.store_name, 'Unknown')
         ORDER BY spent DESC`,
        [month]
      ),
      db.query(
        `SELECT to_char(purchased_on, 'YYYY-MM') AS month,
                COALESCE(SUM(total), 0)::float AS spent, COUNT(*)::int AS receipt_count
         FROM receipts
         WHERE deleted_at IS NULL AND purchased_on >= (date_trunc('month', CURRENT_DATE) - INTERVAL '11 months')
         GROUP BY 1 ORDER BY 1 ASC`
      ),
      db.query('SELECT monthly_budget FROM budget_goals WHERE id = 1'),
    ]);
    res.json({
      month,
      spent: monthAgg.rows[0].spent,
      receipt_count: monthAgg.rows[0].receipt_count,
      monthly_budget: budget.rows[0]?.monthly_budget != null ? Number(budget.rows[0].monthly_budget) : null,
      by_store: byStore.rows,
      by_month: byMonth.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 44. Create a receipt (spending record). Used by ReviewItems on receipt commit
// (source='scan') and manual add on the budget page (source='manual').
app.post('/api/receipts', async (req: Request, res: Response) => {
  const { store_id, total, purchased_on, item_count, source, notes, image_id, scan_job_id } = req.body;
  const totalNum = Number(total);
  if (!Number.isFinite(totalNum) || totalNum < 0) return res.status(400).json({ error: 'total must be a number >= 0' });
  if (purchased_on && !DATE_RE.test(String(purchased_on))) return res.status(400).json({ error: 'purchased_on must be YYYY-MM-DD' });
  const storeIdNum = store_id != null && store_id !== '' ? parseInt(store_id) : null;
  try {
    const result = await db.query(
      `INSERT INTO receipts (store_id, store_name, total, purchased_on, item_count, source, notes, image_id, scan_job_id)
       VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        storeIdNum,
        await storeNameFor(storeIdNum),
        totalNum,
        purchased_on ?? null,
        item_count != null ? parseInt(item_count) : 0,
        source === 'scan' ? 'scan' : 'manual',
        notes ?? null,
        image_id != null ? parseInt(image_id) : null,
        scan_job_id != null ? parseInt(scan_job_id) : null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 45. Edit a receipt (partial). store_id, total, purchased_on, notes.
app.put('/api/receipts/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { store_id, total, purchased_on, notes } = req.body;
  if (total != null && (!Number.isFinite(Number(total)) || Number(total) < 0)) {
    return res.status(400).json({ error: 'total must be a number >= 0' });
  }
  if (purchased_on != null && !DATE_RE.test(String(purchased_on))) {
    return res.status(400).json({ error: 'purchased_on must be YYYY-MM-DD' });
  }
  const storeIdProvided = Object.prototype.hasOwnProperty.call(req.body, 'store_id');
  const storeIdNum = store_id != null && store_id !== '' ? parseInt(store_id) : null;
  try {
    const result = await db.query(
      `UPDATE receipts SET
         store_id = CASE WHEN $2::boolean THEN $3 ELSE store_id END,
         store_name = CASE WHEN $2::boolean THEN $4 ELSE store_name END,
         total = COALESCE($5, total),
         purchased_on = COALESCE($6::date, purchased_on),
         notes = COALESCE($7, notes)
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [
        id,
        storeIdProvided,
        storeIdNum,
        storeIdProvided ? await storeNameFor(storeIdNum) : null,
        total != null ? Number(total) : null,
        purchased_on ?? null,
        notes ?? null,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'receipt not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 46. Soft-delete a receipt.
app.delete('/api/receipts/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  try {
    const result = await db.query(
      `UPDATE receipts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'receipt not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 47. Get / set the single-row monthly budget target.
app.get('/api/budget', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT monthly_budget FROM budget_goals WHERE id = 1');
    const mb = result.rows[0]?.monthly_budget;
    res.json({ monthly_budget: mb != null ? Number(mb) : null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/budget', async (req: Request, res: Response) => {
  const { monthly_budget } = req.body;
  if (monthly_budget != null && (!Number.isFinite(Number(monthly_budget)) || Number(monthly_budget) < 0)) {
    return res.status(400).json({ error: 'monthly_budget must be a number >= 0 (or null to clear)' });
  }
  try {
    const result = await db.query(
      `INSERT INTO budget_goals (id, monthly_budget) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET monthly_budget = $1, updated_at = now()
       RETURNING monthly_budget`,
      [monthly_budget != null ? Number(monthly_budget) : null]
    );
    res.json({ monthly_budget: result.rows[0].monthly_budget != null ? Number(result.rows[0].monthly_budget) : null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 48. Get / set app-wide settings (single row, id = 1).
// `default_sale_days` is how long a sale is assumed to last when a scan finds a
// sale price with no printed end date — see resolveSaleEndsAt.
app.get('/api/settings', async (req: Request, res: Response) => {
  try {
    const days = await getDefaultSaleDays();
    res.json({ default_sale_days: days });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', async (req: Request, res: Response) => {
  const { default_sale_days } = req.body;
  const days = Number(default_sale_days);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return res.status(400).json({ error: 'default_sale_days must be a whole number between 1 and 365' });
  }
  try {
    const result = await db.query(
      `INSERT INTO app_settings (id, default_sale_days) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET default_sale_days = $1, updated_at = now()
       RETURNING default_sale_days`,
      [days]
    );
    res.json({ default_sale_days: result.rows[0].default_sale_days });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Start Express API server
app.listen(PORT, async () => {
  console.log(`Backend server running on port ${PORT}`);
  await db.initializeDatabase();
});

