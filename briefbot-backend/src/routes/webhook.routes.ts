import { Router } from 'express';
import { logger } from '../utils/logger.js';
import { emitScrapeProgress, emitAnalysisComplete } from '../utils/realtime.js';
import { catchAsync } from '../utils/catch-async.js';

const router = Router();

/** POST /api/webhook/job-complete — BullMQ completion webhook */
router.post(
  '/job-complete',
  catchAsync(async (req, res) => {
    const { type, projectId, payload } = req.body as {
      type?: 'scrape' | 'analyze';
      projectId?: string;
      payload?: unknown;
    };

    if (!type || !projectId) {
      res.status(400).json({ success: false, error: { code: 'INVALID_WEBHOOK', message: 'Missing type or projectId' } });
      return;
    }

    logger.info({ type, projectId, payload }, 'Job complete webhook received');

    if (type === 'scrape') {
      await emitScrapeProgress(projectId, payload ?? {});
    } else if (type === 'analyze') {
      await emitAnalysisComplete(projectId, payload ?? {});
    }

    res.json({ success: true });
  })
);

/** POST /api/webhook/supabase — Supabase realtime webhook (for frontend updates) */
router.post(
  '/supabase',
  catchAsync(async (req, res) => {
    logger.info({ body: req.body }, 'Supabase webhook received');
    // This endpoint can be extended to perform additional side-effects server-side
    res.json({ success: true });
  })
);

export default router;

