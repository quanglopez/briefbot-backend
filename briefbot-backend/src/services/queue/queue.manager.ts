import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { env } from '../../config/env.js';
import type { ScrapeJob, AnalyzeJob } from '../../types/queue.types.js';

const connection: ConnectionOptions = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy(times: number): number {
    return Math.min(times * 500, 10000);
  },
};

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1000,
  },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 200 },
};

const defaultWorkerConcurrency = 3;

export const scrapeJobsQueue = new Queue<ScrapeJob>('scrape-jobs', {
  connection,
  defaultJobOptions,
});

export const analyzeJobsQueue = new Queue<AnalyzeJob>('analyze-jobs', {
  connection,
  defaultJobOptions,
});

export function getConnection(): ConnectionOptions {
  return connection;
}

export function getDefaultWorkerConcurrency(): number {
  return defaultWorkerConcurrency;
}

export function getDefaultJobOptions(): typeof defaultJobOptions {
  return defaultJobOptions;
}

export type ScrapeJobInstance = Job<ScrapeJob, void, string>;
export type AnalyzeJobInstance = Job<AnalyzeJob, void, string>;

export function createScrapeWorker(
  processor: (job: ScrapeJobInstance) => Promise<void>
): Worker<ScrapeJob, void, string> {
  return new Worker<ScrapeJob, void, string>('scrape-jobs', processor, {
    connection,
    concurrency: defaultWorkerConcurrency,
  });
}

export function createAnalyzeWorker(
  processor: (job: AnalyzeJobInstance) => Promise<void>
): Worker<AnalyzeJob, void, string> {
  return new Worker<AnalyzeJob, void, string>('analyze-jobs', processor, {
    connection,
    concurrency: defaultWorkerConcurrency,
  });
}
