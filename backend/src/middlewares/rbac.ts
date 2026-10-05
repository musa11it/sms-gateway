import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors';

/**
 * Platform (staff) authorization. Requires ALL listed permissions.
 * Used on /api/v1/admin routes.
 */
export function requirePlatformPermission(...keys: string[]): RequestHandler {
  return (req, _res, next) => {
    const perms = req.user?.platformPermissions;
    if (!perms) return next(AppError.unauthorized());
    const missing = keys.filter((k) => !perms.has(k));
    if (missing.length) return next(AppError.forbidden(undefined, 'PERMISSION_DENIED'));
    next();
  };
}

/** Requires the user to hold at least one platform permission (i.e. be staff). */
export const requireStaff: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(AppError.unauthorized());
  if (req.user.platformPermissions.size === 0) return next(AppError.forbidden('Staff access required', 'NOT_STAFF'));
  if (req.user.status !== 'ACTIVE') return next(AppError.forbidden('Your account is not active', 'ACCOUNT_INACTIVE'));
  next();
};

/**
 * Organization (tenant) authorization. Requires ALL listed permissions in the
 * organization resolved by `orgContext`.
 */
export function requireOrgPermission(...keys: string[]): RequestHandler {
  return (req, _res, next) => {
    const perms = req.org?.permissions;
    if (!perms) return next(AppError.forbidden('No organization selected', 'NO_ORGANIZATION'));
    const missing = keys.filter((k) => !perms.has(k));
    if (missing.length) return next(AppError.forbidden(undefined, 'PERMISSION_DENIED'));
    next();
  };
}
