import type { NextFunction, Request, Response } from 'express';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function catchAsync(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fn(req, res, next).catch(next);
  };
}

