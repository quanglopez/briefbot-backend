import type { ScraperPlatform } from './scraper.types.js';

export interface ScrapeJob {
  projectId: string;
  userId: string;
  platform: ScraperPlatform;
  keywords: string[];
  maxVideos: number;
  dateRangeStart?: string;
  dateRangeEnd?: string;
  minViews?: number;
}

export interface AnalyzeJob {
  videoId: string;
  projectId: string;
  userId: string;
  videoUrl: string;
  platform: string;
  analyzeComments: boolean;
}
