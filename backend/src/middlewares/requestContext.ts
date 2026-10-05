import crypto from 'crypto';
import type { RequestHandler } from 'express';
import pinoHttp from 'pino-http';
import { logger } from '../config/logger';

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

/** Structured access log: requestId, userId, organizationId, route, status, duration. */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as unknown as { id: string }).id,
  autoLogging: { ignore: (req) => req.url === '/health' },
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  customProps: (req) => {
    const r = req as unknown as Express.Request;
    return { userId: r.user?.id, organizationId: r.org?.id, apiKeyId: r.apiKey?.id };
  },
});
