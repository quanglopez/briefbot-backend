import type { Browser, Page } from 'playwright';
import { BaseScraper, type BaseScraperOptions } from './base.scraper.js';
import type {
  ScrapeRequest,
  ScrapeResult,
  ScrapedVideo,
  ScrapedComment,
} from '../../types/scraper.types.js';
import { logger } from '../../utils/logger.js';

const SHOPEE_BASE = 'https://shopee.vn';
const DELAY_MS_MIN = 3000;
const DELAY_MS_MAX = 6000;
const MAX_REQUESTS_PER_MINUTE = 30;
const REQUEST_INTERVAL_MS = 60_000 / MAX_REQUESTS_PER_MINUTE;
const MAX_COMMENTS_TARGET = 25;
const MAX_RETRIES = 2;

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const FALLBACK_MESSAGE =
  'Shopee blocked or restricted access. Alternatives: (1) Use a Shopee extension/bookmarklet to export video data, or (2) Upload manual CSV from Shopee analytics.';

/** Parse Shopee numbers: "1.2K", "1,2Tr", "1.234", "1,234". */
function parseCountShopee(raw: string): number {
  const normalized = String(raw).trim().replace(/\s/g, '').replace(/,/g, '.');
  const match = normalized.match(/([\d.]+)\s*([KkMmTtRrNn])?/);
  if (!match) return 0;
  let value = parseFloat(match[1]);
  if (Number.isNaN(value)) return 0;
  const suffix = (match[2] ?? '').toUpperCase();
  if (suffix === 'K' || suffix === 'N') value *= 1_000;
  else if (suffix === 'M' || suffix === 'T' || suffix === 'R') value *= 1_000_000;
  return Math.round(value);
}

/** Minimal rate limiter: wait so we don't exceed MAX_REQUESTS_PER_MINUTE. */
let lastRequestTime = 0;
async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

/** Plausible Shopee API response shapes (internal API may vary). */
interface ShopeeVideoItem {
  itemid?: number;
  video_id?: string;
  video_url?: string;
  cover?: string;
  title?: string;
  desc?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  shop_name?: string;
  shop_rating?: number;
  product?: {
    name?: string;
    price?: number;
    price_min?: number;
    price_max?: number;
    rating?: number;
    sold?: number;
  };
  create_time?: number;
}

interface ShopeeApiResponse {
  data?: { items?: ShopeeVideoItem[]; videos?: ShopeeVideoItem[] };
  error?: string;
  message?: string;
}

export class ShopeeScraper extends BaseScraper {
  constructor(browser: Browser, options?: BaseScraperOptions) {
    super(browser, options);
  }

  async scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    if (request.platform !== 'shopee') {
      return this.buildResult([], 0, ['Platform mismatch: expected shopee']);
    }
    const keyword = request.keywords[0] ?? '';
    if (!keyword) {
      return this.buildResult([], 0, ['At least one keyword is required']);
    }
    const errors: string[] = [];
    const maxVideos = Math.min(request.maxVideos, 50);

    const apiResult = await this.scrapeViaApi(keyword, maxVideos, request, errors);
    if (apiResult.videos.length > 0) return apiResult;
    errors.push(...apiResult.errors);

    const webResult = await this.scrapeViaWeb(keyword, maxVideos, request, errors);
    if (webResult.videos.length > 0) return webResult;
    errors.push(...webResult.errors);

    if (errors.length > 0) {
      errors.push(FALLBACK_MESSAGE);
    }
    return this.buildResult([], 0, errors);
  }

  private async scrapeViaApi(
    keyword: string,
    maxVideos: number,
    request: ScrapeRequest,
    errors: string[]
  ): Promise<ScrapeResult> {
    const context = await this.browser.newContext({
      userAgent: MOBILE_USER_AGENT,
      viewport: { width: 390, height: 844 },
      locale: 'vi-VN',
    });
    try {
      const page = await context.newPage();
      await page.goto(SHOPEE_BASE, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.shopeeDelay(DELAY_MS_MIN + Math.random() * (DELAY_MS_MAX - DELAY_MS_MIN));
      const cookies = await context.cookies();
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const csrfToken = await page.evaluate(() => (window as unknown as { csrfToken?: string }).csrfToken ?? '').catch(() => '');

      await rateLimit();
      const videoListUrl = `${SHOPEE_BASE}/api/v4/shopee_video/get_video_list?keyword=${encodeURIComponent(keyword)}&limit=${maxVideos}&offset=0`;
      const videoRes = await fetch(videoListUrl, {
        headers: {
          accept: 'application/json',
          'accept-language': 'vi-VN,vi;q=0.9',
          'user-agent': MOBILE_USER_AGENT,
          referer: `${SHOPEE_BASE}/shopee-video`,
          cookie: cookieHeader,
          'x-api-source': 'pc',
          'x-shopee-language': 'vi',
          ...(csrfToken ? { 'x-csrftoken': csrfToken } : {}),
        },
      });
      const videoJson = (await videoRes.json()) as ShopeeApiResponse;
      const videoItems = videoJson.data?.videos ?? videoJson.data?.items ?? [];
      if (Array.isArray(videoItems) && videoItems.length > 0) {
        const videos = this.mapApiItemsToVideos(videoItems as ShopeeVideoItem[], request);
        if (videos.length > 0) {
          return this.buildResult(videos.slice(0, maxVideos), videoItems.length, errors);
        }
      }

      await rateLimit();
      const searchUrl = `${SHOPEE_BASE}/api/v4/search/search_items?by=relevancy&keyword=${encodeURIComponent(keyword)}&limit=20&newest=0&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH`;
      const searchRes = await fetch(searchUrl, {
        headers: {
          accept: 'application/json',
          'accept-language': 'vi-VN,vi;q=0.9',
          'user-agent': MOBILE_USER_AGENT,
          referer: `${SHOPEE_BASE}/`,
          cookie: cookieHeader,
          'x-api-source': 'pc',
          'x-shopee-language': 'vi',
          ...(csrfToken ? { 'x-csrftoken': csrfToken } : {}),
        },
      });
      const searchJson = (await searchRes.json()) as ShopeeApiResponse & { items?: unknown[] };
      const items = searchJson.items ?? searchJson.data?.items ?? searchJson.data?.videos ?? [];
      if (Array.isArray(items) && items.length > 0) {
        const videos = this.mapApiItemsToVideos(items as ShopeeVideoItem[], request);
        if (videos.length > 0) {
          return this.buildResult(videos.slice(0, maxVideos), items.length, errors);
        }
      }
      if (videoRes.status === 403 || videoRes.status === 429 || searchRes.status === 403 || searchRes.status === 429) {
        errors.push(`Shopee API returned 403/429. ${FALLBACK_MESSAGE}`);
      } else if (videoJson.error ?? videoJson.message ?? searchJson.error ?? searchJson.message) {
        errors.push(String(videoJson.error ?? videoJson.message ?? searchJson.error ?? searchJson.message));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Shopee API: ${msg}`);
      logger.warn({ err: e }, 'Shopee API scrape failed');
    } finally {
      await context.close().catch(() => {});
    }
    return this.buildResult([], 0, errors);
  }

  private mapApiItemsToVideos(
    items: ShopeeVideoItem[],
    request: ScrapeRequest
  ): ScrapedVideo[] {
    const videos: ScrapedVideo[] = [];
    for (const item of items) {
      const videoUrl = item.video_url ?? (item.video_id ? `${SHOPEE_BASE}/video/${item.video_id}` : null) ?? (item.itemid ? `${SHOPEE_BASE}/video/${item.itemid}` : null);
      if (!videoUrl || videoUrl.endsWith('/video/')) continue;
      const views = item.view_count ?? 0;
      const likes = item.like_count ?? 0;
      const commentsCount = item.comment_count ?? 0;
      const shares = 0;
      const caption = item.title ?? item.desc ?? '';
      const product = item.product;
      const price = product?.price ?? product?.price_min ?? product?.price_max;
      if (request.minViews != null && views < request.minViews) continue;
      const postedAt = item.create_time ? new Date(item.create_time * 1000) : null;
      if (request.dateRangeStart && postedAt && postedAt < request.dateRangeStart) continue;
      if (request.dateRangeEnd && postedAt && postedAt > request.dateRangeEnd) continue;
      videos.push({
        platform: 'shopee',
        videoUrl,
        thumbnailUrl: item.cover ?? null,
        caption: this.sanitizeText(caption),
        hashtags: this.extractHashtags(caption),
        views,
        likes,
        commentsCount,
        shares,
        engagementRate: this.calculateEngagement(views || 1, likes, commentsCount, shares),
        creatorName: item.shop_name ?? 'Unknown',
        creatorFollowers: null,
        postedAt,
        rawComments: [],
        product_name: product?.name,
        product_price: price,
        product_rating: product?.rating,
        product_sold: product?.sold,
        shop_rating: item.shop_rating,
      });
    }
    return videos;
  }

  private async scrapeViaWeb(
    keyword: string,
    maxVideos: number,
    request: ScrapeRequest,
    errors: string[]
  ): Promise<ScrapeResult> {
    const context = await this.browser.newContext({
      userAgent: MOBILE_USER_AGENT,
      viewport: { width: 390, height: 844 },
      locale: 'vi-VN',
    });
    try {
      const page = await context.newPage();
      await page.goto(SHOPEE_BASE, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await this.shopeeDelay(DELAY_MS_MIN + Math.random() * (DELAY_MS_MAX - DELAY_MS_MIN));

      if (await this.handleCaptcha(page)) {
        errors.push('Shopee captcha or anti-bot detected. ' + FALLBACK_MESSAGE);
        return this.buildResult([], 0, errors);
      }
      const bodyText = await page.locator('body').textContent().catch(() => '') ?? '';
      if (/blocked|access denied|cloudflare|challenge/i.test(bodyText)) {
        errors.push('Shopee web access blocked. ' + FALLBACK_MESSAGE);
        return this.buildResult([], 0, errors);
      }

      const searchUrl = `${SHOPEE_BASE}/search?keyword=${encodeURIComponent(keyword)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await this.shopeeDelay(DELAY_MS_MIN + Math.random() * (DELAY_MS_MAX - DELAY_MS_MIN));
      await this.humanScroll(page);

      const videoFeedLink = page.locator('a[href*="shopee-video"], a[href*="/video/"]').first();
      await videoFeedLink.click().catch(() => {});
      await this.shopeeDelay(2000);

      const links = await this.extractVideoLinksFromWeb(page);
      const videos: ScrapedVideo[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < Math.min(links.length, maxVideos); i += 1) {
        const href = links[i];
        if (!href || seen.has(href)) continue;
        seen.add(href);
        await this.shopeeDelay(DELAY_MS_MIN + Math.random() * (DELAY_MS_MAX - DELAY_MS_MIN));
        const video = await this.fetchVideoDetailWeb(context, href, request, errors);
        if (video) videos.push(video);
      }
      return this.buildResult(videos, links.length, errors);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Shopee web: ${msg}`);
      logger.warn({ err: e }, 'Shopee web scrape failed');
      return this.buildResult([], 0, errors);
    } finally {
      await context.close().catch(() => {});
    }
  }

  private async humanScroll(page: Page): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      const step = 350 + Math.random() * 300;
      await page.evaluate((s: number) => window.scrollBy(0, s), step);
      await this.shopeeDelay(1500);
    }
  }

  private async extractVideoLinksFromWeb(page: Page): Promise<string[]> {
    const links = await page.locator('a[href*="/video/"], a[href*="shopee-video"]').evaluateAll((anchors) =>
      anchors
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h): h is string => !!h && (h.includes('/video/') || h.includes('shopee-video')))
    );
    const seen = new Set<string>();
    return links.filter((h) => {
      const key = h.split('?')[0] ?? h;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async fetchVideoDetailWeb(
    context: import('playwright').BrowserContext,
    videoUrl: string,
    request: ScrapeRequest,
    errors: string[]
  ): Promise<ScrapedVideo | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const page = await context.newPage();
        try {
          await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await this.shopeeDelay(2000);
          if (await this.handleCaptcha(page)) {
            errors.push(`Captcha on video: ${videoUrl}`);
            continue;
          }
          return await this.extractVideoDetailWeb(page, videoUrl, request);
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

  private async extractVideoDetailWeb(
    page: Page,
    fallbackUrl: string,
    _request: ScrapeRequest
  ): Promise<ScrapedVideo | null> {
    const videoUrl = page.url().includes('/video/') || page.url().includes('shopee-video') ? page.url() : fallbackUrl;
    const bodyText = await page.locator('body').textContent().catch(() => '') ?? '';

    const titleEl = page.locator('[data-sqe="name"], .video-title, [class*="title"]').first();
    const caption = this.sanitizeText(await titleEl.textContent().catch(() => '') ?? '');
    const hashtags = this.extractHashtags(caption);

    const [views, likes, commentsCount] = await Promise.all([
      this.parseStatsFromPage(bodyText, page, 'view'),
      this.parseStatsFromPage(bodyText, page, 'like'),
      this.parseStatsFromPage(bodyText, page, 'comment'),
    ]);
    const v = views ?? 0;
    const l = likes ?? 0;
    const c = commentsCount ?? 0;
    const engagementRate = this.calculateEngagement(v || 1, l, c, 0);

    const shopEl = page.locator('[data-sqe="shop"], .shop-name, [class*="shop"]').first();
    const creatorName = this.sanitizeText(await shopEl.textContent().catch(() => '') ?? '') || 'Unknown';

    const thumbnailUrl = await page.locator('video').first().getAttribute('poster').catch(() => null)
      ?? await page.locator('img[src*="shopee"]').first().getAttribute('src').catch(() => null);

    const productNameEl = page.locator('[data-sqe="product"], .product-name, [class*="product"]').first();
    const product_name = this.sanitizeText(await productNameEl.textContent().catch(() => '') ?? '') || undefined;
    const priceText = await page.locator('[class*="price"], [data-sqe="price"]').first().textContent().catch(() => '');
    const product_price = priceText ? (parseCountShopee(priceText.replace(/[^\d.,KkMmTtRrNn]/g, '')) || undefined) : undefined;
    const ratingText = await page.locator('[class*="rating"], [aria-label*="rating"]').first().textContent().catch(() => '');
    const product_rating = ratingText ? parseFloat(ratingText.replace(/,/g, '.')) || undefined : undefined;
    const soldText = await page.locator('[class*="sold"], :text("đã bán"), :text("sold")').first().textContent().catch(() => '');
    const product_sold = soldText ? parseCountShopee(soldText) || undefined : undefined;
    const shopRatingText = await page.locator('[class*="shop-rating"]').first().textContent().catch(() => '');
    const shop_rating = shopRatingText ? parseFloat(shopRatingText.replace(/,/g, '.')) || undefined : undefined;

    const rawComments = await this.extractReviewComments(page);

    return {
      platform: 'shopee',
      videoUrl,
      thumbnailUrl,
      caption,
      hashtags,
      views: v,
      likes: l,
      commentsCount: c,
      shares: 0,
      engagementRate,
      creatorName,
      creatorFollowers: null,
      postedAt: null,
      rawComments,
      product_name: product_name || undefined,
      product_price,
      product_rating,
      product_sold,
      shop_rating,
    };
  }

  private async parseStatsFromPage(
    bodyText: string,
    page: Page,
    kind: 'view' | 'like' | 'comment'
  ): Promise<number | null> {
    const patterns: Record<string, RegExp[]> = {
      view: [/([\d.,]+\s*[KkMmTtRrNn]?)\s*(?:lượt xem|views?)/i],
      like: [/([\d.,]+\s*[KkMmTtRrNn]?)\s*(?:thích|likes?)/i],
      comment: [/([\d.,]+\s*[KkMmTtRrNn]?)\s*(?:bình luận|comments?)/i],
    };
    for (const re of patterns[kind]) {
      const m = bodyText.match(re);
      if (m?.[1]) return parseCountShopee(m[1]);
    }
    const sel = page.locator(`[aria-label*="${kind}" i], [class*="${kind}"]`).first();
    const t = await sel.textContent().catch(() => '');
    return t ? parseCountShopee(t) : null;
  }

  private async extractReviewComments(page: Page): Promise<ScrapedComment[]> {
    const comments: ScrapedComment[] = [];
    const list = page.locator('[class*="review"], [class*="comment"], [data-sqe="review"]');
    const count = await list.count();
    for (let i = 0; i < Math.min(count, MAX_COMMENTS_TARGET); i += 1) {
      try {
        const item = list.nth(i);
        const text = await item.locator('[dir="auto"], p, span').first().textContent().catch(() => '');
        const starEl = item.locator('[aria-label*="star"], [class*="rating"]').first();
        const starText = await starEl.textContent().catch(() => '');
        const rating = starText ? parseFloat(starText.replace(/,/g, '.')) : 0;
        comments.push({
          text: this.sanitizeText(text ?? ''),
          likes: 0,
          replies: 0,
          postedAt: null,
        });
        if (rating > 0) {
          comments[comments.length - 1]!.likes = Math.round(rating);
        }
      } catch {
        // skip
      }
    }
    return comments.slice(0, MAX_COMMENTS_TARGET);
  }

  private async shopeeDelay(ms: number): Promise<void> {
    const jitter = ms * 0.2 * (Math.random() - 0.5);
    return new Promise((r) => setTimeout(r, Math.max(500, ms + jitter)));
  }
}
