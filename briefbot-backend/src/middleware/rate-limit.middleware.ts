import type { NextFunction, Request, Response } from 'express';
import Redis from 'ioredis';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { AuthUser } from './auth.middleware.js';

type Plan = 'free' | 'pro' | 'agency';

const PLAN_LIMITS: Record<Plan, number> = {
  free: 10,
  pro: 30,
  agency: 100,
};

const redis = new Redis(env.REDIS_URL);

function resolvePlan(user?: AuthUser): Plan {
  if (!user?.plan) return 'free';
  if (user.plan === 'pro' || user.plan === 'agency') return user.plan;
  return 'free';
}

export async function rateLimitPerUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      // Should be behind auth, but be defensive
      next(
        new AppError('Unauthorized', {
          code: 'AUTH_REQUIRED',
          statusCode: 401,
        })
      );
      return;
    }

    const plan = resolvePlan(req.user);
    const limit = PLAN_LIMITS[plan];

    if (plan === 'agency') {
      next();
      return;
    }

    const now = Date.now();
    const windowSeconds = 60;
    const windowId = Math.floor(now / (windowSeconds * 1000));
    const key = `rate:${userId}:${windowId}`;

    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSeconds);
    }

    if (current > limit) {
      const ttl = await redis.ttl(key);
      const retryAfter = ttl > 0 ? ttl : windowSeconds;

      next(
        new AppError('Rate limit exceeded', {
          code: 'RATE_LIMIT_EXCEEDED',
          statusCode: 429,
          details: {
            plan,
            limitPerMinute: limit,
          },
        })
      );
      // Attach header via a small helper middleware on the error handler side if needed
      // But we can also set it here using res.setHeader when not delegating only via AppError.
      // Since we centralize formatting in globalErrorHandler, we store it in details.
      (_res as Response).setHeader('Retry-After', retryAfter.toString());
      return;
    }

    next();
  } catch (err) {
    next(
      new AppError('Rate limiter error', {
        code: 'RATE_LIMIT_ERROR',
        statusCode: 500,
        cause: err,
      })
    );
  }
}

