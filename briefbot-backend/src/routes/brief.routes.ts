import { Router } from 'express';
import { z } from 'zod';
import { getSupabase } from '../config/supabase.js';
import { getBriefGenerator } from '../services/generators/brief.generator.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { rateLimitPerUser } from '../middleware/rate-limit.middleware.js';
import { trackBriefUsage } from '../middleware/usage.middleware.js';
import { catchAsync } from '../utils/catch-async.js';
import { AppError } from '../utils/errors.js';
import type { VideoAnalysisResult } from '../types/analysis.types.js';
import type { CommentInsightResult } from '../types/analysis.types.js';

const router = Router();

router.use(requireAuth, rateLimitPerUser);

/** GET /api/brief/project/:projectId — list briefs for project (must be before /:id) */
router.get(
  '/project/:projectId',
  catchAsync(async (req, res) => {
    const { projectId } = req.params;
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('briefs')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', req.user!.id)
      .order('generated_at', { ascending: false });
    if (error) {
      throw new AppError('Failed to load briefs', {
        code: 'BRIEFS_LOAD_FAILED',
        statusCode: 500,
        details: error,
      });
    }
    res.json({ success: true, data: { briefs: data ?? [] } });
  })
);

const brandBibleSchema = z.object({
  tone_of_voice: z.string(),
  target_audience: z.string(),
  brand_values: z.string(),
  key_messages: z.string(),
  do_list: z.string(),
  dont_list: z.string(),
});

const generateBodySchema = z.object({
  projectId: z.string().uuid(),
  clientId: z.string().uuid(),
  clientName: z.string().min(1),
  brandBible: brandBibleSchema,
  briefTemplate: z.string().optional(),
  videoAnalyses: z.array(z.any()),
  commentInsights: z.array(z.any()),
  videoIds: z.array(z.string()),
  keywords: z.array(z.string()),
  platform: z.string(),
});

/** POST /api/brief/generate */
router.post(
  '/generate',
  trackBriefUsage,
  catchAsync(async (req, res) => {
    const parsed = generateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('Invalid body', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: parsed.error.issues,
      });
    }
    const userId = req.user!.id;
    const generator = getBriefGenerator();
    const result = await generator.generateBrief({
      ...parsed.data,
      userId,
      videoAnalyses: parsed.data.videoAnalyses as VideoAnalysisResult[],
      commentInsights: parsed.data.commentInsights as CommentInsightResult[],
    });
    res.json({ success: true, data: result });
  })
);

const regenerateBodySchema = z.object({
  feedback: z.string().min(1),
});

/** POST /api/brief/:id/regenerate */
router.post(
  '/:id/regenerate',
  catchAsync(async (req, res) => {
    const { id } = req.params;
    const parsed = regenerateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('Invalid body', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: parsed.error.issues,
      });
    }
    const supabase = getSupabase();
    const { data: brief } = await supabase.from('briefs').select('user_id').eq('id', id).single();
    if (!brief || brief.user_id !== req.user!.id) {
      throw new AppError('Brief not found', {
        code: 'BRIEF_NOT_FOUND',
        statusCode: 404,
      });
    }
    const generator = getBriefGenerator();
    const result = await generator.regenerateBrief(id, parsed.data.feedback);
    res.json({ success: true, data: result });
  })
);

const scriptBodySchema = z.object({
  platform: z.string().optional(),
});

/** POST /api/brief/:id/script */
router.post(
  '/:id/script',
  catchAsync(async (req, res) => {
    const { id } = req.params;
    const parsed = scriptBodySchema.safeParse(req.body);
    const platform = parsed.success ? parsed.data.platform ?? 'unknown' : 'unknown';
    const supabase = getSupabase();
    const { data: brief } = await supabase.from('briefs').select('user_id').eq('id', id).single();
    if (!brief || brief.user_id !== req.user!.id) {
      throw new AppError('Brief not found', {
        code: 'BRIEF_NOT_FOUND',
        statusCode: 404,
      });
    }
    const generator = getBriefGenerator();
    const result = await generator.generateScriptOutline(id, platform);
    res.json({ success: true, data: result });
  })
);

/** GET /api/brief/:id */
router.get(
  '/:id',
  catchAsync(async (req, res) => {
    const { id } = req.params;
    const supabase = getSupabase();
    const { data, error } = await supabase.from('briefs').select('*').eq('id', id).eq('user_id', req.user!.id).single();
    if (error || !data) {
      throw new AppError('Brief not found', {
        code: 'BRIEF_NOT_FOUND',
        statusCode: 404,
        details: error ?? undefined,
      });
    }
    res.json({ success: true, data });
  })
);

const updateBriefSchema = z.object({
  title: z.string().optional(),
  objective: z.string().optional(),
  target_audience: z.string().optional(),
  key_insight: z.string().optional(),
  hook_suggestions: z.array(z.any()).optional(),
  content_directions: z.array(z.any()).optional(),
  script_outline: z.string().optional(),
  tone_guidance: z.string().optional(),
  do_list: z.array(z.string()).optional(),
  dont_list: z.array(z.string()).optional(),
});

/** PUT /api/brief/:id */
router.put(
  '/:id',
  catchAsync(async (req, res) => {
    const { id } = req.params;
    const parsed = updateBriefSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('Invalid body', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: parsed.error.issues,
      });
    }
    const supabase = getSupabase();
    const { data: existing } = await supabase.from('briefs').select('id').eq('id', id).eq('user_id', req.user!.id).single();
    if (!existing) {
      throw new AppError('Brief not found', {
        code: 'BRIEF_NOT_FOUND',
        statusCode: 404,
      });
    }
    const { data, error } = await supabase.from('briefs').update(parsed.data).eq('id', id).select().single();
    if (error) {
      throw new AppError('Failed to update brief', {
        code: 'BRIEF_UPDATE_FAILED',
        statusCode: 500,
        details: error,
      });
    }
    res.json({ success: true, data });
  })
);

const statusSchema = z.object({
  status: z.enum(['draft', 'review', 'approved']),
});

/** PUT /api/brief/:id/status */
router.put(
  '/:id/status',
  catchAsync(async (req, res) => {
    const { id } = req.params;
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('Invalid body', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: parsed.error.issues,
      });
    }
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('briefs')
      .update({ status: parsed.data.status })
      .eq('id', id)
      .eq('user_id', req.user!.id)
      .select()
      .single();
    if (error || !data) {
      throw new AppError('Brief not found', {
        code: 'BRIEF_NOT_FOUND',
        statusCode: 404,
        details: error ?? undefined,
      });
    }
    res.json({ success: true, data });
  })
);

/** POST /api/brief/:id/export/pdf — stub */
router.post(
  '/:id/export/pdf',
  catchAsync(async (req, res) => {
    const { id } = req.params;
    const supabase = getSupabase();
    const { data: brief } = await supabase.from('briefs').select('id').eq('id', id).eq('user_id', req.user!.id).single();
    if (!brief) {
      throw new AppError('Brief not found', {
        code: 'BRIEF_NOT_FOUND',
        statusCode: 404,
      });
    }
    res.status(501).json({
      success: false,
      error: {
        code: 'PDF_EXPORT_NOT_IMPLEMENTED',
        message:
          'PDF export not implemented. Use a PDF library (e.g. puppeteer, @react-pdf/renderer) to generate from brief.',
        details: { briefId: id },
      },
    });
  })
);

export default router;

