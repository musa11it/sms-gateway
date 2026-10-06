import type { RequestHandler } from 'express';
import { prisma } from '../config/prisma';
import { verifyAccessToken } from '../modules/auth/tokens';
import { loadPlatformAccess } from '../modules/permissions/permission.service';
import { AppError } from '../utils/errors';

const BLOCKED_STATUSES = new Set(['SUSPENDED', 'DEACTIVATED']);

/**
 * Authenticates a dashboard user from the `Authorization: Bearer <access token>` header.
 * The session is checked on every request so logout, password change and suspension take
 * effect immediately rather than waiting for token expiry.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.get('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw AppError.unauthorized();

    const payload = verifyAccessToken(token);
    if (!payload) throw AppError.unauthorized('Session expired, please sign in again', 'TOKEN_INVALID');

    const session = await prisma.session.findUnique({ where: { id: payload.sid }, include: { user: true } });
    if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt < new Date()) {
      throw AppError.unauthorized('Session expired, please sign in again', 'SESSION_REVOKED');
    }
    const user = session.user;
    // Service accounts act through API credentials only; a session for one is never valid.
    if (user.isServiceAccount) throw AppError.unauthorized('Session expired, please sign in again', 'SESSION_REVOKED');
    if (BLOCKED_STATUSES.has(user.status)) {
      throw AppError.forbidden(
        user.status === 'SUSPENDED' ? 'Your account has been suspended. Contact support.' : 'Your account is deactivated.',
        'ACCOUNT_' + user.status,
      );
    }

    const access = await loadPlatformAccess(user.id);
    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      status: user.status,
      sessionId: session.id,
      platformPermissions: access.permissions,
      platformRoles: access.roles,
    };
    next();
  } catch (err) {
    next(err);
  }
};

/** Blocks users who have not verified their email yet. */
export const requireVerifiedEmail: RequestHandler = (req, _res, next) => {
  if (req.user?.status === 'PENDING_EMAIL_VERIFICATION') {
    return next(AppError.forbidden('Please verify your email address first', 'EMAIL_NOT_VERIFIED'));
  }
  next();
};
