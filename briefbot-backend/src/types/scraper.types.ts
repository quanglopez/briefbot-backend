export type ScraperPlatform = 'tiktok' | 'facebook' | 'shopee';

export interface ScrapedComment {
  text: string;
  likes: number;
  replies: number;
  postedAt: Date | null;
}

export interface ScrapedVideo {
  platform: ScraperPlatform;
  videoUrl: string;
  thumbnailUrl: string | null;
  caption: string;
  hashtags: string[];
  views: number;
  likes: number;
  commentsCount: number;
  shares: number;
  /** (likes + comments + shares) / views * 100 */
  engagementRate: number;
  creatorName: string;
  creatorFollowers: number | null;
  postedAt: Date | null;
  rawComments: ScrapedComment[];
  /** Shopee-only: linked product and shop data */
  product_name?: string;
  product_price?: number;
  product_rating?: number;
  product_sold?: number;
  shop_rating?: number;
}

export interface ScrapeRequest {
  platform: ScraperPlatform;
  keywords: string[];
  /** 10-100 */
  maxVideos: number;
  dateRangeStart?: Date;
  dateRangeEnd?: Date;
  minViews?: number;
  language?: string;
  region?: string;
}

export interface ScrapeResult {
  success: boolean;
  videos: ScrapedVideo[];
  totalFound: number;
  scrapedAt: Date;
  errors: string[];
}
