import { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import { isProduction } from '../../config/env';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middlewares/auth';
import { authLimiter, otpLimiter } from '../../middlewares/rateLimit';
import { metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, parse, uuidParam } from '../../utils/http';
import { normalizePhone } from '../../utils/phone';
import { audit } from '../audit-logs/audit.service';
import { loadRolePermissions } from '../permissions/permission.service';
import * as auth from './auth.service';
import { passwordSchema } from './password';
import { REFRESH_COOKIE } from './tokens';

const cookieOptions = (expires: Date): CookieOptions => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/api/v1/auth',
  expires,
});

function setSessionCookie(res: Response, session: auth.IssuedSession) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, cookieOptions(session.refreshExpiresAt));
}

const email = z.string().trim().toLowerCase().email('Enter a valid email').max(200);

export const authRouter = Router();

authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        fullName: z.string().trim().min(2).max(120),
        email,
        phone: z.string().trim().max(30).optional().or(z.literal('').transform(() => undefined)),
        password: passwordSchema,
        organizationName: z.string().trim().min(2).max(160),
      }),
      req.body,
    );
    const result = await auth.register(body, metaFromRequest(req));
    setSessionCookie(res, result.session);
    return created(res, { accessToken: result.session.accessToken }, 'Account created. Check your email to verify your address.');
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(200) }), req.body);
    const { session } = await auth.login(body, metaFromRequest(req));
    setSessionCookie(res, session);
    return ok(res, { accessToken: session.accessToken });
  }),
);

authRouter.post(
  '/refresh',
  authLimiter,
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token || typeof token !== 'string') throw AppError.unauthorized('No session', 'NO_SESSION');
    try {
      const session = await auth.refresh(token, metaFromRequest(req));
      setSessionCookie(res, session);
      return ok(res, { accessToken: session.accessToken });
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
      throw err;
    }
  }),
);

authRouter.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    await auth.logout(req.user!.sessionId);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return ok(res, null, 'Signed out');
  }),
);

authRouter.post(
  '/verify-email',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    await auth.verifyEmail(token, metaFromRequest(req));
    return ok(res, null, 'Email verified');
  }),
);

authRouter.post(
  '/resend-verification',
  authLimiter,
  authenticate,
  asyncHandler(async (req, res) => {
    await auth.resendVerification(req.user!.id);
    return ok(res, null, 'Verification email sent');
  }),
);

authRouter.post(
  '/phone/send-code',
  authenticate,
  otpLimiter,
  asyncHandler(async (req, res) => {
    await auth.sendPhoneVerification(req.user!.id);
    return ok(res, null, 'Verification code sent');
  }),
);

authRouter.post(
  '/phone/verify',
  authLimiter,
  authenticate,
  asyncHandler(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body);
    await auth.verifyPhone(req.user!.id, code, metaFromRequest(req));
    return ok(res, null, 'Phone number verified');
  }),
);

authRouter.post(
  '/forgot-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email }), req.body);
    await auth.forgotPassword(body.email);
    return ok(res, null, 'If an account exists for this email, a reset link has been sent.');
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password: passwordSchema }), req.body);
    await auth.resetPassword(body.token, body.password, metaFromRequest(req));
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return ok(res, null, 'Password updated. Please sign in.');
  }),
);

authRouter.post(
  '/change-password',
  authLimiter,
  authenticate,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }), req.body);
    await auth.changePassword(req.user!.id, req.user!.sessionId, body.currentPassword, body.newPassword, metaFromRequest(req));
    return ok(res, null, 'Password changed. Other sessions were signed out.');
  }),
);

authRouter.get(
  '/sessions',
  authenticate,
  asyncHandler(async (req, res) => {
    const sessions = await prisma.session.findMany({
      where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    });
    return ok(res, sessions.map((s) => ({ ...s, current: s.id === req.user!.sessionId })));
  }),
);

authRouter.delete(
  '/sessions/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const result = await prisma.session.updateMany({
      where: { id, userId: req.user!.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'revoked_by_user' },
    });
    if (result.count === 0) throw AppError.notFound('Session');
    return ok(res, null, 'Session revoked');
  }),
);

// ── /me ─────────────────────────────────────────────────────────────

export const meRouter = Router();

meRouter.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const u = req.user!;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { id: true, email: true, fullName: true, phone: true, phoneVerifiedAt: true, status: true, statusReason: true, emailVerifiedAt: true, createdAt: true },
    });
    const memberships = await prisma.organizationMember.findMany({
      where: { userId: u.id, status: 'ACTIVE' },
      include: { organization: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    const requested = req.get('x-organization-id');
    const current = memberships.find((m) => m.organizationId === requested) ?? memberships[0];
    let organization = null;
    let orgPermissions: string[] = [];
    if (current) {
      const perms = await loadRolePermissions(current.roleId);
      orgPermissions = [...perms.permissions].sort();
      const verification = await prisma.verification.findFirst({
        where: { organizationId: current.organizationId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, reviewNote: true, submittedAt: true, reviewedAt: true },
      });
      organization = { ...current.organization, verification, role: { id: current.role.id, code: current.role.code, name: current.role.name }, isOwner: current.isOwner };
    }
    return ok(res, {
      user,
      platform: { roles: u.platformRoles, permissions: [...u.platformPermissions].sort() },
      isStaff: u.platformPermissions.size > 0,
      memberships: memberships.map((m) => ({
        organizationId: m.organizationId,
        organizationName: m.organization.name,
        organizationStatus: m.organization.status,
        role: { id: m.role.id, code: m.role.code, name: m.role.name },
        isOwner: m.isOwner,
      })),
      organization,
      orgPermissions,
    });
  }),
);

meRouter.patch(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ fullName: z.string().trim().min(2).max(120).optional(), phone: z.string().trim().max(30).nullable().optional() }),
      req.body,
    );
    let phone: string | null | undefined = undefined;
    if (body.phone !== undefined) {
      phone = body.phone ? normalizePhone(body.phone) : null;
      if (body.phone && !phone) throw AppError.unprocessable('Invalid phone number', 'INVALID_PHONE', [{ field: 'phone', message: 'Invalid phone number' }]);
    }
    const current = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      // Changing the number requires verifying the new one.
      data: { fullName: body.fullName, phone, ...(phone !== undefined && phone !== current.phone ? { phoneVerifiedAt: null } : {}) },
      select: { id: true, email: true, fullName: true, phone: true },
    });
    await audit({ actor: { type: 'USER', userId: user.id, email: user.email }, action: 'USER_PROFILE_UPDATED', resource: 'user', resourceId: user.id, meta: metaFromRequest(req) });
    return ok(res, user, 'Profile updated');
  }),
);
