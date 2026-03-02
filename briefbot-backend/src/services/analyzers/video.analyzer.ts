import { z } from 'zod';
import { VIDEO_ANALYSIS_PROMPT } from '../generators/prompt.templates.js';
import type { VideoAnalysisResult } from '../../types/analysis.types.js';
import { logger } from '../../utils/logger.js';
import { AI_MODELS } from '../../config/ai.js';
import { callAI } from '../../utils/ai-client.js';

const BATCH_DELAY_MS = 2000;

const aiResponseSchema = z.object({
  hook_analysis: z.string(),
  content_structure: z.string(),
  cta_type: z.string().nullable(),
  emotion_tone: z.string(),
  video_format: z.string(),
  key_messages: z.array(z.string()),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  ai_score: z.number().min(0).max(100),
  hook_type: z.string(),
  target_audience_guess: z.string(),
});

function toResult(parsed: z.infer<typeof aiResponseSchema>): VideoAnalysisResult {
  return {
    hookAnalysis: parsed.hook_analysis,
    contentStructure: parsed.content_structure,
    ctaType: parsed.cta_type,
    emotionTone: parsed.emotion_tone,
    videoFormat: parsed.video_format,
    keyMessages: parsed.key_messages,
    strengths: parsed.strengths,
    weaknesses: parsed.weaknesses,
    aiScore: parsed.ai_score,
    hookType: parsed.hook_type,
    targetAudienceGuess: parsed.target_audience_guess,
  };
}

export interface AnalyzeVideoParams {
  videoUrl: string;
  thumbnailUrl: string | null;
  caption: string;
  platform: string;
  metrics: { views: number; likes: number; comments: number; shares: number };
}

export interface VideoForAnalysis extends AnalyzeVideoParams {
  videoUrl: string;
  thumbnailUrl: string | null;
  caption: string;
  platform: string;
  metrics: { views: number; likes: number; comments: number; shares: number };
}

export class VideoAnalyzer {
  constructor() {}

  async analyzeVideo(params: AnalyzeVideoParams): Promise<VideoAnalysisResult> {
    const { thumbnailUrl, caption, platform, metrics } = params;
    const description = this.buildVideoDescription(caption, metrics, thumbnailUrl ?? undefined);
    const prompt = VIDEO_ANALYSIS_PROMPT(description, platform);

    try {
      const raw = await callAI<z.infer<typeof aiResponseSchema>>({
        model: AI_MODELS.VIDEO_ANALYSIS,
        systemPrompt:
          'You are a video marketing analysis expert. Always respond in Vietnamese. Output valid JSON only, no markdown.',
        userPrompt: prompt,
        temperature: 0.3,
        maxTokens: 2000,
        images: thumbnailUrl ? [thumbnailUrl] : undefined,
        jsonMode: true,
      });
      const parsed = aiResponseSchema.parse(raw);
      return toResult(parsed);
    } catch (e) {
      logger.warn({ err: e }, 'Video analysis via OpenRouter failed');
      return this.emptyResult();
    }
  }

  async analyzeBatch(videos: VideoForAnalysis[]): Promise<VideoAnalysisResult[]> {
    const results: VideoAnalysisResult[] = [];
    for (let i = 0; i < videos.length; i += 1) {
      try {
        const out = await this.analyzeVideo(videos[i]!);
        results.push(out);
      } catch (e) {
        logger.warn({ err: e, index: i, videoUrl: videos[i]?.videoUrl }, 'Video analysis failed in batch');
        results.push(this.emptyResult());
      }
      if (i < videos.length - 1) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }
    return results;
  }

  private buildVideoDescription(
    caption: string,
    metrics: { views: number; likes: number; comments: number; shares: number },
    thumbnailHint?: string
  ): string {
    const lines = [
      `Caption: ${caption || '(không có)'}`,
      `Views: ${metrics.views} | Likes: ${metrics.likes} | Comments: ${metrics.comments} | Shares: ${metrics.shares}`,
    ];
    if (thumbnailHint) {
      lines.push(`(Thumbnail/context: ${thumbnailHint})`);
    }
    return lines.join('\n');
  }

  private emptyResult(): VideoAnalysisResult {
    return {
      hookAnalysis: '',
      contentStructure: '',
      ctaType: null,
      emotionTone: '',
      videoFormat: 'other',
      keyMessages: [],
      strengths: [],
      weaknesses: [],
      aiScore: 0,
      hookType: 'other',
      targetAudienceGuess: '',
    };
  }
}

/** Singleton helper using env GEMINI_API_KEY (for backward compat). */
let defaultInstance: VideoAnalyzer | null = null;

export function getVideoAnalyzer(): VideoAnalyzer {
  if (!defaultInstance) {
    defaultInstance = new VideoAnalyzer();
  }
  return defaultInstance;
}

/** Analyze a single video (legacy function using default analyzer). */
export async function analyzeVideo(
  videoPathOrUrl: string,
  params?: Partial<Omit<AnalyzeVideoParams, 'videoUrl'>>
): Promise<VideoAnalysisResult> {
  const analyzer = getVideoAnalyzer();
  return analyzer.analyzeVideo({
    videoUrl: videoPathOrUrl,
    thumbnailUrl: params?.thumbnailUrl ?? null,
    caption: params?.caption ?? '',
    platform: params?.platform ?? 'unknown',
    metrics: params?.metrics ?? { views: 0, likes: 0, comments: 0, shares: 0 },
  });
}
