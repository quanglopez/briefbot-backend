import { createAnalyzeWorker, type AnalyzeJobInstance } from './queue.manager.js';
import { getSupabase } from '../../config/supabase.js';
import { getVideoAnalyzer } from '../analyzers/video.analyzer.js';
import { analyzeComments } from '../analyzers/comment.analyzer.js';
import { logger } from '../../utils/logger.js';

export function startAnalyzeWorker(): void {
  const worker = createAnalyzeWorker(async (job: AnalyzeJobInstance) => {
    const data = job.data;
    await job.updateProgress(0);

    const supabase = getSupabase();
    const { data: videoRow } = await supabase
      .from('videos')
      .select('caption, thumbnail_url, views, likes, comments_count, shares')
      .eq('id', data.videoId)
      .single();

    const analyzer = getVideoAnalyzer();
    const videoResult = await analyzer.analyzeVideo({
      videoUrl: data.videoUrl,
      thumbnailUrl: videoRow?.thumbnail_url ?? null,
      caption: videoRow?.caption ?? '',
      platform: data.platform,
      metrics: {
        views: videoRow?.views ?? 0,
        likes: videoRow?.likes ?? 0,
        comments: videoRow?.comments_count ?? 0,
        shares: videoRow?.shares ?? 0,
      },
    });
    await job.updateProgress(50);

    const { error: analysisError } = await supabase.from('video_analyses').insert({
      video_id: data.videoId,
      project_id: data.projectId,
      user_id: data.userId,
      hook_analysis: videoResult.hookAnalysis,
      content_structure: videoResult.contentStructure,
      cta_type: videoResult.ctaType,
      emotion_tone: videoResult.emotionTone,
      video_format: videoResult.videoFormat,
      key_messages: videoResult.keyMessages,
      strengths: videoResult.strengths,
      weaknesses: videoResult.weaknesses,
      ai_score: videoResult.aiScore,
      hook_type: videoResult.hookType,
      target_audience_guess: videoResult.targetAudienceGuess,
    });
    if (analysisError) {
      logger.error({ err: analysisError, videoId: data.videoId }, 'Failed to insert video_analyses');
      throw new Error(analysisError.message);
    }

    if (data.analyzeComments) {
      const { data: videoRow } = await supabase.from('videos').select('raw_comments').eq('id', data.videoId).single();
      const comments = (videoRow?.raw_comments as Array<{ text?: string }> | null)?.map((c) => c.text ?? '') ?? [];
      const commentResult = await analyzeComments(comments);
      await job.updateProgress(80);

      const { error: commentError } = await supabase.from('comment_insights').insert({
        video_id: data.videoId,
        project_id: data.projectId,
        user_id: data.userId,
        sentiment: commentResult.sentiment,
        themes: commentResult.themes,
        pain_points: commentResult.painPoints,
        desires: commentResult.desires,
        sample_comments: commentResult.sampleComments,
      });
      if (commentError) {
        logger.error({ err: commentError, videoId: data.videoId }, 'Failed to insert comment_insights');
      }
    }

    await job.updateProgress(100);

    const { count, error: countError } = await supabase
      .from('videos')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', data.projectId);
    if (countError) return;
    const totalVideos = count ?? 0;

    const { count: analyzedCount, error: analyzedErr } = await supabase
      .from('video_analyses')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', data.projectId);
    if (analyzedErr) return;
    const analyzed = analyzedCount ?? 0;

    if (totalVideos > 0 && analyzed >= totalVideos) {
      await supabase
        .from('projects')
        .update({ status: 'briefing' })
        .eq('id', data.projectId)
        .eq('user_id', data.userId);
      logger.info({ projectId: data.projectId, jobId: job.id }, 'Project analysis complete, status = briefing');
    }
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err, data: job?.data }, 'Analyze job failed');
  });

  logger.info('Analyze worker started (analyze-jobs queue)');
}
