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

// Helper to push jobs
export async function addScrapingJob(storeId: number, storeName: string, url: string) {
  try {
    const job = await scrapingQueue.add(`scrape-${storeName.toLowerCase()}-${storeId}`, {
      storeId,
      storeName,
      url,
    });
    console.log(`Added scraping job ${job.id} for store ${storeName} (ID: ${storeId})`);
    return job;
  } catch (error) {
    console.error(`Failed to add scraping job for ${storeName}:`, error);
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
