import crypto from 'crypto';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { sendEmail } from '../../integrations/email/mailer';
import type { RequestMeta } from '../../types/actor';
import { hmacSha256, randomToken, safeEqual, sha256 } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { normalizePhone } from '../../utils/phone';
import { audit } from '../audit-logs/audit.service';
import { createOrganizationWithOwner } from '../organizations/organization.helpers';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password';
import { signAccessToken } from './tokens';

const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function hashRefresh(token: string) {
  return hmacSha256(env.JWT_REFRESH_SECRET, token);
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export async function createSession(userId: string, meta: RequestMeta): Promise<IssuedSession> {
  const sessionId = crypto.randomUUID();
  const refreshToken = `${sessionId}.${randomToken(32)}`;
  const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await prisma.session.create({
    data: {
      id: sessionId,
      userId,
      refreshTokenHash: hashRefresh(refreshToken),
      userAgent: meta.userAgent?.slice(0, 300),
      ipAddress: meta.ip,
      expiresAt: refreshExpiresAt,
    },
  });
  return { accessToken: signAccessToken(userId, sessionId), refreshToken, refreshExpiresAt };
}

async function issueUserToken(userId: string, type: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET', ttlMs: number) {
  const token = randomToken(32);
  // Invalidate previous unused tokens of the same type.
  await prisma.userToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.userToken.create({ data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}

async function sendVerificationEmail(user: { id: string; email: string; fullName: string }) {
  const token = await issueUserToken(user.id, 'EMAIL_VERIFICATION', EMAIL_TOKEN_TTL_MS);
  const link = `${env.FRONTEND_URL}/verify-email?token=${token}`;
  await sendEmail({
    to: user.email,
    subject: 'Verify your email address',
    template: 'email-verification',
    text: `Hi ${user.fullName},\n\nWelcome to SMS Gateway! Confirm your email address to continue:\n${link}\n\nThis link expires in 24 hours.`,
  });
}

export async function register(
  input: { fullName: string; email: string; phone?: string; password: string; organizationName: string },
  meta: RequestMeta,
) {
  const email = input.email.toLowerCase().trim();
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (input.phone && !phone) throw AppError.unprocessable('Invalid phone number', 'INVALID_PHONE', [{ field: 'phone', message: 'Invalid phone number' }]);

  const existing = await prisma.user.findFirst({ where: { OR: [{ email }, ...(phone ? [{ phone }] : [])] } });
  if (existing) {
    const field = existing.email === email ? 'email' : 'phone';
    throw AppError.conflict(`An account with this ${field} already exists`, field === 'email' ? 'EMAIL_TAKEN' : 'PHONE_TAKEN');
  }

  const passwordHash = await hashPassword(input.password);
  const { user, org } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, phone, fullName: input.fullName.trim(), passwordHash, status: 'PENDING_EMAIL_VERIFICATION' },
    });
    const org = await createOrganizationWithOwner(tx, { name: input.organizationName.trim(), ownerId: user.id });
    await audit({ actor: { type: 'USER', userId: user.id, email }, action: 'USER_CREATED', resource: 'user', resourceId: user.id, organizationId: org.id, meta }, tx);
    await audit({ actor: { type: 'USER', userId: user.id, email }, action: 'ORGANIZATION_CREATED', resource: 'organization', resourceId: org.id, organizationId: org.id, meta }, tx);
    return { user, org };
  });

  await sendVerificationEmail(user);
  const session = await createSession(user.id, meta);
  return { user, organization: org, session };
}

export async function verifyEmail(token: string, meta: RequestMeta) {
  const record = await prisma.userToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!record || record.type !== 'EMAIL_VERIFICATION' || record.usedAt || record.expiresAt < new Date()) {
    throw AppError.badRequest('This verification link is invalid or has expired', 'TOKEN_INVALID');
  }
  await prisma.$transaction(async (tx) => {
    await tx.userToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await tx.user.update({
      where: { id: record.userId },
      data: {
        emailVerifiedAt: new Date(),
        status: record.user.status === 'PENDING_EMAIL_VERIFICATION' ? 'PENDING_REVIEW' : record.user.status,
      },
    });
    await audit({ actor: { type: 'USER', userId: record.userId, email: record.user.email }, action: 'USER_EMAIL_VERIFIED', resource: 'user', resourceId: record.userId, meta }, tx);
  });
}

export async function resendVerification(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) throw AppError.badRequest('Email is already verified', 'ALREADY_VERIFIED');
  await sendVerificationEmail(user);
}

/**
 * Phone verification: a 6-digit code valid for 10 minutes. Only a hash bound to the user is
 * stored. Codes are delivered through the system outbox (in development: the dev mailbox;
 * in production: a transactional SMS channel).
 */
export async function sendPhoneVerification(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.phone) throw AppError.unprocessable('Add a phone number to your profile first', 'PHONE_REQUIRED');
  if (user.phoneVerifiedAt) throw AppError.badRequest('Phone number is already verified', 'ALREADY_VERIFIED');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.userToken.updateMany({ where: { userId, type: 'PHONE_VERIFICATION', usedAt: null }, data: { usedAt: new Date() } });
  await prisma.userToken.create({ data: { userId, type: 'PHONE_VERIFICATION', tokenHash: sha256(`${userId}:${user.phone}:${code}`), expiresAt: new Date(Date.now() + 10 * 60_000) } });
  await sendEmail({ to: user.phone, subject: 'Phone verification code', template: 'phone-otp', text: `Your SMS Gateway verification code is ${code}. It expires in 10 minutes.` });
}

export async function verifyPhone(userId: string, code: string, meta: RequestMeta) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.phone) throw AppError.unprocessable('No phone number on your profile', 'PHONE_REQUIRED');
  const record = await prisma.userToken.findUnique({ where: { tokenHash: sha256(`${userId}:${user.phone}:${code}`) } });
  if (!record || record.userId !== userId || record.type !== 'PHONE_VERIFICATION' || record.usedAt || record.expiresAt < new Date()) {
    throw AppError.badRequest('The code is invalid or has expired', 'CODE_INVALID');
  }
  await prisma.$transaction(async (tx) => {
    await tx.userToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await tx.user.update({ where: { id: userId }, data: { phoneVerifiedAt: new Date() } });
    await audit({ actor: { type: 'USER', userId, email: user.email }, action: 'USER_PHONE_VERIFIED', resource: 'user', resourceId: userId, meta }, tx);
  });
}

export async function login(input: { email: string; password: string }, meta: RequestMeta) {
  const email = input.email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });
  const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) {
    if (user) await audit({ actor: { type: 'USER', userId: user.id, email }, action: 'LOGIN_FAILED', resource: 'user', resourceId: user.id, meta });
    throw AppError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (user.status === 'SUSPENDED') throw AppError.forbidden('Your account has been suspended. Contact support.', 'ACCOUNT_SUSPENDED');
  if (user.status === 'DEACTIVATED') throw AppError.forbidden('This account has been deactivated.', 'ACCOUNT_DEACTIVATED');

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ actor: { type: 'USER', userId: user.id, email }, action: 'LOGIN', resource: 'user', resourceId: user.id, meta });
  const session = await createSession(user.id, meta);
  return { user, session };
}

/**
 * Rotating refresh tokens with reuse detection: every refresh replaces the token.
 * Presenting an old token for a live session means it was stolen → the session is revoked.
 */
export async function refresh(refreshToken: string, meta: RequestMeta): Promise<IssuedSession> {
  const [sessionId] = refreshToken.split('.');
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) throw AppError.unauthorized('Invalid session', 'SESSION_INVALID');
  const session = await prisma.session.findUnique({ where: { id: sessionId }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw AppError.unauthorized('Session expired, please sign in again', 'SESSION_INVALID');
  }
  if (!safeEqual(session.refreshTokenHash, hashRefresh(refreshToken))) {
    await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokedReason: 'refresh_token_reuse' } });
    await audit({ actor: { type: 'USER', userId: session.userId }, action: 'SESSION_REUSE_DETECTED', resource: 'session', resourceId: session.id, meta });
    throw AppError.unauthorized('Session expired, please sign in again', 'SESSION_INVALID');
  }
  if (['SUSPENDED', 'DEACTIVATED'].includes(session.user.status)) {
    throw AppError.forbidden('Your account is not active', `ACCOUNT_${session.user.status}`);
  }
  const next = `${session.id}.${randomToken(32)}`;
  const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await prisma.session.update({
    where: { id: session.id },
    data: { refreshTokenHash: hashRefresh(next), lastUsedAt: new Date(), expiresAt: refreshExpiresAt, ipAddress: meta.ip },
  });
  return { accessToken: signAccessToken(session.userId, session.id), refreshToken: next, refreshExpiresAt };
}

export async function logout(sessionId: string) {
  await prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'logout' } });
}

export async function forgotPassword(emailInput: string) {
  const user = await prisma.user.findUnique({ where: { email: emailInput.toLowerCase().trim() } });
  // Always succeed to avoid account enumeration.
  if (!user || user.status === 'DEACTIVATED') return;
  const token = await issueUserToken(user.id, 'PASSWORD_RESET', RESET_TOKEN_TTL_MS);
  await sendEmail({
    to: user.email,
    subject: 'Reset your password',
    template: 'password-reset',
    text: `Hi ${user.fullName},\n\nUse this link to reset your password (valid for 1 hour):\n${env.FRONTEND_URL}/reset-password?token=${token}\n\nIf you did not request this, ignore this email.`,
  });
}

export async function resetPassword(token: string, password: string, meta: RequestMeta) {
  const record = await prisma.userToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!record || record.type !== 'PASSWORD_RESET' || record.usedAt || record.expiresAt < new Date()) {
    throw AppError.badRequest('This reset link is invalid or has expired', 'TOKEN_INVALID');
  }
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    await tx.userToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash, passwordChangedAt: new Date() } });
    await tx.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'password_reset' } });
    await audit({ actor: { type: 'USER', userId: record.userId, email: record.user.email }, action: 'PASSWORD_RESET', resource: 'user', resourceId: record.userId, meta }, tx);
  });
}

export async function changePassword(userId: string, sessionId: string, current: string, next: string, meta: RequestMeta) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(current, user.passwordHash))) {
    throw AppError.unprocessable('Current password is incorrect', 'INVALID_PASSWORD', [{ field: 'currentPassword', message: 'Incorrect password' }]);
  }
  const passwordHash = await hashPassword(next);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt: new Date() } });
    await tx.session.updateMany({
      where: { userId, revokedAt: null, id: { not: sessionId } },
      data: { revokedAt: new Date(), revokedReason: 'password_changed' },
    });
    await audit({ actor: { type: 'USER', userId, email: user.email }, action: 'PASSWORD_CHANGED', resource: 'user', resourceId: userId, meta }, tx);
  });
}
