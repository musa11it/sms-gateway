import type { RequestHandler } from 'express';
import { authenticateIntegration, serviceUserFor, type IntegrationScope } from '../modules/integrations/integration.service';
import { PLATFORM_SCOPES } from '../modules/integrations/scopes';
import { authenticate } from './auth';
import { AppError } from '../utils/errors';

/** Authenticates an external system from `Authorization: Bearer sgw_int_…`. */
export const authenticateIntegrationKey: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.get('authorization');
    req.integration = await authenticateIntegration(header?.startsWith('Bearer ') ? header.slice(7) : undefined, req.ip);
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
  try {
    const client = await authenticateIntegration(token, req.ip);
    req.integration = client;
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
