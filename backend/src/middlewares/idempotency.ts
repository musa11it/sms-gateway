import type { RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/errors';
import { sha256 } from '../utils/crypto';

/**
 * Makes retries of state-changing requests safe for API credentials.
 *
 * A client sends `Idempotency-Key: <8-100 chars>`. The first request claims (credential, key) with a
 * MySQL unique constraint, so concurrent retries cannot both run. Later requests with the same key:
 *   - same request  → the original response is replayed (`Idempotent-Replay: true`), nothing runs twice;
 *   - other request → 422 IDEMPOTENCY_KEY_REUSED;
 *   - still running → 409 IDEMPOTENCY_IN_PROGRESS (retry shortly).
 * Server errors (5xx) are not remembered, so those requests can be retried. Staff sessions are unaffected.
 */
const KEY_RE = /^[\w-]{8,100}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_STORED_BYTES = 256 * 1024;

export const idempotency: RequestHandler = async (req, res, next) => {
  const key = req.get('idempotency-key');
  const credentialId = req.integration?.id ?? req.apiKey?.id;
  if (!key || !credentialId || !MUTATING.has(req.method)) return next();
  try {
    if (!KEY_RE.test(key)) throw AppError.badRequest('Idempotency-Key must be 8-100 characters [A-Za-z0-9_-]', 'INVALID_IDEMPOTENCY_KEY');
    const path = req.originalUrl.split('?')[0].slice(0, 255);
    const requestHash = sha256(`${req.method}\n${req.originalUrl}\n${JSON.stringify(req.body ?? {})}`);

    let recordId: string;
    try {
      recordId = (await prisma.idempotencyRecord.create({ data: { credentialId, key, method: req.method, path, requestHash } })).id;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      const existing = await prisma.idempotencyRecord.findUnique({ where: { credentialId_key: { credentialId, key } } });
      if (!existing) return next(AppError.conflict('Please retry the request', 'IDEMPOTENCY_RETRY'));
      if (existing.requestHash !== requestHash) throw AppError.unprocessable('This Idempotency-Key was already used with a different request', 'IDEMPOTENCY_KEY_REUSED');
      if (existing.statusCode === null) {
        res.setHeader('Retry-After', '1');
        throw AppError.conflict('A request with this Idempotency-Key is still being processed', 'IDEMPOTENCY_IN_PROGRESS');
      }
      res.setHeader('Idempotent-Replay', 'true');
      return void res.status(existing.statusCode).json(existing.responseBody ?? { success: existing.statusCode < 400, message: 'This request was already processed', code: 'IDEMPOTENT_REPLAY' });
    }

    let body: unknown;
    const json = res.json.bind(res);
    res.json = (payload: unknown) => {
      body = payload;
      return json(payload);
    };
    res.on('finish', () => {
      const save =
        res.statusCode >= 500
          ? prisma.idempotencyRecord.delete({ where: { id: recordId } })
          : prisma.idempotencyRecord.update({
              where: { id: recordId },
              data: { statusCode: res.statusCode, responseBody: body !== undefined && JSON.stringify(body).length <= MAX_STORED_BYTES ? (body as Prisma.InputJsonValue) : Prisma.DbNull },
            });
      save.catch(() => undefined);
    });
    next();
  } catch (err) {
    next(err);
  }
};
