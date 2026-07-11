import express, { Request, Response } from 'express';
import cors from 'cors';
import * as db from './db';
import { addScrapingJob, addCocowestScrapeJob, addOcrJob } from './queue';
import { computeUnitPrice } from './units';
import { scaleNutrients, NutritionFacts, NUTRIENT_FIELDS } from './nutrition';
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
async function registerImage(file: Express.Multer.File): Promise<{ id: number; latitude: number | null; longitude: number | null }> {
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
    'INSERT INTO images (path, original_filename, latitude, longitude) VALUES ($1, $2, $3, $4) RETURNING id',
    [file.path, file.originalname, latitude, longitude]
  );
  return { id: result.rows[0].id, latitude, longitude };
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

// 2. Get All Stores
app.get('/api/stores', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM stores ORDER BY name ASC');
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

// 4. Get All Foods (with latest prices)
app.get('/api/foods', async (req: Request, res: Response) => {
  const { category, search } = req.query;
  try {
    let queryText = `
      SELECT f.*, 
        (
          SELECT json_agg(prices)
          FROM (
            SELECT pl.price, pl.unit_price, pl.amount, pl.amount_unit, pl.scraped_at, pl.is_sale, s.name as store_name, s.id as store_id
            FROM price_logs pl
            JOIN food_prices fp ON fp.price_log_id = pl.id
            JOIN stores s ON pl.store_id = s.id
            WHERE fp.food_id = f.id AND pl.deleted_at IS NULL
            ORDER BY pl.scraped_at DESC
            LIMIT 3
          ) prices
        ) as latest_prices,
        (
          SELECT json_agg(json_build_object('id', fa.id, 'alias', fa.alias) ORDER BY fa.id)
          FROM food_aliases fa WHERE fa.food_id = f.id
        ) as aliases,
        (
          SELECT row_to_json(fn) FROM food_nutrition fn
          JOIN food_macros fm ON fm.nutrition_id = fn.id
          WHERE fm.food_id = f.id
          ORDER BY (fn.food_id = f.id) DESC, fn.id LIMIT 1
        ) as nutrition
      FROM foods f
      WHERE 1=1
    `;
    const params: any[] = [];

    if (category) {
      params.push(category);
      queryText += ` AND f.category = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      queryText += ` AND (f.name ILIKE $${params.length} OR f.description ILIKE $${params.length} OR f.barcode ILIKE $${params.length})`;
    }

    queryText += ' ORDER BY f.name ASC';

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
    res.status(500).json({ error: err.message });
  }
});

// 5b. Get a single food with its aliases + nutrition (same shape as the list).
app.get('/api/foods/:id', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT f.*,
         (SELECT json_agg(json_build_object('id', fa.id, 'alias', fa.alias) ORDER BY fa.id)
          FROM food_aliases fa WHERE fa.food_id = f.id) as aliases,
         (SELECT row_to_json(fn) FROM food_nutrition fn
          JOIN food_macros fm ON fm.nutrition_id = fn.id
          WHERE fm.food_id = f.id
          ORDER BY (fn.food_id = f.id) DESC, fn.id LIMIT 1) as nutrition
       FROM foods f WHERE f.id = $1`,
      [parseInt(req.params.id)]
    );
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
  const { store_id, price, is_sale, amount, amount_unit, source, image_id } = req.body;
  if (!store_id || price === undefined) {
    return res.status(400).json({ error: 'store_id and price are required' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Normalize to a price per base unit (per gram / ml / each) when the caller
    // supplies an amount + recognizable unit; otherwise leave unit_price null.
    const normalized = computeUnitPrice(Number(price), amount, amount_unit);
    const result = await client.query(
      `INSERT INTO price_logs (food_id, store_id, price, amount, amount_unit, unit_price, is_sale, source, image_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
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
    res.status(500).json({ error: err.message });
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
        WHERE pl.deleted_at IS NULL
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
      ORDER BY savings_percent DESC;
    `);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Price-log history, edit/delete, audit & revert ─────────────────────────

// Columns a client may edit on a price log.
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

    const updated = await client.query(
      `UPDATE price_logs
       SET store_id = $1, price = $2, amount = $3, amount_unit = $4,
           unit_price = $5, is_sale = $6, scraped_at = $7
       WHERE id = $8 RETURNING *`,
      [next.store_id, next.price, next.amount ?? null, next.amount_unit ?? null,
       next.unit_price, next.is_sale, next.scraped_at, id]
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
      const upd = await client.query(
        `UPDATE price_logs
         SET store_id = $1, price = $2, amount = $3, amount_unit = $4,
             unit_price = $5, is_sale = $6, scraped_at = $7, deleted_at = $8
         WHERE id = $9 RETURNING *`,
        [b.store_id, b.price, b.amount ?? null, b.amount_unit ?? null,
         b.unit_price ?? null, b.is_sale, b.scraped_at, b.deleted_at ?? null, entry.entity_id]
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
      // One images row per capture — links the photo to any price logs committed
      // from it, and carries EXIF GPS for store auto-location.
      const image = await registerImage(file);
      const insert = await db.query(
        `INSERT INTO scan_jobs (status, image_path, original_filename, store_id, image_id)
         VALUES ('queued', $1, $2, $3, $4) RETURNING *`,
        [file.path, file.originalname, storeId, image.id]
      );
      const row = insert.rows[0];
      await addOcrJob(row.id);
      created.push({ id: row.id, status: row.status, original_filename: row.original_filename });
    }
    res.status(201).json({ jobs: created });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 15. List scan jobs (inbox).
app.get('/api/scan-jobs', async (req: Request, res: Response) => {
  const { status } = req.query;
  try {
    const params: any[] = [];
    let where = "WHERE status <> 'discarded'";
    if (status) {
      params.push(status);
      where = `WHERE status = $${params.length}`;
    }
    const result = await db.query(
      `SELECT j.id, j.status, j.original_filename, j.store_id, s.name AS store_name,
              j.error, j.created_at, j.processed_at,
              CASE WHEN j.result IS NULL THEN NULL ELSE j.result->>'type' END AS result_type,
              CASE
                WHEN j.result IS NULL THEN 0
                WHEN j.result->>'type' = 'receipt' THEN jsonb_array_length(COALESCE(j.result->'data'->'items', '[]'::jsonb))
                WHEN j.result->>'type' = 'price_tag' THEN 1
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
app.get('/api/scan-jobs/:id', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT j.*, i.latitude, i.longitude
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

// ── Images (scan photo attachments) ─────────────────────────────────────────

// 20. Upload a single image (sync-scan path); returns id + EXIF GPS if present.
app.post('/api/images', upload.single('image'), async (req: Request, res: Response) => {
  const file = req.file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ error: 'No image uploaded (field name: image)' });
  try {
    const image = await registerImage(file);
    res.status(201).json(image);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
  try {
    const result = await db.query(
      `UPDATE foods SET
         name = COALESCE($1, name), category = COALESCE($2, category),
         unit = COALESCE($3, unit), description = COALESCE($4, description),
         barcode = COALESCE($5, barcode), usable_pct = COALESCE($6, usable_pct),
         density = COALESCE($8, density)
       WHERE id = $7 RETURNING *`,
      [name ?? null, category ?? null, unit ?? null, description ?? null, barcode ?? null,
       usable_pct != null ? Number(usable_pct) : null, parseInt(req.params.id),
       density != null ? Number(density) : null]
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

// ── Calorie tracking: nutrition facts, diary, goals ─────────────────────────

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

    const cols = ['food_id', 'serving_size', 'serving_unit', ...NUTRIENT_FIELDS, 'source'];
    const values = [foodId, serving_size, serving_unit,
      ...NUTRIENT_FIELDS.map(f => req.body[f] ?? null), source || 'manual'];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    // Update every column except food_id on conflict; refresh updated_at.
    const updates = cols.slice(1).map(c => `${c} = EXCLUDED.${c}`).concat('updated_at = now()').join(', ');

    const result = await db.query(
      `INSERT INTO food_nutrition (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (food_id) DO UPDATE SET ${updates}
       RETURNING *`,
      values
    );
    // Link the nutrition profile to this food in the many-to-many table.
    await db.query(
      'INSERT INTO food_macros (food_id, nutrition_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [foodId, result.rows[0].id]
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 30. Remove a food's nutrition facts. Unlinks the profile from this food; if
// the food owns the profile, deletes it (cascading its links). Diary snapshots
// are unaffected.
app.delete('/api/foods/:id/nutrition', async (req: Request, res: Response) => {
  const foodId = parseInt(req.params.id);
  try {
    await db.query('DELETE FROM food_macros WHERE food_id = $1', [foodId]);
    await db.query('DELETE FROM food_nutrition WHERE food_id = $1', [foodId]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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

    const cols = ['food_id', 'food_name', 'consumed_at', 'meal', 'amount', 'amount_unit', ...NUTRIENT_FIELDS, 'notes', 'source'];
    const values = [food_id ?? null, name, consumed_at ?? null, mealValue, amt, unit,
      ...NUTRIENT_FIELDS.map(f => nutrients[f]), notes ?? null, source || 'manual'];
    // consumed_at defaults to now() when the caller omits it.
    const placeholders = cols.map((c, i) => (c === 'consumed_at' ? `COALESCE($${i + 1}, now())` : `$${i + 1}`)).join(', ');
    const result = await client.query(
      `INSERT INTO consumption_logs (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    const row = result.rows[0];
    await recordAudit(client, { entityType: 'consumption_log', entityId: row.id, action: 'create', after: row });
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

// Start Express API server
app.listen(PORT, async () => {
  console.log(`Backend server running on port ${PORT}`);
  await db.initializeDatabase();
});
