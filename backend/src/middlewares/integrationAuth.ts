import type { Request, RequestHandler, Response } from 'express';
import { logger } from '../config/logger';
import { prisma } from '../config/prisma';
import { authenticateIntegration, serviceUserFor, type IntegrationScope } from '../modules/integrations/integration.service';
import { PLATFORM_SCOPES } from '../modules/integrations/scopes';
import { authenticate } from './auth';
import { credentialIpLimiter } from './rateLimit';
import { AppError } from '../utils/errors';

/** One row per authenticated request: which credential, endpoint, IP, request id and result. Never bodies or secrets. */
function logRequest(req: Request, res: Response, credentialId: string) {
  const started = Date.now();
  let errorCode: string | null = null;
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (body && typeof body === 'object' && 'code' in body) errorCode = String((body as { code: unknown }).code).slice(0, 100);
    return json(body);
  };
  res.on('finish', () => {
    prisma.integrationRequestLog
      .create({ data: { credentialId, method: req.method, path: req.originalUrl.split('?')[0].slice(0, 255), statusCode: res.statusCode, durationMs: Date.now() - started, ipAddress: req.ip, errorCode, requestId: String(req.id) } })
      .catch((err) => logger.error({ err }, 'Failed to write integration request log'));
  });
}

/** Authenticates an external system from `Authorization: Bearer sgw_int_…`. */
export const authenticateIntegrationKey: RequestHandler = async (req, res, next) => {
  try {
    const header = req.get('authorization');
    req.integration = await authenticateIntegration(header?.startsWith('Bearer ') ? header.slice(7) : undefined, req.ip);
    logRequest(req, res, req.integration.id);
    next();
  } catch (err) {
    next(err);
  }
};

export const requireIntegrationScope =
  (scope: IntegrationScope): RequestHandler =>
  (req, _res, next) =>
    req.integration?.scopes.includes(scope) ? next() : next(AppError.forbidden(`This credential lacks the "${scope}" scope`, 'SCOPE_DENIED'));

/**
 * Authentication for the platform admin API. Accepts a staff session (`Authorization: Bearer <jwt>`)
 * or a platform integration credential (`Authorization: Bearer sgw_int_…`). An integration acts as
 * its own service account whose permissions are exactly the credential's scopes (never more), so the
 * same per-route permission checks that protect staff access apply to it.
 */
export const authenticateStaff: RequestHandler = async (req, res, next) => {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token?.startsWith('sgw_int_')) return authenticate(req, res, next);
  // Per-IP limit first: it throttles key guessing before any credential lookup happens.
  const limited = await new Promise<unknown>((resolve) => credentialIpLimiter(req, res, resolve));
  if (limited) return next(limited);
  try {
    const client = await authenticateIntegration(token, req.ip);
    req.integration = client;
    logRequest(req, res, client.id);
    const user = await serviceUserFor(client);
    if (user.status !== 'ACTIVE') throw AppError.forbidden('This credential is not active', 'INTEGRATION_DISABLED');
    const grantable = new Set<string>(PLATFORM_SCOPES);
    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      status: user.status,
      sessionId: `integration:${client.id}`,
      platformPermissions: new Set(client.scopes.filter((s) => grantable.has(s))),
      platformRoles: ['INTEGRATION'],
    };
    next();
  } catch (err) {
    next(err);
  }
};

/** Credentials can never manage credentials: only a signed-in human Super Admin can. */
export const humanOnly: RequestHandler = (req, _res, next) =>
  req.integration ? next(AppError.forbidden('Credentials cannot manage integrations', 'HUMAN_ONLY')) : next();
