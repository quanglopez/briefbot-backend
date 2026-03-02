import type { Browser, Page } from 'playwright';
import type { ScrapeRequest, ScrapeResult, ScrapedVideo } from '../../types/scraper.types.js';

const HASHTAG_REGEX = /#[\w\u00C0-\u024F\u1E00-\u1EFF]+/gi;
const SPAM_PATTERNS = [
  /\b(?:follow|subscribe|link in bio|dm me|check my profile)\b/gi,
  /\b(?:http|https):\/\/\S+/gi,
  /\b(?:telegram|whatsapp|discord)\s*[:=]\s*\S+/gi,
];

export type BrowserFactory = () => Promise<Browser>;

export interface BaseScraperOptions {
  /** Used by rotateBrowser() to reopen with new proxy/fingerprint. */
  browserFactory?: BrowserFactory;
}

export abstract class BaseScraper {
  protected browser: Browser;
  private browserFactory?: BrowserFactory;

  constructor(browser: Browser, options?: BaseScraperOptions) {
    this.browser = browser;
    this.browserFactory = options?.browserFactory;
  }

  abstract scrape(request: ScrapeRequest): Promise<ScrapeResult>;

  /** (likes + comments + shares) / views * 100; returns 0 when views is 0. */
  protected calculateEngagement(
    views: number,
    likes: number,
    comments: number,
    shares: number
  ): number {
    if (views <= 0) return 0;
    const total = likes + comments + shares;
    return Math.round((total / views) * 100 * 100) / 100;
  }

  /** Clean unicode and remove common spam patterns. */
  protected sanitizeText(text: string): string {
    let out = text
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim();
    for (const pattern of SPAM_PATTERNS) {
      out = out.replace(pattern, '');
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  protected extractHashtags(caption: string): string[] {
    const matches = caption.match(HASHTAG_REGEX) ?? [];
    return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
  }

  /** Random delay between min and max (ms * 0.5 to ms * 1.5). */
  protected delay(ms: number): Promise<void> {
    const min = Math.floor(ms * 0.5);
    const max = Math.ceil(ms * 1.5);
    const duration = min + Math.floor(Math.random() * (max - min + 1));
    return new Promise((resolve) => setTimeout(resolve, duration));
  }

  /**
   * Detect if the given page is a captcha challenge.
   * Override in subclass for platform-specific selectors.
   * @returns true if captcha was detected (caller should skip/retry).
   */
  protected async handleCaptcha(page: Page): Promise<boolean> {
    const body = await page.locator('body').textContent().catch(() => '');
    const captchaIndicators = [
      'captcha',
      'verify you are human',
      'robot',
      'unusual traffic',
      'recaptcha',
      'challenge',
    ];
    const lower = (body ?? '').toLowerCase();
    return captchaIndicators.some((word) => lower.includes(word));
  }

  /**
   * Close current browser and reopen using browserFactory (new proxy/fingerprint).
   * No-op if browserFactory was not provided.
   */
  protected async rotateBrowser(): Promise<void> {
    if (!this.browserFactory) return;
    await this.browser.close();
    this.browser = await this.browserFactory();
  }

  /** Build a partial result with common fields; subclasses fill platform-specific data. */
  protected buildResult(
    videos: ScrapedVideo[],
    totalFound: number,
    errors: string[] = []
  ): ScrapeResult {
    return {
      success: errors.length === 0 || videos.length > 0,
      videos,
      totalFound,
      scrapedAt: new Date(),
      errors,
    };
  }
}
