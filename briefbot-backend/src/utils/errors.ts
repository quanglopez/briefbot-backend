export interface AppErrorOptions {
  code?: string;
  statusCode?: number;
  details?: unknown;
  cause?: unknown;
}

export class AppError extends Error {
  public readonly statusCode: number;

  public readonly code: string;

  public readonly details?: unknown;

  public readonly isOperational: boolean;

  constructor(message: string, options: AppErrorOptions = {}) {
    const { code, statusCode, details, cause } = options;
    super(message);
    if (cause) {
      // Node 18+ supports Error.cause but keep assignment explicit
      (this as any).cause = cause;
    }
    this.name = 'AppError';
    this.statusCode = statusCode ?? 500;
    this.code = code ?? 'INTERNAL_ERROR';
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) {
    return err;
  }
  if (err instanceof Error) {
    return new AppError(err.message, {
      cause: err,
    });
  }
  return new AppError('Unknown error', {
    details: { error: err },
  });
}

