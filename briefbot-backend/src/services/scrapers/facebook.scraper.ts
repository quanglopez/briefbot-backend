import type { Browser, Page } from 'playwright';
import { BaseScraper, type BaseScraperOptions } from './base.scraper.js';
import type {
  ScrapeRequest,
  ScrapeResult,
  ScrapedVideo,
  ScrapedComment,
} from '../../types/scraper.types.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

const GRAPH_API_VERSION = 'v18.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const MAX_VIDEOS_PER_SESSION = 50;
const PAGE_DELAY_MS_MIN = 3000;
const PAGE_DELAY_MS_MAX = 8000;
const SCROLL_DELAY_MS = 1500;
const MAX_COMMENTS_TARGET = 30;
const MAX_RETRIES = 2;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
];

const SUGGEST_GRAPH_TOKEN =
  'Facebook blocked or restricted scraping. For reliable results, set FB_ACCESS_TOKEN (Graph API) in env. See: https://developers.facebook.com/docs/graph-api/.'

/** Parse Facebook count format: "1.2K", "1.2M", "2 Tr", "1,2N lượt xem". */
function parseCountFb(raw: string): number {
  const normalized = String(raw)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/,/g, '.');
  const match = normalized.match(/([\d.]+)\s*([KkMmBbTtRrNn])?/);
  if (!match) return 0;
  let value = parseFloat(match[1]);
  if (Number.isNaN(value)) return 0;
  const suffix = (match[2] ?? '').toUpperCase();
  if (suffix === 'K' || suffix === 'N') value *= 1_000;
  else if (suffix === 'M' || suffix === 'T' || suffix === 'R') value *= 1_000_000;
  else if (suffix === 'B') value *= 1_000_000_000;
  return Math.round(value);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

interface GraphPost {
  id?: string;
  from?: { name?: string; id?: string };
  message?: string;
  created_time?: string;
  permalink_url?: string;
  full_picture?: string;
  source?: string;
  attachments?: {
    data?: Array<{
      media_type?: string;
      media?: { source?: string };
      subattachments?: { data?: Array<{ media?: { source?: string }; media_type?: string }> };
    }>;
  };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}

interface GraphSearchResponse {
  data?: GraphPost[];
  error?: { message?: string; code?: number; type?: string };
  paging?: { next?: string };
}

export class FacebookScraper extends BaseScraper {
  constructor(browser: Browser, options?: BaseScraperOptions) {
    super(browser, options);
  }

  async scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    if (request.platform !== 'facebook') {
      return this.buildResult([], 0, ['Platform mismatch: expected facebook']);
    }
    const keyword = request.keywords[0] ?? '';
    if (!keyword) {
      return this.buildResult([], 0, ['At least one keyword is required']);
    }
    const errors: string[] = [];
    const maxVideos = Math.min(request.maxVideos, MAX_VIDEOS_PER_SESSION);

    if (env.FB_ACCESS_TOKEN) {
      const result = await this.scrapeViaGraphApi(keyword, maxVideos, request, errors);
      if (result.videos.length > 0 || result.errors.some((e) => e.includes('token') || e.includes('permission'))) {
        return result;
      }
      errors.push(...result.errors);
    }

    if (env.FB_COOKIES && env.FB_COOKIES.trim()) {
      const result = await this.scrapeViaCookieLogin(keyword, maxVideos, request, errors);
      if (result.videos.length > 0) return result;
      errors.push(...result.errors);
    }

    if (errors.length === 0) {
      errors.push('Neither FB_ACCESS_TOKEN nor FB_COOKIES is set.');
    }
    errors.push(SUGGEST_GRAPH_TOKEN);
    return this.buildResult([], 0, errors);
  }

  private async scrapeViaGraphApi(
    keyword: string,
    maxVideos: number,
    request: ScrapeRequest,
    errors: string[]
  ): Promise<ScrapeResult> {
    const token = env.FB_ACCESS_TOKEN!;
    const fields = [
      'id',
      'from',
      'message',
      'created_time',
      'permalink_url',
      'full_picture',
      'source',
      'attachments{media_type,media{source},subattachments}',
      'reactions.summary(true)',
      'comments.summary(true)',
      'shares',
    ].join(',');
    const url = `${GRAPH_BASE}/search?q=${encodeURIComponent(keyword)}&type=post&access_token=${encodeURIComponent(token)}&fields=${encodeURIComponent(fields)}&limit=${Math.min(maxVideos + 20, 50)}`;

    try {
      const res = await fetch(url);
      const json = (await res.json()) as GraphSearchResponse;
      if (json.error) {
        errors.push(`Graph API: ${json.error.message ?? 'Unknown error'}. ${SUGGEST_GRAPH_TOKEN}`);
        return this.buildResult([], 0, errors);
      }
      const posts = json.data ?? [];
      const videos: ScrapedVideo[] = [];
      for (const post of posts) {
        const hasVideo = !!post.source || !!this.getVideoUrlFromAttachments(post) || post.attachments?.data?.some((a) => a.media_type === 'video');
        const videoUrl = post.permalink_url ?? post.source ?? this.getVideoUrlFromAttachments(post);
        if (!hasVideo || !videoUrl) continue;
        const fromName = post.from?.name ?? 'Unknown';
        const message = post.message ?? '';
        const hashtags = this.extractHashtags(message);
        const views = 0;
        const likes = post.reactions?.summary?.total_count ?? 0;
        const commentsCount = post.comments?.summary?.total_count ?? 0;
        const shares = post.shares?.count ?? 0;
        const engagementRate = this.calculateEngagement(views || 1, likes, commentsCount, shares);
        const postedAt = post.created_time ? new Date(post.created_time) : null;
        if (request.minViews != null && views < request.minViews) continue;
        if (request.dateRangeStart && postedAt && postedAt < request.dateRangeStart) continue;
        if (request.dateRangeEnd && postedAt && postedAt > request.dateRangeEnd) continue;
        videos.push({
          platform: 'facebook',
          videoUrl,
          thumbnailUrl: post.full_picture ?? null,
          caption: this.sanitizeText(message),
          hashtags,
          views,
          likes,
          commentsCount,
          shares,
          engagementRate,
          creatorName: fromName,
          creatorFollowers: null,
          postedAt,
          rawComments: [],
        });
        if (videos.length >= maxVideos) break;
      }
      return this.buildResult(videos, posts.length, errors);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Graph API request failed: ${msg}`);
      logger.warn({ err: e, url: url.replace(token, '***') }, 'Facebook Graph API error');
      return this.buildResult([], 0, errors);
    }
  }

  private getVideoUrlFromAttachments(post: GraphPost): string | null {
    const data = post.attachments?.data ?? [];
    for (const att of data) {
      if (att.media_type === 'video' && att.media?.source) return att.media.source;
      const sub = att.subattachments?.data ?? [];
      for (const s of sub) {
        if (s.media_type === 'video' && s.media?.source) return s.media.source;
      }
    }
    if (post.source) return post.source;
    return null;
  }

  private async scrapeViaCookieLogin(
    keyword: string,
    maxVideos: number,
    request: ScrapeRequest,
    errors: string[]
  ): Promise<ScrapeResult> {
    let cookies: Array<{ name: string; value: string; domain?: string; path?: string }>;
    try {
      const parsed = JSON.parse(env.FB_COOKIES!.trim()) as unknown;
      cookies = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && 'cookies' in parsed
          ? (parsed as { cookies: typeof cookies }).cookies
          : [];
    } catch {
      errors.push('FB_COOKIES is invalid JSON.');
      return this.buildResult([], 0, errors);
    }
    if (cookies.length === 0) {
      errors.push('FB_COOKIES parsed to empty list.');
      return this.buildResult([], 0, errors);
    }

    const context = await this.browser.newContext({
      userAgent: pick(USER_AGENTS),
      viewport: pick(VIEWPORTS),
      locale: request.language === 'vi' ? 'vi-VN' : 'en-US',
    });
    try {
      await context.addCookies(
        cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain ?? '.facebook.com',
          path: c.path ?? '/',
        }))
      );
      const page = await context.newPage();
      const watchUrl = `https://www.facebook.com/watch/search/?q=${encodeURIComponent(keyword)}`;
      const videoSearchUrl = `https://www.facebook.com/search/videos/?q=${encodeURIComponent(keyword)}`;
      await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await this.delay(PAGE_DELAY_MS_MIN + Math.random() * (PAGE_DELAY_MS_MAX - PAGE_DELAY_MS_MIN));

      if (await this.handleCaptcha(page)) {
        errors.push('Captcha or "going too fast" detected. ' + SUGGEST_GRAPH_TOKEN);
        return this.buildResult([], 0, errors);
      }
      let bodyText = await page.locator('body').textContent().catch(() => '') ?? '';
      if (/going too fast|try again later|temporarily blocked/i.test(bodyText)) {
        errors.push('Facebook rate limit: "going too fast". ' + SUGGEST_GRAPH_TOKEN);
        return this.buildResult([], 0, errors);
      }
      if (/log in|sign up|đăng nhập/i.test(bodyText) && !bodyText.includes('watch')) {
        errors.push('Not logged in: FB_COOKIES may be expired. ' + SUGGEST_GRAPH_TOKEN);
        return this.buildResult([], 0, errors);
      }

      await this.humanScroll(page);
      let links = await this.extractVideoLinksFromSearch(page);
      if (links.length === 0) {
        await page.goto(videoSearchUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await this.delay(PAGE_DELAY_MS_MIN + Math.random() * (PAGE_DELAY_MS_MAX - PAGE_DELAY_MS_MIN));
        bodyText = await page.locator('body').textContent().catch(() => '') ?? '';
        if (!/going too fast|try again later|temporarily blocked/i.test(bodyText)) {
          await this.humanScroll(page);
          links = await this.extractVideoLinksFromSearch(page);
        }
      }
      const videos: ScrapedVideo[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < Math.min(links.length, maxVideos); i += 1) {
        const href = links[i];
        if (!href || seen.has(href)) continue;
        seen.add(href);
        await this.delay(PAGE_DELAY_MS_MIN + Math.random() * (PAGE_DELAY_MS_MAX - PAGE_DELAY_MS_MIN));
        const video = await this.fetchVideoDetailPage(context, page, href, errors);
        if (video) {
          if (request.minViews != null && video.views < request.minViews) continue;
          if (request.dateRangeStart && video.postedAt && video.postedAt < request.dateRangeStart) continue;
          if (request.dateRangeEnd && video.postedAt && video.postedAt > request.dateRangeEnd) continue;
          videos.push(video);
        }
      }
      return this.buildResult(videos, links.length, errors);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Cookie login flow: ${msg}`);
      logger.warn({ err: e }, 'Facebook cookie scrape failed');
      return this.buildResult([], 0, errors);
    } finally {
      await context.close().catch(() => {});
    }
  }

  private async humanScroll(page: Page): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      const step = 400 + Math.random() * 400;
      await page.evaluate((s: number) => window.scrollBy(0, s), step);
      await this.delay(SCROLL_DELAY_MS);
    }
  }

  private async extractVideoLinksFromSearch(page: Page): Promise<string[]> {
    const links = await page.locator('a[href*="/watch/?v="], a[href*="/reel/"], a[href*="/videos/"]').evaluateAll((anchors) =>
      anchors
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h): h is string => !!h && (h.includes('/watch/?v=') || h.includes('/reel/') || h.includes('/videos/')))
    );
    const seen = new Set<string>();
    return links.filter((h) => {
      const key = h.replace(/#.*$/, '').split('?')[0] ?? h;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async fetchVideoDetailPage(
    context: import('playwright').BrowserContext,
    _searchPage: Page,
    videoUrl: string,
    errors: string[]
  ): Promise<ScrapedVideo | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const page = await context.newPage();
        try {
          await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await this.delay(2000);
          if (await this.handleCaptcha(page)) {
            errors.push(`Captcha on video: ${videoUrl}`);
            continue;
          }
          const video = await this.extractVideoDetailPage(page, videoUrl);
          return video;
        } finally {
          await page.close().catch(() => {});
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Video ${videoUrl} attempt ${attempt}: ${msg}`);
      }
    }
    return null;
  }

  private async extractVideoDetailPage(page: Page, fallbackUrl: string): Promise<ScrapedVideo | null> {
    const videoUrl = page.url().includes('/watch') || page.url().includes('/reel') ? page.url() : fallbackUrl;

    const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);
    const captionEl = page.locator('[data-ad-preview="message"], [data-ad-comet-preview="message"], [role="article"] [dir="auto"]').first();
    const captionRaw = await captionEl.textContent().catch(() => '') ?? '';
    const caption = this.sanitizeText(captionRaw);
    const hashtags = this.extractHashtags(captionRaw);

    const statsText = await page.locator('body').textContent().catch(() => '') ?? '';
    const [views, likes, commentsCount, shares] = await Promise.all([
      this.parseStatsFromText(statsText, page, 'views'),
      this.parseStatsFromText(statsText, page, 'reactions'),
      this.parseStatsFromText(statsText, page, 'comments'),
      this.parseStatsFromText(statsText, page, 'shares'),
    ]);
    const v = views ?? 0;
    const l = likes ?? 0;
    const c = commentsCount ?? 0;
    const s = shares ?? 0;

    const creatorEl = page.locator('a[role="link"] strong, [data-ad-preview="actor"]').first();
    const creatorName = this.sanitizeText(await creatorEl.textContent().catch(() => '') ?? '') || 'Unknown';

    const timeEl = page.locator('a[href*="/posts/"] abbr, time').first();
    const datetime = await timeEl.getAttribute('datetime').catch(() => null);
    const postedAt = datetime && !Number.isNaN(new Date(datetime).getTime()) ? new Date(datetime) : null;

    const rawComments = await this.extractComments(page);

    const engagementRate = this.calculateEngagement(v || 1, l, c, s);

    return {
      platform: 'facebook',
      videoUrl,
      thumbnailUrl: ogImage ?? null,
      caption,
      hashtags,
      views: v,
      likes: l,
      commentsCount: c,
      shares: s,
      engagementRate,
      creatorName,
      creatorFollowers: null,
      postedAt,
      rawComments,
    };
  }

  private async parseStatsFromText(
    bodyText: string,
    page: Page,
    kind: 'views' | 'reactions' | 'comments' | 'shares'
  ): Promise<number | null> {
    const patterns: Record<string, RegExp[]> = {
      views: [/([\d.,]+\s*[KkMmTtRrNn]?)\s*(?:lượt xem|views?)/i, /([\d.,]+\s*[KkMmTtRrNn]?)\s*views?/i],
      reactions: [/([\d.,]+\s*[KkMmTtRrNn]?)\s*(?:reactions?|thích)/i],
      comments: [/([\d.,]+\s*[KkMmTtRrNn]?)\s*(?:comments?|bình luận)/i],
      shares: [/([\d.,]+\s*[KkMmTtRrNn]?)\s*(?:shares?|chia sẻ)/i],
    };
    for (const re of patterns[kind]) {
      const m = bodyText.match(re);
      if (m?.[1]) return parseCountFb(m[1]);
    }
    const sel = page.locator(`[aria-label*="${kind}" i]`).first();
    const t = await sel.textContent().catch(() => '');
    return t ? parseCountFb(t) : null;
  }

  private async extractComments(page: Page): Promise<ScrapedComment[]> {
    const comments: ScrapedComment[] = [];
    const expandMostRelevant = page.locator('span:has-text("Most relevant"), span:has-text("Bình luận hàng đầu")').first();
    await expandMostRelevant.click().catch(() => {});
    await this.delay(1000);
    const switchAll = page.locator('span:has-text("All comments"), span:has-text("Tất cả bình luận")').first();
    await switchAll.click().catch(() => {});
    await this.delay(1000);

    const seeMore = page.locator('span:has-text("See more"), span:has-text("Xem thêm")');
    const seeMoreCount = await seeMore.count();
    for (let i = 0; i < Math.min(seeMoreCount, 5); i += 1) {
      await seeMore.nth(i).click().catch(() => {});
      await this.delay(500);
    }

    const list = page.locator('[role="article"] [dir="auto"], [data-ad-comet-preview="comment"]');
    const count = await list.count();
    for (let i = 0; i < Math.min(count, MAX_COMMENTS_TARGET); i += 1) {
      try {
        const item = list.nth(i);
        const text = await item.locator('[dir="auto"]').first().textContent().catch(() => '');
        const reactionEl = item.locator('[aria-label*="reaction"], [aria-label*="thích"]').first();
        const reactionText = await reactionEl.textContent().catch(() => '');
        comments.push({
          text: this.sanitizeText(text ?? ''),
          likes: parseCountFb(reactionText ?? ''),
          replies: 0,
          postedAt: null,
        });
      } catch {
        // skip
      }
    }
    return comments.slice(0, MAX_COMMENTS_TARGET);
  }
}
