import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { logger } from '../config/logger';
import { AppError } from '../utils/errors';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found`, code: 'ROUTE_NOT_FOUND', requestId: req.id });
};

/** Converts every error into the standard envelope. Never leaks stack traces or DB details. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      requestId: req.id,
      success: false,
      message: err.message,
      code: err.code,
      ...(err.errors ? { errors: err.errors } : {}),
    });
  }

  if (err instanceof ZodError) {
    return res.status(422).json({
      requestId: req.id,
      success: false,
      message: 'Validation failed',
      code: 'VALIDATION_ERROR',
      errors: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  if (err instanceof MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : 'Invalid file upload';
    return res.status(400).json({ requestId: req.id, success: false, message, code: 'INVALID_UPLOAD' });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({ requestId: req.id, success: false, message: 'A record with these details already exists', code: 'DUPLICATE' });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ requestId: req.id, success: false, message: 'Resource not found', code: 'NOT_FOUND' });
    }
  }

  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ requestId: req.id, success: false, message: 'Malformed JSON body', code: 'INVALID_JSON' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ requestId: req.id, success: false, message: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' });
  }

  logger.error({ err, requestId: req.id, path: req.path }, 'Unhandled error');
  return res.status(500).json({
    success: false,
    message: 'Something went wrong. Please try again later.',
    code: 'INTERNAL_ERROR',
    requestId: req.id,
  });
};
