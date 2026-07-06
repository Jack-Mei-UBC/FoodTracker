import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/foodtracker';
const ocrServiceUrl = process.env.OCR_SERVICE_URL || 'http://ocr-service:8000';

const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

const pool = new Pool({
  connectionString: databaseUrl,
});

interface ScrapeJobData {
  storeId: number;
  storeName: string;
  url: string;
}

// Playwright Scraping Logic
async function scrapeStorePrices(storeId: number, storeName: string, url: string) {
  console.log(`Starting Playwright browser to scrape ${storeName} at ${url}...`);
  
  let browser;
  let itemsScraped: { name: string; price: number; isSale: boolean }[] = [];
  
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    });
    
    const page = await context.newPage();
    // Set a short timeout (15s) so background tasks don't hang indefinitely
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    // Heuristic: Wait for body
    await page.waitForSelector('body', { timeout: 5000 });
    
    // Evaluate page content to find product elements using common selectors
    itemsScraped = await page.evaluate(() => {
      const results: { name: string; price: number; isSale: boolean }[] = [];
      
      // Look for products using common class list keywords
      const selectors = [
        '[class*="product" i]', 
        '[class*="item" i]', 
        '[class*="tile" i]',
        'article', 
        'li'
      ];
      
      let elements: Element[] = [];
      for (const selector of selectors) {
        const found = Array.from(document.querySelectorAll(selector));
        if (found.length > 5) {
          elements = found;
          break;
        }
      }
      
      elements.forEach(el => {
        // Find product title / name
        const titleEl = el.querySelector('[class*="title" i], [class*="name" i], h2, h3, h4, [id*="title" i]');
        // Find price info
        const priceEl = el.querySelector('[class*="price" i], [id*="price" i], span, b');
        
        if (titleEl && priceEl) {
          const name = titleEl.textContent?.trim() || '';
          const priceText = priceEl.textContent?.trim() || '';
          
          // Regex extract price
          const priceMatch = priceText.match(/\$?(\d+(?:\.\d{2})?)/);
          if (name.length > 3 && priceMatch) {
            const priceVal = parseFloat(priceMatch[1]);
            const isSaleVal = priceText.toLowerCase().includes('sale') || priceText.toLowerCase().includes('discount');
            if (priceVal > 0 && priceVal < 500) {
              results.push({
                name,
                price: priceVal,
                isSale: isSaleVal,
              });
            }
          }
        }
      });
      
      return results.slice(0, 15); // limit to 15 items per scrape
    });
    
    console.log(`Successfully scraped ${itemsScraped.length} potential items from ${url}`);
  } catch (error: any) {
    console.error(`Scraping via Playwright failed or timed out: ${error.message}`);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  if (itemsScraped.length === 0) {
    throw new Error('Scraping completed but no items were found on the page.');
  }

  // Insert or update records in the DB
  for (const item of itemsScraped) {
    try {
      // 1. Try to match name with existing foods in DB
      const foodMatch = await pool.query(
        'SELECT id FROM foods WHERE name ILIKE $1 OR $1 ILIKE CONCAT(\'%\', name, \'%\') LIMIT 1',
        [item.name]
      );
      
      let foodId: number;
      
      if (foodMatch.rows.length > 0) {
        foodId = foodMatch.rows[0].id;
      } else {
        // If not found, insert a new food item
        const newFood = await pool.query(
          'INSERT INTO foods (name, category, unit) VALUES ($1, $2, $3) RETURNING id',
          [item.name, 'Scraped', 'each']
        );
        foodId = newFood.rows[0].id;
      }

      // 2. Insert new price log entry
      await pool.query(
        'INSERT INTO price_logs (food_id, store_id, price, unit_price, is_sale) VALUES ($1, $2, $3, $4, $5)',
        [foodId, storeId, item.price, item.price, item.isSale]
      );
      console.log(`Logged price $${item.price} for "${item.name}" at Store ID ${storeId}`);
    } catch (insertErr) {
      console.error(`Error saving scraped item "${item.name}":`, insertErr);
    }
  }
}

// Initialize BullMQ Worker
const worker = new Worker<ScrapeJobData>(
  'scraping-queue',
  async (job: Job<ScrapeJobData>) => {
    const { storeId, storeName, url } = job.data;
    console.log(`Processing scraping job ${job.id} for store ${storeName}...`);
    await scrapeStorePrices(storeId, storeName, url);
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

// Sends a stored image to the OCR service and stashes the structured result on
// the scan_jobs row for later review. Never auto-commits to the catalog.
async function processScanJob(scanJobId: number) {
  const jobRes = await pool.query('SELECT * FROM scan_jobs WHERE id = $1', [scanJobId]);
  if (jobRes.rows.length === 0) {
    throw new Error(`scan_job ${scanJobId} not found`);
  }
  const scanJob = jobRes.rows[0];
  await pool.query('UPDATE scan_jobs SET status = $1 WHERE id = $2', ['processing', scanJobId]);

  try {
    const buffer = fs.readFileSync(scanJob.image_path);
    const ext = path.extname(scanJob.image_path).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || 'image/jpeg';

    const form = new FormData();
    form.append('image', new Blob([buffer], { type: contentType }), scanJob.original_filename || 'capture.jpg');

    const res = await fetch(`${ocrServiceUrl}/scan`, { method: 'POST', body: form });
    const body = await res.json().catch(() => ({ error: 'non-JSON response from OCR service' }));

    if (!res.ok) {
      throw new Error(body.detail || body.error || `OCR service returned ${res.status}`);
    }

    await pool.query(
      'UPDATE scan_jobs SET status = $1, result = $2, processed_at = now(), error = NULL WHERE id = $3',
      ['done', JSON.stringify(body), scanJobId]
    );
    console.log(`Scan job ${scanJobId} done (type=${body.type}).`);
  } catch (err: any) {
    await pool.query(
      'UPDATE scan_jobs SET status = $1, error = $2, processed_at = now() WHERE id = $3',
      ['failed', String(err.message || err), scanJobId]
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
    concurrency: 1, // one image at a time; the free OCR model is slow/rate-limited
  }
);

ocrWorker.on('completed', (job) => console.log(`OCR job ${job.id} completed.`));
ocrWorker.on('failed', (job, err) => console.error(`OCR job ${job?.id} failed: ${err.message}`));

console.log('FoodTracker queue worker is running and listening for jobs...');
