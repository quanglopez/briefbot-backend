import { z } from 'zod';
import {
  BRIEF_GENERATION_PROMPT,
  SCRIPT_OUTLINE_PROMPT,
  type BrandBible,
  type VideoAnalysis,
  type CommentInsight,
  type Brief,
} from './prompt.templates.js';
import { getSupabase } from '../../config/supabase.js';
import type { VideoAnalysisResult } from '../../types/analysis.types.js';
import type { CommentInsightResult } from '../../types/analysis.types.js';
import type { GeneratedBrief, GeneratedScriptOutline } from '../../types/brief.types.js';
import { logger } from '../../utils/logger.js';
import { AI_MODELS } from '../../config/ai.js';
import { callAI } from '../../utils/ai-client.js';

const SYSTEM_PROMPT =
  'You are a senior Creative Director at a top Vietnamese advertising agency. Respond only in Vietnamese. Output valid JSON only, no markdown or explanation.';
const MAX_TOKENS = 4000;
const TEMPERATURE = 0.7;

const rawBriefSchema = z.object({
  title: z.string(),
  objective: z.string(),
  target_audience: z.string(),
  key_insight: z.string(),
  hook_suggestions: z.array(
    z.object({
      hook_text: z.string(),
      hook_type: z.string(),
      rationale: z.string(),
      reference_video_index: z.number().optional(),
    })
  ),
  content_directions: z.array(
    z.object({
      direction: z.string(),
      rationale: z.string(),
      format_suggestion: z.string(),
      estimated_performance: z.string().optional(),
    })
  ),
  script_outline: z.string(),
  tone_guidance: z.string(),
  do_list: z.array(z.string()),
  dont_list: z.array(z.string()),
  reference_video_indices: z.array(z.number()),
});

const rawScriptSchema = z.object({
  total_duration_seconds: z.number(),
  scenes: z.array(
    z.object({
      scene_number: z.number(),
      duration_seconds: z.number(),
      type: z.string(),
      visual_description: z.string(),
      audio_text: z.string(),
      text_overlay: z.string(),
      music_mood: z.string(),
      notes: z.string(),
    })
  ),
  overall_notes: z.string(),
  hashtag_suggestions: z.array(z.string()),
  posting_time_suggestion: z.string(),
});

function toVideoAnalysis(v: VideoAnalysisResult): VideoAnalysis {
  return {
    hook_analysis: v.hookAnalysis,
    content_structure: v.contentStructure,
    cta_type: v.ctaType ?? undefined,
    emotion_tone: v.emotionTone,
    video_format: v.videoFormat,
    key_messages: v.keyMessages,
    strengths: v.strengths,
    weaknesses: v.weaknesses,
    ai_score: v.aiScore,
    hook_type: v.hookType,
    target_audience_guess: v.targetAudienceGuess,
  };
}

function toCommentInsight(c: CommentInsightResult): CommentInsight {
  return {
    top_questions: c.topQuestions.map((q) => ({ question: q.question, count: q.count, sentiment: q.sentiment })),
    pain_points: c.painPoints.map((p) => ({ pain_point: p.painPoint, count: p.count, severity: p.severity })),
    positive_signals: c.positiveSignals.map((s) => ({ signal: s.signal, count: s.count, type: s.type })),
    objections: c.objections.map((o) => ({ objection: o.objection, count: o.count, type: o.type })),
    sentiment_summary: c.sentimentSummary,
    purchase_intent_score: c.purchaseIntentScore,
    viral_potential: c.viralPotential,
    key_takeaway: c.keyTakeaway,
  };
}

export interface GenerateBriefParams {
  projectId: string;
  clientId: string;
  userId: string;
  clientName: string;
  brandBible: BrandBible;
  briefTemplate?: string;
  videoAnalyses: VideoAnalysisResult[];
  commentInsights: CommentInsightResult[];
  videoIds: string[];
  keywords: string[];
  platform: string;
}

export class BriefGenerator {
  constructor() {}

  async generateBrief(params: GenerateBriefParams): Promise<GeneratedBrief> {
    const sortedVideos = [...params.videoAnalyses].sort((a, b) => b.aiScore - a.aiScore);
    const videoAnalysesForPrompt = sortedVideos.map(toVideoAnalysis);
    const commentInsightsForPrompt = params.commentInsights.map(toCommentInsight);

    const promptParams = {
      clientName: params.clientName,
      brandBible: params.brandBible,
      briefTemplate: params.briefTemplate,
      videoAnalyses: videoAnalysesForPrompt,
      commentInsights: commentInsightsForPrompt,
      projectKeywords: params.keywords,
      platform: params.platform,
    };
    const prompt = BRIEF_GENERATION_PROMPT(promptParams);

    const raw = await this.callModel(prompt);
    const parsed = rawBriefSchema.parse(raw);

    const referenceVideoIds = parsed.reference_video_indices
      .map((i) => params.videoIds[i])
      .filter((id): id is string => !!id);

    const hookSuggestionsWithIds = parsed.hook_suggestions.map((h) => ({
      hook_text: h.hook_text,
      hook_type: h.hook_type,
      rationale: h.rationale,
      reference_video_id: h.reference_video_index != null ? params.videoIds[h.reference_video_index] ?? null : null,
    }));

    const briefRow = {
      project_id: params.projectId,
      client_id: params.clientId,
      user_id: params.userId,
      title: parsed.title,
      objective: parsed.objective,
      target_audience: parsed.target_audience,
      key_insight: parsed.key_insight,
      hook_suggestions: hookSuggestionsWithIds,
      content_directions: parsed.content_directions,
      script_outline: parsed.script_outline,
      tone_guidance: parsed.tone_guidance,
      do_list: parsed.do_list,
      dont_list: parsed.dont_list,
      reference_video_ids: referenceVideoIds,
      status: 'draft',
      generated_at: new Date().toISOString(),
      model_used: AI_MODELS.BRIEF_GENERATION,
      token_count: null,
      script_outline_detail: null,
    };

    const supabase = getSupabase();
    const { data: inserted, error } = await supabase
      .from('briefs')
      .insert(briefRow)
      .select('id')
      .single();

    if (error) {
      logger.error({ err: error, projectId: params.projectId }, 'Failed to save brief');
      throw new Error(error.message);
    }

    await supabase
      .from('projects')
      .update({ status: 'completed' })
      .eq('id', params.projectId)
      .eq('user_id', params.userId);

    return { ...briefRow, id: inserted.id } as GeneratedBrief;
  }

  async regenerateBrief(briefId: string, feedback: string): Promise<GeneratedBrief> {
    const supabase = getSupabase();
    const { data: brief, error: briefErr } = await supabase
      .from('briefs')
      .select('*')
      .eq('id', briefId)
      .single();

    if (briefErr || !brief) throw new Error('Brief not found');

    const videoAnalyses: VideoAnalysisResult[] = [];
    const commentInsights: CommentInsightResult[] = [];
    const videoIds: string[] = [];

    const { data: analyses } = await supabase
      .from('video_analyses')
      .select('*')
      .eq('project_id', brief.project_id);

    if (analyses) {
      for (const row of analyses) {
        const v = row as Record<string, unknown>;
        videoIds.push(String(v.video_id ?? ''));
        videoAnalyses.push({
          hookAnalysis: String(v.hook_analysis ?? ''),
          contentStructure: String(v.content_structure ?? ''),
          ctaType: v.cta_type ? String(v.cta_type) : null,
          emotionTone: String(v.emotion_tone ?? ''),
          videoFormat: String(v.video_format ?? ''),
          keyMessages: Array.isArray(v.key_messages) ? v.key_messages as string[] : [],
          strengths: Array.isArray(v.strengths) ? v.strengths as string[] : [],
          weaknesses: Array.isArray(v.weaknesses) ? v.weaknesses as string[] : [],
          aiScore: Number(v.ai_score ?? 0),
          hookType: String(v.hook_type ?? ''),
          targetAudienceGuess: String(v.target_audience_guess ?? ''),
        });
      }
    }

    const { data: insights } = await supabase
      .from('comment_insights')
      .select('*')
      .eq('project_id', brief.project_id);

    if (insights) {
      for (const row of insights) {
        const c = row as Record<string, unknown>;
        const themes = Array.isArray(c.themes) ? (c.themes as string[]) : [];
        const painPointsRaw = Array.isArray(c.pain_points) ? (c.pain_points as string[]) : [];
        const desires = Array.isArray(c.desires) ? (c.desires as string[]) : [];
        commentInsights.push({
          totalCommentsScraped: themes.length + painPointsRaw.length + desires.length,
          topQuestions: themes.map((q) => ({ question: q, count: 1, sentiment: String(c.sentiment ?? 'neutral') })),
          painPoints: painPointsRaw.map((p) => ({ painPoint: p, count: 1, severity: 'medium' })),
          positiveSignals: desires.map((s) => ({ signal: s, count: 1, type: 'satisfaction' })),
          objections: [],
          sentimentSummary: String(c.sentiment ?? ''),
          purchaseIntentScore: c.sentiment === 'positive' ? 65 : c.sentiment === 'negative' ? 35 : 50,
          viralPotential: 'medium',
          keyTakeaway: themes[0] ?? (Array.isArray(c.sample_comments) ? (c.sample_comments as string[])[0] : '') ?? '',
        });
      }
    }

    const { data: clientRow } = await supabase.from('clients').select('name, tone_of_voice, target_audience, brand_values, key_messages, do_list, dont_list').eq('id', brief.client_id).single();
    const brandBible: BrandBible = clientRow
      ? {
          tone_of_voice: String(clientRow.tone_of_voice ?? ''),
          target_audience: String(clientRow.target_audience ?? ''),
          brand_values: String(clientRow.brand_values ?? ''),
          key_messages: String(clientRow.key_messages ?? ''),
          do_list: String(clientRow.do_list ?? ''),
          dont_list: String(clientRow.dont_list ?? ''),
        }
      : { tone_of_voice: '', target_audience: '', brand_values: '', key_messages: '', do_list: '', dont_list: '' };

    const promptParams = {
      clientName: (clientRow?.name as string) ?? 'Client',
      brandBible,
      videoAnalyses: videoAnalyses.map(toVideoAnalysis),
      commentInsights: commentInsights.map(toCommentInsight),
      projectKeywords: [],
      platform: 'unknown',
    };
    const basePrompt = BRIEF_GENERATION_PROMPT(promptParams);
    const promptWithFeedback = `${basePrompt}\n\n---\nBrief trước đã được review. Feedback: ${feedback}\nHãy điều chỉnh brief theo feedback trên và trả về JSON đúng format.`;

    const raw = await this.callModel(promptWithFeedback);
    const parsed = rawBriefSchema.parse(raw);

    const referenceVideoIds = parsed.reference_video_indices.map((i) => videoIds[i]).filter(Boolean);
    const hookSuggestionsWithIds = parsed.hook_suggestions.map((h) => ({
      hook_text: h.hook_text,
      hook_type: h.hook_type,
      rationale: h.rationale,
      reference_video_id: h.reference_video_index != null ? videoIds[h.reference_video_index] ?? null : null,
    }));

    const updated: Partial<GeneratedBrief> = {
      title: parsed.title,
      objective: parsed.objective,
      target_audience: parsed.target_audience,
      key_insight: parsed.key_insight,
      hook_suggestions: hookSuggestionsWithIds,
      content_directions: parsed.content_directions,
      script_outline: parsed.script_outline,
      tone_guidance: parsed.tone_guidance,
      do_list: parsed.do_list,
      dont_list: parsed.dont_list,
      reference_video_ids: referenceVideoIds,
      generated_at: new Date().toISOString(),
      version: (brief.version ?? 1) + 1,
    };

    const { data: updatedRow, error: updateErr } = await supabase
      .from('briefs')
      .update(updated)
      .eq('id', briefId)
      .select()
      .single();

    if (updateErr) throw new Error(updateErr.message);
    return updatedRow as GeneratedBrief;
  }

  async generateScriptOutline(briefId: string, platform: string): Promise<GeneratedScriptOutline> {
    const supabase = getSupabase();
    const { data: brief, error } = await supabase.from('briefs').select('*').eq('id', briefId).single();
    if (error || !brief) throw new Error('Brief not found');

    const { data: clientRow } = await supabase.from('clients').select('*').eq('id', brief.client_id).single();
    const brandBible: BrandBible = clientRow
      ? {
          tone_of_voice: String(clientRow.tone_of_voice ?? ''),
          target_audience: String(clientRow.target_audience ?? ''),
          brand_values: String(clientRow.brand_values ?? ''),
          key_messages: String(clientRow.key_messages ?? ''),
          do_list: String(clientRow.do_list ?? ''),
          dont_list: String(clientRow.dont_list ?? ''),
        }
      : { tone_of_voice: '', target_audience: '', brand_values: '', key_messages: '', do_list: '', dont_list: '' };

    const briefForPrompt: Brief = {
      title: brief.title,
      objective: brief.objective,
      target_audience: brief.target_audience,
      key_insight: brief.key_insight,
      hook_suggestions: brief.hook_suggestions,
      content_directions: brief.content_directions,
      script_outline: brief.script_outline,
      tone_guidance: brief.tone_guidance,
      do_list: brief.do_list,
      dont_list: brief.dont_list,
    };

    const prompt = SCRIPT_OUTLINE_PROMPT(briefForPrompt, brandBible, platform);
    let parsed: z.infer<typeof rawScriptSchema>;
    try {
      const raw = await callAI<z.infer<typeof rawScriptSchema>>({
        model: AI_MODELS.BRIEF_GENERATION,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: prompt,
        maxTokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        jsonMode: true,
      });
      parsed = rawScriptSchema.parse(raw);
    } catch {
      parsed = rawScriptSchema.parse({
        total_duration_seconds: 30,
        scenes: [],
        overall_notes: '',
        hashtag_suggestions: [],
        posting_time_suggestion: '',
      });
    }

    const scriptDetail: GeneratedScriptOutline = {
      total_duration_seconds: parsed.total_duration_seconds,
      scenes: parsed.scenes,
      overall_notes: parsed.overall_notes,
      hashtag_suggestions: parsed.hashtag_suggestions,
      posting_time_suggestion: parsed.posting_time_suggestion,
    };

    await supabase.from('briefs').update({ script_outline_detail: scriptDetail }).eq('id', briefId);
    return scriptDetail;
  }

  private async callModel(prompt: string): Promise<z.infer<typeof rawBriefSchema>> {
    const raw = await callAI<z.infer<typeof rawBriefSchema>>({
      model: AI_MODELS.BRIEF_GENERATION,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: prompt,
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      jsonMode: true,
    });
    return rawBriefSchema.parse(raw);
  }
}

let defaultInstance: BriefGenerator | null = null;

export function getBriefGenerator(_apiKey?: string): BriefGenerator {
  if (!defaultInstance) {
    // apiKey is ignored; OpenRouter client is configured globally
    defaultInstance = new BriefGenerator();
  }
  return defaultInstance;
}

/** Legacy: generate from CombinedAnalysis (backward compat). */
export async function generateBrief(
  analysis: import('../../types/analysis.types.js').CombinedAnalysis
): Promise<import('../../types/brief.types.js').CreativeBrief> {
  const c = analysis.comments;
  const commentInsight: CommentInsightResult = {
    totalCommentsScraped: c.sampleComments.length,
    topQuestions: c.themes.slice(0, 5).map((q) => ({ question: q, count: 1, sentiment: c.sentiment })),
    painPoints: c.painPoints.map((p) => ({ painPoint: p, count: 1, severity: 'medium' })),
    positiveSignals: c.desires.map((s) => ({ signal: s, count: 1, type: 'satisfaction' })),
    objections: [],
    sentimentSummary: c.sentiment,
    purchaseIntentScore: c.sentiment === 'positive' ? 65 : c.sentiment === 'negative' ? 35 : 50,
    viralPotential: 'medium',
    keyTakeaway: c.themes[0] ?? c.sampleComments[0] ?? '',
  };
  const generator = getBriefGenerator();
  const result = await generator.generateBrief({
    projectId: '',
    clientId: '',
    userId: '',
    clientName: 'Client',
    brandBible: { tone_of_voice: '', target_audience: '', brand_values: '', key_messages: '', do_list: '', dont_list: '' },
    videoAnalyses: [analysis.video],
    commentInsights: [commentInsight],
    videoIds: [],
    keywords: [],
    platform: 'unknown',
  });
  return {
    id: result.id,
    title: result.title,
    objective: result.objective,
    targetAudience: result.target_audience,
    keyMessage: result.key_insight,
    tone: result.tone_guidance,
    callToAction: '',
  };
}
