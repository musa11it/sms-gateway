import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

export function ok<T>(res: Response, data: T, message?: string, status = 200) {
  return res.status(status).json({ success: true, data, ...(message ? { message } : {}) });
}

export function created<T>(res: Response, data: T, message?: string) {
  return ok(res, data, message, 201);
}

export function paginated<T>(res: Response, data: T[], page: number, limit: number, total: number) {
  return res.json({
    success: true,
    data,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  });
}

/** Wraps async route handlers so rejected promises reach the error middleware. */
export const asyncHandler =
  <R extends Request = Request>(fn: (req: R, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req as R, res, next).catch(next);
  };

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function toSkipTake(p: { page: number; limit: number }) {
  return { skip: (p.page - 1) * p.limit, take: p.limit };
}

/** Parse request parts with zod; throws ZodError handled by the error middleware. */
export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  return schema.parse(input);
}

export const uuidParam = z.object({ id: z.string().uuid() });
