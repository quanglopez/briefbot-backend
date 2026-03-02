import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { AppError, toAppError } from '../utils/errors.js';

// 404 handler – forward as AppError so global handler formats consistently
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError('Resource not found', {
      code: 'NOT_FOUND',
      statusCode: 404,
      details: { path: req.path, method: req.method },
    })
  );
}

// Global error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function globalErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const appError = toAppError(err);
  const status = appError.statusCode ?? 500;

  logger.error(
    {
      err: appError,
      code: appError.code,
      status,
      details: appError.details,
    },
    'Request error'
  );

  res.status(status).json({
    success: false,
    error: {
      code: appError.code,
      message: status === 500 && appError.code === 'INTERNAL_ERROR' ? 'Internal Server Error' : appError.message,
      details: appError.details,
    },
  });
}

