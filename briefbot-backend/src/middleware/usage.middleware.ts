import type { NextFunction, Request, Response } from 'express';
import { getSupabase } from '../config/supabase.js';
import { AppError } from '../utils/errors.js';
import type { AuthUser } from './auth.middleware.js';

type Plan = 'free' | 'pro' | 'agency';

interface UsageLimits {
  videos: number | null;
  analyses: number | null;
  briefs: number | null;
}

const PLAN_LIMITS: Record<Plan, UsageLimits> = {
  free: { videos: 5, analyses: 3, briefs: 2 },
  pro: { videos: 50, analyses: 30, briefs: 20 },
  agency: { videos: null, analyses: null, briefs: null },
};

type UsageKind = 'videos' | 'analyses' | 'briefs';

function resolvePlan(user?: AuthUser): Plan {
  if (!user?.plan) return 'free';
  if (user.plan === 'pro' || user.plan === 'agency') return user.plan;
  return 'free';
}

async function getOrInitUsage(userId: string, period: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('usage_stats')
    .select('*')
    .eq('user_id', userId)
    .eq('period', period)
    .maybeSingle();

  if (error) {
    throw new AppError('Failed to load usage', {
      code: 'USAGE_LOAD_FAILED',
      statusCode: 500,
      details: error,
    });
  }

  if (data) return data;

  const { data: inserted, error: insertError } = await supabase
    .from('usage_stats')
    .insert({
      user_id: userId,
      period,
      videos: 0,
      analyses: 0,
      briefs: 0,
    })
    .select()
    .single();

  if (insertError) {
    throw new AppError('Failed to initialize usage', {
      code: 'USAGE_INIT_FAILED',
      statusCode: 500,
      details: insertError,
    });
  }

  return inserted;
}

async function checkAndIncrementUsage(user: AuthUser, kind: UsageKind) {
  const plan = resolvePlan(user);
  const limits = PLAN_LIMITS[plan];
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const usage = await getOrInitUsage(user.id, period);

  const field = kind;
  const current = (usage as any)[field] as number;
  const limit = limits[field];

  if (limit != null && current >= limit) {
    throw new AppError('Usage limit exceeded', {
      code: 'USAGE_EXCEEDED',
      statusCode: 403,
      details: {
        plan,
        period,
        kind,
        current,
        limit,
      },
    });
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from('usage_stats')
    .update({ [field]: current + 1 })
    .eq('user_id', user.id)
    .eq('period', period);

  if (error) {
    throw new AppError('Failed to update usage', {
      code: 'USAGE_UPDATE_FAILED',
      statusCode: 500,
      details: error,
    });
  }
}

function makeUsageMiddleware(kind: UsageKind) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      next(
        new AppError('Unauthorized', {
          code: 'AUTH_REQUIRED',
          statusCode: 401,
        })
      );
      return;
    }

    try {
      await checkAndIncrementUsage(user, kind);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const trackScrapeUsage = makeUsageMiddleware('videos');
export const trackAnalysisUsage = makeUsageMiddleware('analyses');
export const trackBriefUsage = makeUsageMiddleware('briefs');

