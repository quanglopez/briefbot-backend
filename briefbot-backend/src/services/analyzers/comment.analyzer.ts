import { z } from 'zod';
import { COMMENT_ANALYSIS_PROMPT } from '../generators/prompt.templates.js';
import type { ScrapedComment } from '../../types/scraper.types.js';
import type { CommentInsightResult } from '../../types/analysis.types.js';
import { logger } from '../../utils/logger.js';
import { AI_MODELS } from '../../config/ai.js';
import { callAI } from '../../utils/ai-client.js';

const MAX_RETRIES = 2;
const TOP_COMMENTS_LIMIT = 50;
const MIN_COMMENTS_FOR_FULL = 5;
const BATCH_DELAY_MS = 1500;
const RATE_LIMIT_BASE_MS = 2000;

const SPAM_PATTERNS = [
  /check\s*(my\s*)?(bio|link|profile)/i,
  /dm\s+me|inbox\s+me/i,
  /follow\s*(me\s*)?(back|4\s*follow)/i,
  /link\s+in\s+bio/i,
  /telegram|whatsapp|discord\s*[:=]/i,
];

const EMOJI_ONLY = /^[\s\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]+$/u;

const rawSchema = z.object({
  top_questions: z.array(z.object({ question: z.string(), count: z.number(), sentiment: z.string() })),
  pain_points: z.array(z.object({ pain_point: z.string(), count: z.number(), severity: z.string() })),
  positive_signals: z.array(z.object({ signal: z.string(), count: z.number(), type: z.string() })),
  objections: z.array(z.object({ objection: z.string(), count: z.number(), type: z.string() })),
  sentiment_summary: z.string(),
  purchase_intent_score: z.number().min(0).max(100),
  viral_potential: z.string(),
  key_takeaway: z.string(),
});

function isSpam(text: string): boolean {
  if (text.length < 3) return true;
  const trimmed = text.trim();
  if (EMOJI_ONLY.test(trimmed)) return true;
  return SPAM_PATTERNS.some((re) => re.test(trimmed));
}

function toCommentStrings(comments: ScrapedComment[]): string[] {
  return comments.map((c) => `${c.text.trim()} (likes: ${c.likes})`);
}

function sortByCountDesc<T extends { count: number }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => b.count - a.count);
}

function emptyInsight(totalScraped: number): CommentInsightResult {
  return {
    totalCommentsScraped: totalScraped,
    topQuestions: [],
    painPoints: [],
    positiveSignals: [],
    objections: [],
    sentimentSummary: totalScraped < MIN_COMMENTS_FOR_FULL ? 'Không đủ dữ liệu comments để phân tích.' : '',
    purchaseIntentScore: 50,
    viralPotential: 'low',
    keyTakeaway: '',
  };
}

export interface AnalyzeCommentsParams {
  comments: ScrapedComment[];
  videoCaption: string;
  platform: string;
}

export class CommentAnalyzer {
  async analyzeComments(params: AnalyzeCommentsParams): Promise<CommentInsightResult> {
    const { comments, videoCaption, platform } = params;

    const filtered = comments.filter((c) => !isSpam(c.text));
    const seen = new Set<string>();
    const deduped = filtered.filter((c) => {
      const key = c.text.trim().toLowerCase().slice(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const sorted = [...deduped].sort((a, b) => b.likes - a.likes);
    const top = sorted.slice(0, TOP_COMMENTS_LIMIT);
    const totalScraped = comments.length;

    if (top.length < MIN_COMMENTS_FOR_FULL) {
      return emptyInsight(totalScraped);
    }

    const commentStrings = toCommentStrings(top);
    const prompt = COMMENT_ANALYSIS_PROMPT(commentStrings, videoCaption);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const parsed = await this.callModel(prompt);
        return this.enrichResult(parsed, totalScraped);
      } catch (e) {
        const isRateLimit = e instanceof Error && (e.message.includes('429') || (e as { status?: number }).status === 429);
        if (isRateLimit && attempt < MAX_RETRIES) {
          const delay = RATE_LIMIT_BASE_MS * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
        logger.warn({ err: e, platform }, 'Comment analysis failed');
        return emptyInsight(totalScraped);
      }
    }
    return emptyInsight(totalScraped);
  }

  async analyzeMultipleVideos(
    videosComments: Array<{ videoId: string; comments: ScrapedComment[]; caption: string }>
  ): Promise<Map<string, CommentInsightResult>> {
    const results = new Map<string, CommentInsightResult>();
    for (let i = 0; i < videosComments.length; i += 1) {
      const item = videosComments[i]!;
      try {
        const out = await this.analyzeComments({
          comments: item.comments,
          videoCaption: item.caption,
          platform: 'unknown',
        });
        results.set(item.videoId, out);
      } catch (e) {
        logger.warn({ err: e, videoId: item.videoId }, 'Comment analysis failed for video');
        results.set(item.videoId, emptyInsight(item.comments.length));
      }
      if (i < videosComments.length - 1) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }
    return results;
  }

  private async callModel(prompt: string): Promise<z.infer<typeof rawSchema>> {
    const raw = await callAI<z.infer<typeof rawSchema>>({
      model: AI_MODELS.COMMENT_ANALYSIS,
      systemPrompt:
        'You are a consumer insights analyst. Always respond in Vietnamese. Output valid JSON only, no markdown.',
      userPrompt: prompt,
      temperature: 0.3,
      maxTokens: 2000,
      jsonMode: true,
    });
    return rawSchema.parse(raw);
  }

  private enrichResult(parsed: z.infer<typeof rawSchema>, totalScraped: number): CommentInsightResult {
    const score = Math.min(100, Math.max(0, Math.round(parsed.purchase_intent_score)));
    return {
      totalCommentsScraped: totalScraped,
      topQuestions: sortByCountDesc(
        parsed.top_questions.map((q) => ({ question: q.question, count: q.count, sentiment: q.sentiment }))
      ),
      painPoints: sortByCountDesc(
        parsed.pain_points.map((p) => ({ painPoint: p.pain_point, count: p.count, severity: p.severity }))
      ),
      positiveSignals: sortByCountDesc(
        parsed.positive_signals.map((s) => ({ signal: s.signal, count: s.count, type: s.type }))
      ),
      objections: sortByCountDesc(
        parsed.objections.map((o) => ({ objection: o.objection, count: o.count, type: o.type }))
      ),
      sentimentSummary: parsed.sentiment_summary || '',
      purchaseIntentScore: score,
      viralPotential: parsed.viral_potential?.toLowerCase() || 'low',
      keyTakeaway: parsed.key_takeaway || '',
    };
  }
}

let defaultInstance: CommentAnalyzer | null = null;

export function getCommentAnalyzer(_apiKey?: string): CommentAnalyzer {
  if (!defaultInstance) {
    // apiKey is ignored; OpenRouter client is configured globally
    defaultInstance = new CommentAnalyzer();
  }
  return defaultInstance;
}

/** Legacy: analyze from string array, returns CommentAnalysisResult for backward compat. */
export async function analyzeComments(comments: string[]): Promise<import('../../types/analysis.types.js').CommentAnalysisResult> {
  const scraped: ScrapedComment[] = comments.map((text) => ({ text, likes: 0, replies: 0, postedAt: null }));
  const analyzer = getCommentAnalyzer();
  const result = await analyzer.analyzeComments({
    comments: scraped,
    videoCaption: '',
    platform: 'unknown',
  });
  const themes = [
    ...result.topQuestions.map((q) => q.question),
    ...result.painPoints.map((p) => p.painPoint),
    ...result.positiveSignals.map((s) => s.signal),
  ];
  return {
    sentiment: result.purchaseIntentScore >= 60 ? 'positive' : result.purchaseIntentScore <= 40 ? 'negative' : 'neutral',
    themes: themes.slice(0, 10),
    painPoints: result.painPoints.map((p) => p.painPoint),
    desires: result.positiveSignals.map((s) => s.signal),
    sampleComments: result.topQuestions.slice(0, 5).map((q) => q.question),
  };
}
