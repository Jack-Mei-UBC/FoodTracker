import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { FlippItem, searchFlipp, usableItems, parseFlippAmount, nameMatchScore, flippItemUrl } from './flipp';
import { symmetricMatchScore, parseAmount } from './scrape-common';
import { fetchCocowestItems, usableCocowestItems } from './cocowest';
import { imageModelsFor, orderedModels, nextStartIndex, poolSize, maxAttempts, usePaidDefault } from './modelPool';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/foodtracker';
const ocrServiceUrl = process.env.OCR_SERVICE_URL || 'http://ocr-service:8000';
const backendUrl = process.env.BACKEND_URL || 'http://backend:4000';

const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

const pool = new Pool({
  connectionString: databaseUrl,
});

interface ScrapeJobData {
  scrapeJobId: number;
  storeId: number;
  storeName: string;
  source?: 'flipp' | 'cocowest'; // defaults to 'flipp' for back-compat with existing queued jobs
  postalCode?: string; // flipp only
  query?: string; // flipp only
  url?: string; // cocowest only — the post to scrape
}

// ── Flipp flyer scraper ─────────────────────────────────────────────────────
// Prices are written through the backend REST API (not direct SQL) so every
// scraped price gets unit normalization, its food_prices join row, and an
// audit entry — the same path every other price source takes.

async function backendApi(pathname: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${backendUrl}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Backend ${init?.method || 'GET'} ${pathname} failed (${res.status}): ${body.error || 'unknown error'}`);
  }
  return body;
}

// ── Scrape progress tracking (scrape_jobs row) ──────────────────────────────
// Progress bookkeeping is the worker's own state, so — like the OCR path's
// scan_jobs updates — it writes straight to Postgres. Prices still go through the
// backend API so they keep normalization / the food_prices join / audit.

async function updateScrapeJob(id: number, fields: Record<string, any>) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE scrape_jobs SET ${set}, updated_at = now() WHERE id = $1`,
    [id, ...keys.map((k) => fields[k])]
  );
}

// One detail record per logged price, appended atomically so concurrent-safe
// even though we process one job at a time.
async function appendScrapeItem(id: number, item: Record<string, any>) {
  await pool.query(
    `UPDATE scrape_jobs
        SET items = items || $2::jsonb, logged = logged + 1, updated_at = now()
      WHERE id = $1`,
    [id, JSON.stringify([item])]
  );
}

// Download a Flipp flyer image and register it as an images row via the backend
// (multipart, same path a photo upload takes) so it gets served by GET
// /api/images/:id and can be attached to the price log. Best-effort: a failed
// image fetch must never fail the whole scrape, so this returns null on error.
async function saveFlyerImage(url: string | null | undefined): Promise<number | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
    const form = new FormData();
    form.append('image', new Blob([buf], { type: contentType }), `flyer${ext}`);
    const up = await fetch(`${backendUrl}/api/images`, { method: 'POST', body: form });
    if (!up.ok) return null;
    const body = await up.json();
    return body.id ?? null;
  } catch {
    return null;
  }
}

interface CatalogEntry {
  id: number;
  names: string[]; // primary name first, then aliases
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Keep catalog-wide scrapes polite: one Flipp search per food, rate-limited,
// and capped so a huge catalog can't turn one job into hundreds of requests.
const FLIPP_SEARCH_DELAY_MS = 400;
const CATALOG_SEARCH_CAP = 50;
const QUERY_MODE_ITEM_CAP = 15;
// Query mode decides identity (is this flyer item an existing food?) with the
// symmetric score; catalog mode only needs the food's own words covered, so it
// uses the recall score but demands most of them.
const QUERY_MATCH_THRESHOLD = 0.5;
const CATALOG_MATCH_THRESHOLD = 0.6;

function bestCatalogMatch(catalog: CatalogEntry[], itemName: string): { entry: CatalogEntry; score: number } | null {
  let best: { entry: CatalogEntry; score: number } | null = null;
  for (const entry of catalog) {
    for (const name of entry.names) {
      const score = symmetricMatchScore(name, itemName);
      if (!best || score > best.score) best = { entry, score };
    }
  }
  return best;
}

async function scrapeFlippFlyers(scrapeJobId: number, storeId: number, storeName: string, postalCode: string, query?: string) {
  console.log(`Scraping Flipp flyers for "${storeName}" (postal ${postalCode}${query ? `, query "${query}"` : ', full catalog'})...`);
  await updateScrapeJob(scrapeJobId, { status: 'processing', phase: 'Loading catalog' });

  const foods: any[] = await backendApi('/api/foods');
  const catalog: CatalogEntry[] = foods.map((f) => ({
    id: f.id,
    names: [f.name, ...((f.aliases || []) as any[]).map((a) => a.alias)].filter(Boolean),
  }));

  const loggedFlyerItems = new Set<number>();
  let logged = 0;

  // Log one price and record its source flyer image + deep link on the scrape job.
  const logPrice = async (foodId: number, foodName: string, item: FlippItem, isNew: boolean) => {
    const parsed = parseFlippAmount(item);
    const price = Number(item.current_price);
    // Save the flyer artwork first so the price log can point at it.
    const imageId = await saveFlyerImage(item.clipping_image_url || item.clean_image_url);
    await backendApi(`/api/foods/${foodId}/prices`, {
      method: 'POST',
      body: JSON.stringify({
        store_id: storeId,
        price,
        amount: parsed.amount,
        amount_unit: parsed.unit,
        is_sale: parsed.multiBuy || item.original_price != null || !!item.sale_story,
        // The flyer states when the deal stops — far better than the app's
        // default duration guess, so pass it through as the sale expiry.
        sale_ends_at: item.valid_to ? String(item.valid_to).slice(0, 10) : null,
        source: 'scraper',
        image_id: imageId,
      }),
    });
    loggedFlyerItems.add(item.flyer_item_id ?? item.id ?? -1);
    logged++;
    await appendScrapeItem(scrapeJobId, {
      food_id: foodId,
      food_name: foodName,
      is_new_food: isNew,
      flyer_name: item.name,
      price,
      amount: parsed.amount,
      amount_unit: parsed.unit,
      is_sale: parsed.multiBuy || item.original_price != null || !!item.sale_story,
      image_id: imageId,
      flyer_url: flippItemUrl(item),
      valid_to: item.valid_to ?? null,
      logged_at: new Date().toISOString(),
    });
    console.log(`Logged $${price} (${parsed.amount} ${parsed.unit}) for "${item.name}" [food ${foodId}${imageId ? `, img ${imageId}` : ''}]`);
  };

  if (query) {
    // Query mode: one search; log every matching deal at this store, creating
    // catalog entries for items we don't track yet. The same deal often runs
    // in several concurrent flyers — log each product once per scrape.
    await updateScrapeJob(scrapeJobId, { phase: `Searching flyers for "${query}"` });
    const items = usableItems(await searchFlipp(postalCode, query), storeName).slice(0, QUERY_MODE_ITEM_CAP);
    await updateScrapeJob(scrapeJobId, { total: items.length, processed: 0, phase: `Matching ${items.length} deal(s)` });
    const seenNames = new Set<string>();
    let processed = 0;
    for (const item of items) {
      const itemName = item.name!.replace(/\s+/g, ' ').trim().slice(0, 255);
      const nameKey = itemName.toLowerCase();
      if (seenNames.has(nameKey)) { await updateScrapeJob(scrapeJobId, { processed: ++processed }); continue; }
      seenNames.add(nameKey);
      const best = bestCatalogMatch(catalog, itemName);
      let foodId: number;
      let foodName: string;
      let isNew = false;
      if (best && best.score >= QUERY_MATCH_THRESHOLD) {
        foodId = best.entry.id;
        foodName = best.entry.names[0];
      } else {
        const parsed = parseFlippAmount(item);
        const created = await backendApi('/api/foods', {
          method: 'POST',
          body: JSON.stringify({ name: itemName, category: 'Scraped', unit: parsed.unit }),
        });
        foodId = created.id;
        foodName = itemName;
        isNew = true;
        catalog.push({ id: created.id, names: [itemName] });
      }
      await logPrice(foodId, foodName, item, isNew);
      await updateScrapeJob(scrapeJobId, { processed: ++processed });
    }
  } else {
    // Catalog mode: search Flipp once per tracked food and log the single
    // best-matching current deal at this store.
    const searchList = catalog.slice(0, CATALOG_SEARCH_CAP);
    await updateScrapeJob(scrapeJobId, { total: searchList.length, processed: 0, phase: `Scanning ${searchList.length} tracked food(s)` });
    let processed = 0;
    for (const entry of searchList) {
      await updateScrapeJob(scrapeJobId, { phase: `Searching "${entry.names[0]}"` });
      let items: FlippItem[];
      try {
        items = usableItems(await searchFlipp(postalCode, entry.names[0]), storeName);
      } catch (err: any) {
        console.error(`Flipp search failed for "${entry.names[0]}": ${err.message}`);
        await updateScrapeJob(scrapeJobId, { processed: ++processed });
        continue;
      }
      let bestItem: FlippItem | null = null;
      let bestScore = 0;
      for (const item of items) {
        if (loggedFlyerItems.has(item.flyer_item_id ?? item.id ?? -1)) continue;
        const score = Math.max(...entry.names.map((n) => nameMatchScore(n, item.name!)));
        if (score > bestScore) {
          bestScore = score;
          bestItem = item;
        }
      }
      if (bestItem && bestScore >= CATALOG_MATCH_THRESHOLD) {
        await logPrice(entry.id, entry.names[0], bestItem, false);
      }
      await updateScrapeJob(scrapeJobId, { processed: ++processed });
      await sleep(FLIPP_SEARCH_DELAY_MS);
    }
    if (catalog.length > CATALOG_SEARCH_CAP) {
      console.log(`Catalog has ${catalog.length} foods; searched the first ${CATALOG_SEARCH_CAP}.`);
    }
  }

  if (logged === 0) {
    throw new Error(
      `No current flyer deals matched at "${storeName}". The store name must resemble a Flipp merchant ` +
      `(e.g. "Walmart", "Save-On-Foods") with an active flyer for postal code ${postalCode}.`
    );
  }
  await updateScrapeJob(scrapeJobId, { status: 'done', phase: `Logged ${logged} price(s)`, finished_at: new Date() });
  console.log(`Flipp scrape done: logged ${logged} prices for ${storeName}.`);
}

// ── cocowest.ca Costco sale-post scraper ────────────────────────────────────
// A cocowest.ca "weekend update" post has no per-store/postal targeting — the
// whole post belongs to one store (the "Costco" store the caller selected).
// Mirrors Flipp's *query mode*: log a price for every parseable item,
// creating a food (category 'Costco') for anything that doesn't match the
// catalog, since this scope is meant to capture the full sale list.
async function scrapeCocowest(scrapeJobId: number, storeId: number, storeName: string, url: string) {
  console.log(`Scraping cocowest.ca post for "${storeName}": ${url}`);
  await updateScrapeJob(scrapeJobId, { status: 'processing', phase: 'Fetching cocowest post' });

  const foods: any[] = await backendApi('/api/foods');
  const catalog: CatalogEntry[] = foods.map((f) => ({
    id: f.id,
    names: [f.name, ...((f.aliases || []) as any[]).map((a) => a.alias)].filter(Boolean),
  }));

  const items = usableCocowestItems(await fetchCocowestItems(url));
  await updateScrapeJob(scrapeJobId, { total: items.length, processed: 0, phase: `Matching ${items.length} item(s)` });

  let logged = 0;
  let processed = 0;
  for (const item of items) {
    const itemName = item.name.replace(/\s+/g, ' ').trim().slice(0, 255);
    const parsed = parseAmount(itemName);
    const best = bestCatalogMatch(catalog, itemName);
    let foodId: number;
    let foodName: string;
    let isNew = false;
    if (best && best.score >= QUERY_MATCH_THRESHOLD) {
      foodId = best.entry.id;
      foodName = best.entry.names[0];
    } else {
      const created = await backendApi('/api/foods', {
        method: 'POST',
        body: JSON.stringify({ name: itemName, category: 'Costco', unit: parsed.unit }),
      });
      foodId = created.id;
      foodName = itemName;
      isNew = true;
      catalog.push({ id: created.id, names: [itemName] });
    }

    const imageId = await saveFlyerImage(item.image_url);
    const isSale = item.savings != null;
    await backendApi(`/api/foods/${foodId}/prices`, {
      method: 'POST',
      body: JSON.stringify({
        store_id: storeId,
        price: item.price,
        amount: parsed.amount,
        amount_unit: parsed.unit,
        is_sale: isSale,
        // cocowest posts print "EXPIRES ON <date>" per item — same reasoning as
        // the Flipp path: a stated end date beats the default duration guess.
        sale_ends_at: item.expires_on ? String(item.expires_on).slice(0, 10) : null,
        source: 'scraper',
        image_id: imageId,
      }),
    });
    logged++;
    await appendScrapeItem(scrapeJobId, {
      food_id: foodId,
      food_name: foodName,
      is_new_food: isNew,
      flyer_name: item.name,
      price: item.price,
      amount: parsed.amount,
      amount_unit: parsed.unit,
      is_sale: isSale,
      image_id: imageId,
      flyer_url: item.page_url,
      valid_to: item.expires_on ?? null,
      logged_at: new Date().toISOString(),
    });
    console.log(`Logged $${item.price} (${parsed.amount} ${parsed.unit}) for "${item.name}" [food ${foodId}${imageId ? `, img ${imageId}` : ''}]`);
    await updateScrapeJob(scrapeJobId, { processed: ++processed });
  }

  if (logged === 0) {
    throw new Error(`No sale items could be parsed from the cocowest post: ${url}`);
  }
  await updateScrapeJob(scrapeJobId, { status: 'done', phase: `Logged ${logged} price(s)`, finished_at: new Date() });
  console.log(`cocowest scrape done: logged ${logged} prices for ${storeName}.`);
}

// Initialize BullMQ Worker
const worker = new Worker<ScrapeJobData>(
  'scraping-queue',
  async (job: Job<ScrapeJobData>) => {
    const { scrapeJobId, storeId, storeName, source, postalCode, query, url } = job.data;
    console.log(`Processing scraping job ${job.id} for store ${storeName} (source: ${source || 'flipp'})...`);
    try {
      if (source === 'cocowest') {
        await scrapeCocowest(scrapeJobId, storeId, storeName, url!);
      } else {
        await scrapeFlippFlyers(scrapeJobId, storeId, storeName, postalCode!, query);
      }
    } catch (err: any) {
      // Surface the failure on the scrape_jobs row so the progress UI shows why.
      // BullMQ may retry; keep status 'failed' until a retry re-sets 'processing'.
      await updateScrapeJob(scrapeJobId, {
        status: 'failed',
        phase: 'Failed',
        error: String(err?.message || err),
        finished_at: new Date(),
      }).catch(() => {});
      throw err;
    }
  },
  {
    connection: redisConnection,
    concurrency: 1, // process jobs sequentially to be polite to target servers
  }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed successfully.`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed with error: ${err.message}`);
});

// ── Background OCR worker ───────────────────────────────────────────────────
interface OcrJobData {
  scanJobId: number;
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};

// Tag names currently in the catalog, fetched once per scan job for the
// scan_runs history record (see recordScanRun). Best-effort: a backend hiccup
// must not fail the scan, so this returns null rather than throwing.
async function fetchTagVocab(): Promise<string[] | null> {
  try {
    const tags = await backendApi('/api/tags');
    return Array.isArray(tags) ? tags.map((t: any) => t.name).filter(Boolean) : null;
  } catch {
    return null;
  }
}

// How many product lines a scan result carries — drives the quality gate below.
// Items in ONE capture's data. receipt/price_tag/barcode all carry items[];
// price_tag additionally tolerates the pre-multi-tag flat shape (one bare tag
// object instead of items[]), counted as 1 so a legacy row isn't rejected as
// "0 items" by the quality gate below.
function captureItemCount(capture: any): number {
  if (!capture || typeof capture !== 'object') return 0;
  const data = capture.data;
  if (Array.isArray(data?.items)) return data.items.length;
  if (capture.type === 'price_tag' && data?.name) return 1;
  return 0;
}

// How many product lines a scan result carries — drives the quality gate below.
// Sums across every capture (a mixed photo's receipt + price_tag regions both
// count) when `captures` is present; falls back to the pre-captures single-type
// shape for scan_jobs.result rows written before that field existed.
function resultItemCount(body: any): number {
  if (!body || typeof body !== 'object') return 0;
  if (Array.isArray(body.captures) && body.captures.length > 0) {
    return body.captures.reduce((sum: number, c: any) => sum + captureItemCount(c), 0);
  }
  if (body.type === 'receipt') return Array.isArray(body?.data?.items) ? body.data.items.length : 0;
  // price_tag carries items[] (a shelf photo can show several tags). Rows/models
  // predating that returned ONE flat tag — count it as 1 so the quality gate
  // below doesn't reject a perfectly good legacy-shaped result as "0 items".
  if (body.type === 'price_tag') {
    if (Array.isArray(body?.data?.items)) return body.data.items.length;
    return body?.data?.name ? 1 : 0;
  }
  if (body.type === 'barcode') return Array.isArray(body?.data?.items) ? body.data.items.length : 0;
  return 0;
}

// A result is "acceptable" if the model actually recognized the capture and got
// at least one item out of it. An `unknown` (flaky/refused) result is not.
function isAcceptable(body: any): boolean {
  return !!body && body.type && body.type !== 'unknown' && resultItemCount(body) >= 1;
}

// Rank results so that, if NO model produces an acceptable one, we still keep the
// best-effort output (recognized type > more items > higher confidence). This is
// what reaches /inbox — its raw_text lets the user copy-paste / enter manually.
function scoreResult(body: any): number {
  if (!body || typeof body !== 'object') return -1;
  const recognized = body.type && body.type !== 'unknown' ? 1000 : 0;
  return recognized + resultItemCount(body) * 10 + (Number(body.confidence) || 0);
}

// One record per model tried, persisted to scan_jobs.attempts so the inbox can
// show what EVERY model read — `result` keeps only the best single body, and the
// discarded ones often contain the text a failed scan actually needs.
interface ScanAttempt {
  model: string;
  ok: boolean;          // did the call return a usable body at all
  type?: string | null; // receipt | price_tag | unknown
  item_count?: number;
  confidence?: number | null;
  raw_text?: string | null;
  error?: string;       // network/HTTP failure detail (ok: false)
}

// Appends one row to scan_runs for a single model call — never updated except
// for the was_winner flip after the whole scan finishes. This is the durable,
// non-destructive history that scan_jobs.result/attempts (overwritten on every
// run and cleared on restage) can't provide; it's what lets a scan be
// re-processed later without losing what earlier calls read. Direct pg write,
// like the rest of this file's bookkeeping — not the audited backend API.
async function recordScanRun(opts: {
  scanJobId: number;
  imageId: number | null;
  model: string;
  usePaid: boolean;
  tagsVocab: string[] | null;
  ok: boolean;
  captureType: string | null;
  itemCount: number | null;
  confidence: number | null;
  response: any | null;
  rawText: string | null;
  error: string | null;
  startedAt: Date;
  durationMs: number;
}): Promise<number> {
  const res = await pool.query(
    `INSERT INTO scan_runs
       (scan_job_id, image_id, model, use_paid, prompt_version, tags_vocab, ok,
        capture_type, item_count, confidence, response, raw_text, error,
        duration_ms, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      opts.scanJobId, opts.imageId, opts.model, opts.usePaid,
      opts.response?.prompt_version ?? null,
      opts.tagsVocab ? JSON.stringify(opts.tagsVocab) : null,
      opts.ok, opts.captureType, opts.itemCount, opts.confidence,
      opts.response ? JSON.stringify(opts.response) : null, opts.rawText, opts.error,
      opts.durationMs, opts.startedAt,
    ]
  );
  return res.rows[0].id;
}

// One OCR call against one model. Always returns an attempt record; `body` is
// null on a network/HTTP failure (so the caller can rotate to the next model)
// and the reason is kept on the record rather than swallowed. The image bytes
// are read once by the caller and reused across retries. Every call — success
// or failure — also lands a row in scan_runs (see recordScanRun) so it survives
// a later restage/reprocess that would otherwise overwrite scan_jobs.attempts.
async function ocrOnce(
  scanJob: any,
  image: { bytes: Uint8Array<ArrayBuffer>; contentType: string },
  model: string,
  runCtx: { usePaid: boolean; tagsVocab: string[] | null }
): Promise<{ body: any | null; attempt: ScanAttempt; runId: number }> {
  const form = new FormData();
  // Uint8Array (not a raw Buffer) is the valid BlobPart under current @types/node.
  form.append('image', new Blob([image.bytes], { type: image.contentType }), scanJob.original_filename || 'capture.jpg');
  form.append('model', model);
  if (runCtx.tagsVocab && runCtx.tagsVocab.length > 0) {
    form.append('tags', runCtx.tagsVocab.join(','));
  }

  const startedAt = new Date();
  const t0 = Date.now();

  try {
    const res = await fetch(`${ocrServiceUrl}/scan`, { method: 'POST', body: form });
    const body = await res.json().catch(() => null);
    const durationMs = Date.now() - t0;
    if (!res.ok || body == null) {
      const detail = body?.detail || body?.error || 'no detail';
      console.warn(`OCR job ${scanJob.id}: model "${model}" returned ${res.status} (${detail})`);
      const error = `HTTP ${res.status}: ${detail}`;
      const runId = await recordScanRun({
        scanJobId: scanJob.id, imageId: scanJob.image_id ?? null, model, usePaid: runCtx.usePaid,
        tagsVocab: runCtx.tagsVocab, ok: false, captureType: null, itemCount: null, confidence: null,
        response: null, rawText: null, error, startedAt, durationMs,
      });
      return { body: null, attempt: { model, ok: false, error }, runId };
    }
    const runId = await recordScanRun({
      scanJobId: scanJob.id, imageId: scanJob.image_id ?? null, model, usePaid: runCtx.usePaid,
      tagsVocab: runCtx.tagsVocab, ok: true, captureType: body.type ?? null,
      itemCount: resultItemCount(body), confidence: body.confidence ?? null,
      response: body, rawText: body.raw_text ?? null, error: null, startedAt, durationMs,
    });
    return {
      body,
      attempt: {
        model,
        ok: true,
        type: body.type ?? null,
        item_count: resultItemCount(body),
        confidence: body.confidence ?? null,
        raw_text: body.raw_text ?? null,
      },
      runId,
    };
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    const message = String(err?.message || err);
    console.warn(`OCR job ${scanJob.id}: model "${model}" errored: ${message}`);
    const runId = await recordScanRun({
      scanJobId: scanJob.id, imageId: scanJob.image_id ?? null, model, usePaid: runCtx.usePaid,
      tagsVocab: runCtx.tagsVocab, ok: false, captureType: null, itemCount: null, confidence: null,
      response: null, rawText: null, error: message, startedAt, durationMs,
    });
    return { body: null, attempt: { model, ok: false, error: message }, runId };
  }
}

// Sends a stored image to the OCR service and stashes the structured result on
// the scan_jobs row for later review. Never auto-commits to the catalog.
//
// Multi-model: this scan cycles through its model list (see modelPool.ts) up to
// OCR_MAX_ATTEMPTS times, accepting the first ACCEPTABLE result and otherwise
// keeping the best-effort one. Parallelism across scans comes from the worker's
// concurrency (poolSize), so different scans run on different models at once.
async function processScanJob(scanJobId: number) {
  const jobRes = await pool.query('SELECT * FROM scan_jobs WHERE id = $1', [scanJobId]);
  if (jobRes.rows.length === 0) {
    throw new Error(`scan_job ${scanJobId} not found`);
  }
  const scanJob = jobRes.rows[0];
  await pool.query('UPDATE scan_jobs SET status = $1 WHERE id = $2', ['processing', scanJobId]);

  // Collected across every model tried and written on BOTH exit paths below, so
  // a job that fails outright still lands in the inbox with a diagnostic trace.
  const attempts: ScanAttempt[] = [];

  try {
    // Read the image bytes once and reuse them across every model attempt.
    const ext = path.extname(scanJob.image_path).toLowerCase();
    const image = { bytes: Uint8Array.from(fs.readFileSync(scanJob.image_path)), contentType: CONTENT_TYPES[ext] || 'image/jpeg' };

    const usePaid = !!scanJob.use_paid || usePaidDefault();
    const models = orderedModels(imageModelsFor(usePaid), nextStartIndex());
    const attemptCount = Math.min(maxAttempts(), models.length);

    // Tag vocabulary offered to the model, captured per-run so scan_runs history
    // reflects what was actually available at call time (the list drifts as tags
    // are added/removed). Not yet threaded into the OCR prompt itself — that's
    // the tag-injection phase — this only records it for future re-processing.
    const tagsVocab = await fetchTagVocab();
    const runCtx = { usePaid, tagsVocab };

    let best: any = null;
    let bestScore = -1;
    let bestRunId: number | null = null;
    let accepted: any = null;
    let acceptedRunId: number | null = null;

    for (let i = 0; i < attemptCount; i++) {
      const model = models[i];
      const { body, attempt, runId } = await ocrOnce(scanJob, image, model, runCtx);
      attempts.push(attempt);
      if (body == null) continue; // network/HTTP failure — try the next model
      if (isAcceptable(body)) { accepted = body; acceptedRunId = runId; break; }
      const score = scoreResult(body);
      if (score > bestScore) { bestScore = score; best = body; bestRunId = runId; }
    }

    const result = accepted ?? best;
    if (result == null) {
      // Every attempt was a hard failure (all models unreachable / non-JSON).
      throw new Error(`OCR failed on all ${attemptCount} model attempt(s)`);
    }

    const winnerRunId = acceptedRunId ?? bestRunId;
    if (winnerRunId != null) {
      await pool.query('UPDATE scan_runs SET was_winner = true WHERE id = $1', [winnerRunId]);
    }

    await pool.query(
      'UPDATE scan_jobs SET status = $1, result = $2, attempts = $3, processed_at = now(), error = NULL WHERE id = $4',
      ['done', JSON.stringify(result), JSON.stringify(attempts), scanJobId]
    );
    console.log(`Scan job ${scanJobId} done (type=${result.type}, model=${result.model}, accepted=${!!accepted}).`);
  } catch (err: any) {
    await pool.query(
      'UPDATE scan_jobs SET status = $1, error = $2, attempts = $3, processed_at = now() WHERE id = $4',
      ['failed', String(err.message || err), JSON.stringify(attempts), scanJobId]
    );
    throw err;
  }
}

const ocrWorker = new Worker<OcrJobData>(
  'ocr-queue',
  async (job: Job<OcrJobData>) => {
    console.log(`Processing OCR job ${job.id} for scan_job ${job.data.scanJobId}...`);
    await processScanJob(job.data.scanJobId);
  },
  {
    connection: redisConnection,
    // Run as many scans in parallel as there are models in the pool, so every
    // (slow) free model stays busy on a DIFFERENT scan. Round-robin assignment
    // in modelPool.ts keeps concurrent jobs on distinct models (≤1 request per
    // model at a time, respecting per-model rate limits).
    concurrency: poolSize(),
  }
);

ocrWorker.on('completed', (job) => console.log(`OCR job ${job.id} completed.`));
ocrWorker.on('failed', (job, err) => console.error(`OCR job ${job?.id} failed: ${err.message}`));

console.log('FoodTracker queue worker is running and listening for jobs...');
