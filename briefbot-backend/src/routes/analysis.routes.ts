import { Router } from 'express';
import { z } from 'zod';
import { getSupabase } from '../config/supabase.js';
import { analyzeJobsQueue } from '../services/queue/queue.manager.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { trackAnalysisUsage } from '../middleware/usage.middleware.js';
import { rateLimitPerUser } from '../middleware/rate-limit.middleware.js';
import { catchAsync } from '../utils/catch-async.js';
import { AppError } from '../utils/errors.js';

const router = Router();

// Keep legacy direct-analysis endpoints for backward compatibility
const legacyAnalyzeVideoSchema = z.object({
  videoPath: z.string().min(1),
});

const legacyAnalyzeCommentsSchema = z.object({
  comments: z.array(z.string()),
});

router.post(
  '/video',
  catchAsync(async (req, res) => {
    const { analyzeVideo } = await import('../services/analyzers/video.analyzer.js');
    const parsed = legacyAnalyzeVideoSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('Invalid body', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: parsed.error.issues,
      });
    }
    const result = await analyzeVideo(parsed.data.videoPath);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/comments',
  catchAsync(async (req, res) => {
    const { analyzeComments } = await import('../services/analyzers/comment.analyzer.js');
    const parsed = legacyAnalyzeCommentsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('Invalid body', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: parsed.error.issues,
      });
    }
    const result = await analyzeComments(parsed.data.comments);
    res.json({ success: true, data: result });
  })
);

// New queued-analysis APIs
router.use(requireAuth, rateLimitPerUser, trackAnalysisUsage);

const analyzeVideoParamsSchema = z.object({
  videoId: z.string().uuid(),
});

const analyzeBatchBodySchema = z.object({
  videoIds: z.array(z.string().uuid()).min(1),
});

/** POST /api/analyze/video/:videoId — queue analysis for 1 video */
router.post(
  '/video/:videoId',
  catchAsync(async (req, res) => {
    const params = analyzeVideoParamsSchema.safeParse({ videoId: req.params.videoId });
    if (!params.success) {
      throw new AppError('Invalid params', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: params.error.issues,
      });
    }

    const supabase = getSupabase();
    const { data: video, error } = await supabase
      .from('videos')
      .select('*')
      .eq('id', params.data.videoId)
      .eq('user_id', req.user!.id)
      .single();

    if (error || !video) {
      throw new AppError('Video not found', {
        code: 'VIDEO_NOT_FOUND',
        statusCode: 404,
        details: error ?? undefined,
      });
    }

    const job = await analyzeJobsQueue.add('analyze-video', {
      videoId: video.id,
      projectId: video.project_id,
      userId: req.user!.id,
      platform: video.platform,
      videoUrl: video.video_url,
      analyzeComments: true,
    });

    res.status(202).json({
      success: true,
      data: {
        jobId: job.id,
      },
    });
  })
);

/** POST /api/analyze/batch — queue analysis for multiple videos */
router.post(
  '/batch',
  catchAsync(async (req, res) => {
    const parsed = analyzeBatchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('Invalid body', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: parsed.error.issues,
      });
    }

    const supabase = getSupabase();
    const { data: videos, error } = await supabase
      .from('videos')
      .select('*')
      .in('id', parsed.data.videoIds)
      .eq('user_id', req.user!.id);

    if (error) {
      throw new AppError('Failed to load videos', {
        code: 'VIDEOS_LOAD_FAILED',
        statusCode: 500,
        details: error,
      });
    }

    const jobs = await Promise.all(
      (videos ?? []).map((video) =>
        analyzeJobsQueue.add('analyze-video', {
          videoId: video.id,
          projectId: video.project_id,
          userId: req.user!.id,
          platform: video.platform,
          videoUrl: video.video_url,
          analyzeComments: true,
        })
      )
    );

    res.status(202).json({
      success: true,
      data: {
        jobIds: jobs.map((j) => j.id),
      },
    });
  })
);

/** GET /api/analyze/video/:videoId — get analysis result */
router.get(
  '/video/:videoId',
  catchAsync(async (req, res) => {
    const params = analyzeVideoParamsSchema.safeParse({ videoId: req.params.videoId });
    if (!params.success) {
      throw new AppError('Invalid params', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: params.error.issues,
      });
    }

    const supabase = getSupabase();

    const { data: videoAnalysis } = await supabase
      .from('video_analyses')
      .select('*')
      .eq('video_id', params.data.videoId)
      .eq('user_id', req.user!.id)
      .maybeSingle();

    const { data: commentInsight } = await supabase
      .from('comment_insights')
      .select('*')
      .eq('video_id', params.data.videoId)
      .eq('user_id', req.user!.id)
      .maybeSingle();

    if (!videoAnalysis && !commentInsight) {
      throw new AppError('Analysis not found', {
        code: 'ANALYSIS_NOT_FOUND',
        statusCode: 404,
      });
    }

    res.json({
      success: true,
      data: {
        videoAnalysis,
        commentInsight,
      },
    });
  })
);

/** GET /api/analyze/project/:projectId/summary — aggregated analysis summary */
router.get(
  '/project/:projectId/summary',
  catchAsync(async (req, res) => {
    const projectIdSchema = z.object({ projectId: z.string().uuid() });
    const params = projectIdSchema.safeParse({ projectId: req.params.projectId });
    if (!params.success) {
      throw new AppError('Invalid params', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: params.error.issues,
      });
    }

    const supabase = getSupabase();

    const { data: videoAnalyses, error: vaError } = await supabase
      .from('video_analyses')
      .select('*')
      .eq('project_id', params.data.projectId)
      .eq('user_id', req.user!.id);

    if (vaError) {
      throw new AppError('Failed to load video analyses', {
        code: 'VIDEO_ANALYSES_LOAD_FAILED',
        statusCode: 500,
        details: vaError,
      });
    }

    const { data: commentInsights, error: ciError } = await supabase
      .from('comment_insights')
      .select('*')
      .eq('project_id', params.data.projectId)
      .eq('user_id', req.user!.id);

    if (ciError) {
      throw new AppError('Failed to load comment insights', {
        code: 'COMMENT_INSIGHTS_LOAD_FAILED',
        statusCode: 500,
        details: ciError,
      });
    }

    const count = videoAnalyses?.length ?? 0;
    const avgScore =
      count > 0
        ? (videoAnalyses as any[]).reduce((sum, va) => sum + (va.ai_score ?? 0), 0) / count
        : null;

    res.json({
      success: true,
      data: {
        projectId: params.data.projectId,
        videoAnalyses,
        commentInsights,
        summary: {
          totalVideosAnalyzed: count,
          averageScore: avgScore,
        },
      },
    });
  })
);

export default router;

