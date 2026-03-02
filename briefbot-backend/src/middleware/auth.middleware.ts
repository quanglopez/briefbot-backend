import type { NextFunction, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export interface AuthUser {
  id: string;
  email?: string;
  plan?: 'free' | 'pro' | 'agency';
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    next(
      new AppError('Missing or invalid Authorization header', {
        code: 'AUTH_MISSING',
        statusCode: 401,
      })
    );
    return;
  }

  if (!env.SUPABASE_ANON_KEY) {
    next(
      new AppError('Auth not configured (SUPABASE_ANON_KEY)', {
        code: 'AUTH_MISCONFIGURED',
        statusCode: 503,
      })
    );
    return;
  }

  const token = authHeader.slice(7);

  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      next(
        new AppError('Invalid or expired token', {
          code: 'AUTH_INVALID',
          statusCode: 401,
          details: error ?? undefined,
        })
      );
      return;
    }

    // Plan can be attached later by usage/rate-limit middleware if needed
    req.user = { id: user.id, email: user.email ?? undefined };
    next();
  } catch (err) {
    next(
      new AppError('Failed to verify token', {
        code: 'AUTH_ERROR',
        statusCode: 500,
        cause: err,
      })
    );
  }
}

