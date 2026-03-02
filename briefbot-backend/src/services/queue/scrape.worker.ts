import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import {
  createScrapeWorker,
  analyzeJobsQueue,
  type ScrapeJobInstance,
} from './queue.manager.js';
import { getSupabase } from '../../config/supabase.js';
import { getNextProxy } from '../../utils/proxy-manager.js';
import { TikTokScraper } from '../scrapers/tiktok.scraper.js';
import { FacebookScraper } from '../scrapers/facebook.scraper.js';
import { ShopeeScraper } from '../scrapers/shopee.scraper.js';
import type { ScraperPlatform } from '../../types/scraper.types.js';
import type { ScrapeRequest, ScrapedVideo } from '../../types/scraper.types.js';
import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';

export const scrapeJobEvents = new EventEmitter();
scrapeJobEvents.setMaxListeners(50);

function getScraper(browser: Browser, platform: ScraperPlatform) {
  switch (platform) {
    case 'tiktok':
      return new TikTokScraper(browser);
    case 'facebook':
      return new FacebookScraper(browser);
    case 'shopee':
      return new ShopeeScraper(browser);
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

function toVideoRow(v: ScrapedVideo, projectId: string, userId: string) {
  return {
    project_id: projectId,
    user_id: userId,
    platform: v.platform,
    video_url: v.videoUrl,
    thumbnail_url: v.thumbnailUrl,
    caption: v.caption,
    hashtags: v.hashtags,
    views: v.views,
    likes: v.likes,
    comments_count: v.commentsCount,
    shares: v.shares,
    engagement_rate: v.engagementRate,
    creator_name: v.creatorName,
    creator_followers: v.creatorFollowers,
    posted_at: v.postedAt?.toISOString() ?? null,
    raw_comments: v.rawComments,
    product_name: v.product_name ?? null,
    product_price: v.product_price ?? null,
    product_rating: v.product_rating ?? null,
    product_sold: v.product_sold ?? null,
    shop_rating: v.shop_rating ?? null,
  };
}

export function startScrapeWorker(): void {
  const worker = createScrapeWorker(async (job: ScrapeJobInstance) => {
    const data = job.data;
    const jobId = job.id ?? '';
    scrapeJobEvents.emit('scrape:started', { jobId, data });

    await job.updateProgress(0);

    const proxyUrl = getNextProxy();
    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: true,
      ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    };
    const browser = await chromium.launch(launchOptions);

    try {
      const request: ScrapeRequest = {
        platform: data.platform,
        keywords: data.keywords,
        maxVideos: data.maxVideos,
        dateRangeStart: data.dateRangeStart ? new Date(data.dateRangeStart) : undefined,
        dateRangeEnd: data.dateRangeEnd ? new Date(data.dateRangeEnd) : undefined,
        minViews: data.minViews,
      };
      const scraper = getScraper(browser, data.platform);
      await job.updateProgress(10);
      scrapeJobEvents.emit('scrape:progress', { jobId, progress: 10 });

      const result = await scraper.scrape(request);
      await job.updateProgress(60);
      scrapeJobEvents.emit('scrape:progress', { jobId, progress: 60 });

      const supabase = getSupabase();
      const videos = result.videos;
      const total = videos.length;
      if (total === 0) {
        await supabase.from('projects').update({ status: 'analyzing' }).eq('id', data.projectId).eq('user_id', data.userId);
        scrapeJobEvents.emit('scrape:completed', { jobId, data, videosCount: 0 });
        return;
      }

      const rows = videos.map((v) => toVideoRow(v, data.projectId, data.userId));
      const { data: inserted, error: insertError } = await supabase.from('videos').insert(rows).select('id');
      if (insertError) {
        logger.error({ err: insertError, projectId: data.projectId }, 'Failed to insert videos');
        throw new Error(insertError.message);
      }
      const insertedIds = (inserted ?? []).map((r: { id: string }) => r.id);

      await supabase.from('projects').update({ status: 'analyzing' }).eq('id', data.projectId).eq('user_id', data.userId);

      for (let i = 0; i < insertedIds.length; i += 1) {
        const video = videos[i]!;
        const videoId = insertedIds[i]!;
        await analyzeJobsQueue.add('analyze-video', {
          videoId,
          projectId: data.projectId,
          userId: data.userId,
          videoUrl: video.videoUrl,
          platform: video.platform,
          analyzeComments: true,
        });
        const p = 60 + Math.floor((30 * (i + 1)) / total);
        await job.updateProgress(p);
        scrapeJobEvents.emit('scrape:progress', { jobId, progress: p });
      }

      await job.updateProgress(100);
      scrapeJobEvents.emit('scrape:completed', { jobId, data, videosCount: total });
    } finally {
      await browser.close().catch(() => {});
    }
  });

  worker.on('failed', (job, err) => {
    const jobId = job?.id ?? 'unknown';
    scrapeJobEvents.emit('scrape:failed', { jobId, err, data: job?.data });
    logger.error({ jobId, err, data: job?.data }, 'Scrape job failed');
  });

  logger.info('Scrape worker started (scrape-jobs queue)');
}
