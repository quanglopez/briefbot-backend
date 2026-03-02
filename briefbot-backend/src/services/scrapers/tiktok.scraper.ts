import type { Browser, Page } from 'playwright';
import { BaseScraper, type BaseScraperOptions } from './base.scraper.js';
import type {
  ScrapeRequest,
  ScrapeResult,
  ScrapedVideo,
  ScrapedComment,
} from '../../types/scraper.types.js';
import { logger } from '../../utils/logger.js';

const MAX_RETRIES = 3;
const PAGE_LOAD_DELAY_MS_MIN = 2000;
const PAGE_LOAD_DELAY_MS_MAX = 5000;
const SCROLL_DELAY_MS = 800;
const MAX_COMMENTS_TARGET = 30;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
];

/**
 * Parse count strings: "1.2M" → 1200000, "52.3K" → 52300, "1,2Tr" → 1200000, "52,3N" → 52300.
 */
function parseCount(raw: string): number {
  const normalized = String(raw)
    .trim()
    .replace(/\s/g, '')
    .replace(/,/g, '.');
  const match = normalized.match(/^([\d.]+)\s*([KkMmBbTtRrNn])?/i);
  if (!match) return 0;
  let value = parseFloat(match[1]);
  if (Number.isNaN(value)) return 0;
  const suffix = (match[2] ?? '').toUpperCase();
  if (suffix === 'K' || suffix === 'N') value *= 1_000;
  else if (suffix === 'M' || suffix === 'T' || suffix === 'R') value *= 1_000_000; // M, Tr
  else if (suffix === 'B') value *= 1_000_000_000;
  return Math.round(value);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export class TikTokScraper extends BaseScraper {
  constructor(browser: Browser, options?: BaseScraperOptions) {
    super(browser, options);
  }

  async scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    if (request.platform !== 'tiktok') {
      return this.buildResult([], 0, ['Platform mismatch: expected tiktok']);
    }
    const errors: string[] = [];
    const videos: ScrapedVideo[] = [];
    const language = request.language ?? 'vi';
    const region = request.region ?? 'VN';

    const context = await this.browser.newContext({
      userAgent: pick(USER_AGENTS),
      viewport: pick(VIEWPORTS),
      locale: language === 'vi' ? 'vi-VN' : 'en-US',
      timezoneId: region === 'VN' ? 'Asia/Ho_Chi_Minh' : 'America/New_York',
    });

    try {
      const keyword = request.keywords[0] ?? '';
      if (!keyword) {
        return this.buildResult([], 0, ['At least one keyword is required']);
      }
      const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}&t=video`;
      const page = await context.newPage();

      const cardLinks = await this.loadSearchPageWithRetry(page, searchUrl, errors);
      let totalFound = cardLinks.length;
      const minViews = request.minViews ?? 0;
      const dateStart = request.dateRangeStart;
      const dateEnd = request.dateRangeEnd;
      const maxVideos = Math.min(request.maxVideos, cardLinks.length);

      for (let i = 0; i < maxVideos; i += 1) {
        const link = cardLinks[i];
        if (!link?.href) continue;
        const fullUrl = link.href.startsWith('http') ? link.href : `https://www.tiktok.com${link.href}`;
        await this.delay(PAGE_LOAD_DELAY_MS_MIN + Math.random() * (PAGE_LOAD_DELAY_MS_MAX - PAGE_LOAD_DELAY_MS_MIN));

        const video = await this.fetchVideoDetailsWithRetry(context, fullUrl, errors);
        if (!video) continue;
        if (minViews > 0 && video.views < minViews) continue;
        if (dateStart && video.postedAt && video.postedAt < dateStart) continue;
        if (dateEnd && video.postedAt && video.postedAt > dateEnd) continue;
        videos.push(video);
      }

      totalFound = Math.max(totalFound, videos.length);
      return this.buildResult(videos, totalFound, errors);
    } finally {
      await context.close().catch(() => {});
    }
  }

  private async loadSearchPageWithRetry(
    page: Page,
    searchUrl: string,
    errors: string[]
  ): Promise<{ href: string }[]> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await this.delay(2000);
        if (await this.handleCaptcha(page)) {
          errors.push('Captcha detected on search page');
          await this.rotateBrowser();
          continue;
        }
        await this.humanScroll(page);
        const links = await this.extractSearchCardLinks(page);
        if (links.length > 0) return links;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Search page attempt ${attempt}: ${msg}`);
        logger.warn({ err: e, attempt, url: searchUrl }, 'TikTok search load failed');
      }
    }
    return [];
  }

  private async humanScroll(page: Page): Promise<void> {
    const scrolls = 5 + Math.floor(Math.random() * 5);
    for (let i = 0; i < scrolls; i += 1) {
      const step = 300 + Math.random() * 400;
      await page.evaluate((s: number) => window.scrollBy(0, s), step);
      await this.delay(SCROLL_DELAY_MS);
    }
  }

  private async extractSearchCardLinks(page: Page): Promise<{ href: string }[]> {
    const links = await page.locator('a[href*="/video/"]').evaluateAll((anchors) =>
      anchors
        .map((a) => (a as HTMLAnchorElement).getAttribute('href'))
        .filter((href): href is string => !!href && href.includes('/video/'))
        .map((href) => ({ href: href.startsWith('http') ? href : `https://www.tiktok.com${href}` }))
    );
    const seen = new Set<string>();
    return links.filter((l) => {
      const key = l.href.replace(/#.*$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async fetchVideoDetailsWithRetry(
    context: import('playwright').BrowserContext,
    videoUrl: string,
    errors: string[]
  ): Promise<ScrapedVideo | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const detailPage = await context.newPage();
        try {
          await detailPage.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
          await this.delay(1500);
          if (await this.handleCaptcha(detailPage)) {
            errors.push(`Captcha on video: ${videoUrl}`);
            continue;
          }
          return await this.extractVideoDetailPage(detailPage, videoUrl);
        } finally {
          await detailPage.close().catch(() => {});
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Video ${videoUrl} attempt ${attempt}: ${msg}`);
        logger.warn({ err: e, attempt, videoUrl }, 'TikTok video page failed');
      }
    }
    return null;
  }

  private async extractVideoDetailPage(page: Page, fallbackVideoUrl: string): Promise<ScrapedVideo | null> {
    const videoUrl =
      page.url().includes('/video/') ? page.url() : fallbackVideoUrl;

    const captionEl = page.locator('[data-e2e="browse-video-desc"], [data-e2e="video-desc"], .tiktok-1irvcwe-SpanCaption, [class*="Caption"]').first();
    const captionRaw = await captionEl.textContent().catch(() => '') ?? '';
    const caption = this.sanitizeText(captionRaw);
    const hashtags = this.extractHashtags(captionRaw);

    const stats = await this.extractStatsFromPage(page);
    const views = stats.views ?? 0;
    const likes = stats.likes ?? 0;
    const commentsCount = stats.comments ?? 0;
    const shares = stats.shares ?? 0;

    const creatorEl = page.locator('[data-e2e="browse-username"], [data-e2e="video-author-uniqueid"], a[href*="/@"]').first();
    const creatorName = this.sanitizeText(await creatorEl.textContent().catch(() => '') ?? '').replace(/^@/, '') || 'Unknown';
    const creatorFollowers = await this.extractCreatorFollowers(page);

    const thumbnailUrl = await page.locator('video').first().getAttribute('poster')
      ?? await page.locator('img[src*="tiktok"]').first().getAttribute('src').catch(() => null);

    const postedAt = await this.extractPostedAt(page);

    const rawComments = await this.extractComments(page);

    const engagementRate = this.calculateEngagement(views, likes, commentsCount, shares);

    if (!videoUrl) return null;

    return {
      platform: 'tiktok',
      videoUrl,
      thumbnailUrl,
      caption,
      hashtags,
      views,
      likes,
      commentsCount,
      shares,
      engagementRate,
      creatorName,
      creatorFollowers,
      postedAt,
      rawComments,
    };
  }

  private async extractStatsFromPage(
    page: Page
  ): Promise<{ views: number; likes: number; comments: number; shares: number }> {
    const selectors = [
      '[data-e2e="video-views"]',
      '[data-e2e="video-count"]',
      '[data-e2e="browse-video-desc"]',
      '[class*="VideoMeta"]',
      '[class*="Stats"]',
      'main',
    ];
    let blockText = '';
    for (const sel of selectors) {
      blockText = await page.locator(sel).first().textContent().catch(() => '') ?? '';
      if (blockText.length > 50) break;
    }
    const views =
      parseCount(blockText.match(/(\d[\d.,]*\s*[KkMmBbTtRrNn]?)\s*(?:views?|lượt xem)/i)?.[1] ?? '') ||
      parseCount(blockText.match(/(\d[\d.,]*\s*[KkMmBbTtRrNn]?)\s*views?/i)?.[1] ?? '') ||
      (await page.locator('[data-e2e="video-views"]').first().textContent().then((t) => (t ? parseCount(t) : null)).catch(() => null));
    const likes =
      parseCount(blockText.match(/(\d[\d.,]*\s*[KkMmBbTtRrNn]?)\s*(?:likes?|thích)/i)?.[1] ?? '') ||
      parseCount(blockText.match(/(\d[\d.,]*\s*[KkMmBbTtRrNn]?)\s*likes?/i)?.[1] ?? '') ||
      (await page.locator('[data-e2e="video-likes"]').first().textContent().then((t) => (t ? parseCount(t) : null)).catch(() => null));
    const comments =
      parseCount(blockText.match(/(\d[\d.,]*\s*[KkMmBbTtRrNn]?)\s*(?:comments?|bình luận)/i)?.[1] ?? '') ||
      parseCount(blockText.match(/(\d[\d.,]*\s*[KkMmBbTtRrNn]?)\s*comments?/i)?.[1] ?? '') ||
      (await page.locator('[data-e2e="video-comments"]').first().textContent().then((t) => (t ? parseCount(t) : null)).catch(() => null));
    const shares =
      parseCount(blockText.match(/(\d[\d.,]*\s*[KkMmBbTtRrNn]?)\s*(?:shares?|chia sẻ)/i)?.[1] ?? '') ||
      parseCount(blockText.match(/(\d[\d.,]*\s*[KkMmBbTtRrNn]?)\s*shares?/i)?.[1] ?? '') ||
      (await page.locator('[data-e2e="video-shares"]').first().textContent().then((t) => (t ? parseCount(t) : null)).catch(() => null));
    return {
      views: views ?? 0,
      likes: likes ?? 0,
      comments: comments ?? 0,
      shares: shares ?? 0,
    };
  }

  private async extractCreatorFollowers(page: Page): Promise<number | null> {
    const selectors = [
      '[data-e2e="followers-count"]',
      '[data-e2e="user-fans"]',
      '[class*="FollowerCount"]',
      '[class*="follower"]',
    ];
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      const text = await el.textContent().catch(() => '');
      if (text) {
        const n = parseCount(text);
        if (n > 0) return n;
      }
    }
    return null;
  }

  private async extractPostedAt(page: Page): Promise<Date | null> {
    const timeEl = page.locator('time[datetime]').first();
    const datetime = await timeEl.getAttribute('datetime').catch(() => null);
    if (datetime) {
      const d = new Date(datetime);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const text = await page.locator('[data-e2e="video-date"], [class*="Date"], [class*="date"]').first().textContent().catch(() => '');
    if (!text) return null;
    const relative = text.trim();
    const now = new Date();
    if (/^\d+\s*(sec|giây)/i.test(relative)) return now;
    if (/^\d+\s*(min|phút)/i.test(relative)) return new Date(now.getTime() - 60_000 * parseInt(relative, 10));
    if (/^\d+\s*(hour|giờ)/i.test(relative)) return new Date(now.getTime() - 3600_000 * parseInt(relative, 10));
    if (/^\d+\s*(day|ngày)/i.test(relative)) return new Date(now.getTime() - 86400_000 * parseInt(relative, 10));
    return null;
  }

  private async extractComments(page: Page): Promise<ScrapedComment[]> {
    const comments: ScrapedComment[] = [];
    const list = page.locator('[data-e2e="comment-list"] [data-e2e="comment-item"], [class*="CommentItem"], [class*="comment-item"]');
    const count = await list.count();
    const toScroll = Math.min(MAX_COMMENTS_TARGET, Math.max(count, 10));
    for (let i = 0; i < toScroll; i += 1) {
      try {
        const item = list.nth(i);
        const text = await item.locator('[data-e2e="comment-level-1"], [class*="CommentContent"], p, span').first().textContent().catch(() => '');
        const likesText = await item.locator('[data-e2e="comment-like-count"], [class*="LikeCount"]').first().textContent().catch(() => '');
        const repliesText = await item.locator('[data-e2e="comment-reply-count"], [class*="ReplyCount"]').first().textContent().catch(() => '');
        const timeEl = item.locator('time[datetime]').first();
        const datetime = await timeEl.getAttribute('datetime').catch(() => null);
        comments.push({
          text: this.sanitizeText(text ?? ''),
          likes: parseCount(likesText ?? ''),
          replies: parseCount(repliesText ?? ''),
          postedAt: datetime ? (Number.isNaN(new Date(datetime).getTime()) ? null : new Date(datetime)) : null,
        });
      } catch {
        // skip malformed comment
      }
    }
    for (let s = 0; s < 3; s += 1) {
      await page.locator('[data-e2e="comment-list"]').first().evaluate((el) => el.scrollBy(0, 400));
      await this.delay(500);
    }
    const list2 = page.locator('[data-e2e="comment-list"] [data-e2e="comment-item"], [class*="CommentItem"]');
    const count2 = await list2.count();
    for (let i = comments.length; i < Math.min(count2, MAX_COMMENTS_TARGET); i += 1) {
      try {
        const item = list2.nth(i);
        const text = await item.locator('[data-e2e="comment-level-1"], [class*="CommentContent"], p, span').first().textContent().catch(() => '');
        const likesText = await item.locator('[data-e2e="comment-like-count"], [class*="LikeCount"]').first().textContent().catch(() => '');
        const repliesText = await item.locator('[data-e2e="comment-reply-count"], [class*="ReplyCount"]').first().textContent().catch(() => '');
        const timeEl = item.locator('time[datetime]').first();
        const datetime = await timeEl.getAttribute('datetime').catch(() => null);
        comments.push({
          text: this.sanitizeText(text ?? ''),
          likes: parseCount(likesText ?? ''),
          replies: parseCount(repliesText ?? ''),
          postedAt: datetime ? (Number.isNaN(new Date(datetime).getTime()) ? null : new Date(datetime)) : null,
        });
      } catch {
        // skip
      }
    }
    return comments.slice(0, MAX_COMMENTS_TARGET);
  }
}
