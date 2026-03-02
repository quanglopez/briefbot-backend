import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import scraperRoutes from './routes/scraper.routes.js';
import analysisRoutes from './routes/analysis.routes.js';
import briefRoutes from './routes/brief.routes.js';
import webhookRoutes from './routes/webhook.routes.js';
import { startScrapeWorker } from './services/queue/scrape.worker.js';
import { startAnalyzeWorker } from './services/queue/analyze.worker.js';
import { notFoundHandler, globalErrorHandler } from './middleware/error.middleware.js';

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.use('/api/scrape', scraperRoutes);
app.use('/api/analyze', analysisRoutes);
app.use('/api/brief', briefRoutes);
app.use('/api/webhook', webhookRoutes);

// 404 + global error handling
app.use(notFoundHandler);
app.use(globalErrorHandler);

startScrapeWorker();
startAnalyzeWorker();

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'BriefBot backend listening');
});

