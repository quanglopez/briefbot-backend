import { Router } from 'express';
import { z } from 'zod';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { BaseScraper } from '../services/scrapers/base.scraper.js';
import { TikTokScraper } from '../services/scrapers/tiktok.scraper.js';
import { FacebookScraper } from '../services/scrapers/facebook.scraper.js';
import { ShopeeScraper } from '../services/scrapers/shopee.scraper.js';
import type { ScraperPlatform } from '../types/scraper.types.js';
import { scrapeJobsQueue } from '../services/queue/queue.manager.js';
import { getSupabase } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { rateLimitPerUser } from '../middleware/rate-limit.middleware.js';
import { trackScrapeUsage } from '../middleware/usage.middleware.js';
import { catchAsync } from '../utils/catch-async.js';
import { AppError } from '../utils/errors.js';

const router = Router();

const scrapeStartBodySchema = z.object({
  projectId: z.string().uuid(),
  platform: z.enum(['tiktok', 'facebook', 'shopee']),
  keywords: z.array(z.string().min(1)),
  maxVideos: z.number().int().min(10).max(100),
  dateRangeStart: z.string().datetime().optional(),
  dateRangeEnd: z.string().datetime().optional(),
  minViews: z.number().int().min(0).optional(),
});

const scraperFactories: Record<ScraperPlatform, (browser: Browser) => BaseScraper> = {
  tiktok: (b) => new TikTokScraper(b),
  facebook: (b) => new FacebookScraper(b),
  shopee: (b) => new ShopeeScraper(b),
};

const directScrapeBodySchema = z.object({
  platform: z.enum(['tiktok', 'facebook', 'shopee']),
  keywords: z.array(z.string().min(1)),
  maxVideos: z.number().int().min(10).max(100),
  dateRangeStart: z.coerce.date().optional(),
  dateRangeEnd: z.coerce.date().optional(),
  minViews: z.number().int().min(0).optional(),
  language: z.string().optional(),
  region: z.string().optional(),
});

router.use(requireAuth, rateLimitPerUser, trackScrapeUsage);

/** POST /api/scrape/start — queue scrape job, return jobId */
router.post(
  '/start',
  catchAsync(async (req, res) => {
    const parsed = scrapeStartBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('Invalid body', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: parsed.error.issues,
      });
    }
    const userId = req.user!.id;
    const payload = { ...parsed.data, userId };
    const job = await scrapeJobsQueue.add('scrape', payload);
    res.status(202).json({ success: true, data: { jobId: job.id } });
  })
);

/** GET /api/scrape/status/:jobId — job status + progress */
router.get(
  '/status/:jobId',
  catchAsync(async (req, res) => {
    const { jobId } = req.params;
    const job = await scrapeJobsQueue.getJob(jobId);
    if (!job) {
      throw new AppError('Job not found', {
        code: 'JOB_NOT_FOUND',
        statusCode: 404,
      });
    }
    if (job.data.userId !== req.user!.id) {
      throw new AppError('Forbidden', {
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    }
    const state = await job.getState();
    res.json({
      success: true,
      data: {
        jobId: job.id,
        status: state,
        progress: job.progress,
        data: state === 'failed' ? undefined : job.data,
        failedReason: job.failedReason ?? undefined,
      },
    });
  })
);

/** GET /api/scrape/project/:projectId — all scrape results for project */
router.get(
  '/project/:projectId',
  catchAsync(async (req, res) => {
    const { projectId } = req.params;
    const userId = req.user!.id;
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('videos')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', userId);
    if (error) {
      throw new AppError('Failed to load videos', {
        code: 'VIDEOS_LOAD_FAILED',
        statusCode: 500,
        details: error,
      });
    }
    res.json({ success: true, data: { videos: data ?? [] } });
  })
);

/** POST /api/scrape/cancel/:jobId — cancel job if waiting/delayed */
router.post(
  '/cancel/:jobId',
  catchAsync(async (req, res) => {
    const { jobId } = req.params;
    const job = await scrapeJobsQueue.getJob(jobId);
    if (!job) {
      throw new AppError('Job not found', {
        code: 'JOB_NOT_FOUND',
        statusCode: 404,
      });
    }
    if (job.data.userId !== req.user!.id) {
      throw new AppError('Forbidden', {
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    }
    const state = await job.getState();
    if (state === 'active' || state === 'completed') {
      throw new AppError(state === 'active' ? 'Cannot cancel running job' : 'Job already completed', {
        code: 'JOB_CANCEL_UNAVAILABLE',
        statusCode: 400,
      });
    }
    await job.remove();
    res.json({ success: true, data: { cancelled: true, jobId } });
  })
);

/** POST /api/scrape — direct scrape (no queue), for backward compatibility */
router.post(
  '/',
  catchAsync(async (req, res) => {
    let browser: Browser | null = null;
    try {
      const parsed = directScrapeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('Invalid body', {
          code: 'VALIDATION_ERROR',
          statusCode: 400,
          details: parsed.error.issues,
        });
      }
      const request = {
        ...parsed.data,
        language: parsed.data.language ?? 'vi',
        region: parsed.data.region ?? 'VN',
      };
      browser = await chromium.launch({ headless: true });
      const scraper = scraperFactories[request.platform](browser);
      const result = await scraper.scrape(request);
      res.json({ success: true, data: result });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  })
);

export default router;

