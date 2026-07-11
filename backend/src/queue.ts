import { Queue } from 'bullmq';
import Redis from 'ioredis';
import * as dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Shared Redis connection for BullMQ
export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const scrapingQueueName = 'scraping-queue';

// Define the queue
export const scrapingQueue = new Queue(scrapingQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
  },
});

// Helper to push jobs. A scrape job targets a store's current Flipp flyers
// for a postal code; `query` narrows it to one search (omitted = match the
// whole food catalog against the flyers). `scrapeJobId` is the scrape_jobs row
// the worker updates with live progress.
export async function addScrapingJob(scrapeJobId: number, storeId: number, storeName: string, postalCode: string, query?: string) {
  try {
    const job = await scrapingQueue.add(`scrape-${storeName.toLowerCase()}-${storeId}`, {
      scrapeJobId,
      storeId,
      storeName,
      postalCode,
      query,
    });
    console.log(`Added scraping job ${job.id} for store ${storeName} (ID: ${storeId})`);
    return job;
  } catch (error) {
    console.error(`Failed to add scraping job for ${storeName}:`, error);
    throw error;
  }
}

// Push a cocowest.ca scrape job. Unlike Flipp there's no postal/merchant
// targeting — the whole post belongs to the one store the caller selected —
// so the payload just carries the post URL. Shares the same scraping-queue
// and worker concurrency; `source: 'cocowest'` is how worker.ts branches.
export async function addCocowestScrapeJob(scrapeJobId: number, storeId: number, storeName: string, url: string) {
  try {
    const job = await scrapingQueue.add(`cocowest-${storeName.toLowerCase()}-${storeId}`, {
      scrapeJobId,
      storeId,
      storeName,
      source: 'cocowest',
      url,
    });
    console.log(`Added cocowest scrape job ${job.id} for store ${storeName} (ID: ${storeId})`);
    return job;
  } catch (error) {
    console.error(`Failed to add cocowest scrape job for ${storeName}:`, error);
    throw error;
  }
}

export const ocrQueueName = 'ocr-queue';

// Background OCR queue: one job per uploaded image (scan_jobs row).
export const ocrQueue = new Queue(ocrQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
  },
});

export async function addOcrJob(scanJobId: number) {
  const job = await ocrQueue.add(`ocr-${scanJobId}`, { scanJobId });
  console.log(`Added OCR job ${job.id} for scan_job ${scanJobId}`);
  return job;
}
