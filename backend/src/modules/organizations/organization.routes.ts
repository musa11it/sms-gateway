import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middlewares/auth';
import { authLimiter } from '../../middlewares/rateLimit';
import { requireOrgPermission } from '../../middlewares/rbac';
import { sendEmail } from '../../integrations/email/mailer';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { randomToken, sha256 } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, parse, uuidParam } from '../../utils/http';
import { normalizePhone } from '../../utils/phone';
import { audit } from '../audit-logs/audit.service';
import { hashPassword, passwordSchema } from '../auth/password';
import { createSession } from '../auth/auth.service';
import { REFRESH_COOKIE } from '../auth/tokens';
import { notifyOrganization } from '../notifications/notification.service';
import { loadRolePermissions } from '../permissions/permission.service';
import * as roles from '../roles/role.service';
import { isProduction } from '../../config/env';

export const organizationRouter = Router();

const profileSchema = z.object({
  name: z.string().trim().min(2).max(160),
  businessType: z.string().trim().max(80).nullable(),
  country: z.string().trim().max(80).nullable(),
  address: z.string().trim().max(300).nullable(),
  city: z.string().trim().max(80).nullable(),
  registrationNumber: z.string().trim().max(80).nullable(),
  taxId: z.string().trim().max(80).nullable(),
  website: z.string().trim().url().max(200).nullable().or(z.literal('').transform(() => null)),
  contactPersonName: z.string().trim().max(120).nullable(),
  contactPersonPhone: z.string().trim().max(30).nullable(),
  contactPersonEmail: z.string().trim().email().max(200).nullable().or(z.literal('').transform(() => null)),
  smsPurpose: z.string().trim().max(1000).nullable(),
  expectedMonthlyVolume: z.coerce.number().int().min(0).max(100_000_000).nullable(),
  timezone: z.string().trim().max(64),
});

// Fields reviewed during verification are frozen once submitted/approved.
const KYB_FIELDS = ['name', 'businessType', 'country', 'registrationNumber', 'taxId'] as const;

organizationRouter.get(
  '/',
  requireOrgPermission('organizations.view'),
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.org!.id } });
    return ok(res, org);
  }),
);

organizationRouter.patch(
  '/',
  requireOrgPermission('organizations.update'),
  asyncHandler(async (req, res) => {
    const body = parse(profileSchema.partial(), req.body);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.org!.id } });
    const locked = ['PENDING_REVIEW', 'ACTIVE', 'SUSPENDED'].includes(org.status);
    if (locked) {
      const changed = KYB_FIELDS.filter((f) => body[f] !== undefined && body[f] !== org[f]);
      if (changed.length) {
        throw AppError.conflict(`These verified fields cannot be changed now: ${changed.join(', ')}. Contact support.`, 'PROFILE_LOCKED');
      }
    }
    if (body.contactPersonPhone) {
      const p = normalizePhone(body.contactPersonPhone);
      if (!p) throw AppError.unprocessable('Invalid contact phone', 'INVALID_PHONE', [{ field: 'contactPersonPhone', message: 'Invalid phone number' }]);
      body.contactPersonPhone = p;
    }
    const updated = await prisma.organization.update({ where: { id: org.id }, data: body });
    await audit({ actor: actorFromRequest(req), action: 'ORGANIZATION_UPDATED', resource: 'organization', resourceId: org.id, organizationId: org.id, metadata: { fields: Object.keys(body) }, meta: metaFromRequest(req) });
    return ok(res, updated, 'Organization profile saved');
  }),
);

// ── Team ────────────────────────────────────────────────────────────────

organizationRouter.get(
  '/members',
  requireOrgPermission('team.view'),
  asyncHandler(async (req, res) => {
    const members = await prisma.organizationMember.findMany({
      where: { organizationId: req.org!.id },
      include: { user: { select: { id: true, fullName: true, email: true, status: true, lastLoginAt: true } }, role: { select: { id: true, name: true, code: true } } },
      orderBy: [{ isOwner: 'desc' }, { createdAt: 'asc' }],
    });
    return ok(res, members);
  }),
);

/** A member may only hand out roles whose permissions they hold themselves. */
async function assertAssignableRole(req: Express.Request, roleId: string) {
  const role = await prisma.role.findFirst({ where: { id: roleId, scope: 'ORGANIZATION', OR: [{ organizationId: null }, { organizationId: req.org!.id }] } });
  if (!role) throw AppError.unprocessable('Role not found', 'ROLE_NOT_FOUND', [{ field: 'roleId', message: 'Unknown role' }]);
  if (role.code === 'CUSTOMER_OWNER' && role.isSystem) throw AppError.forbidden('The owner role cannot be assigned', 'OWNER_ROLE');
  if (!req.org!.isOwner) {
    const perms = await loadRolePermissions(role.id);
    const missing = [...perms.permissions].filter((p) => !req.org!.permissions.has(p));
    if (missing.length) throw AppError.forbidden('You cannot assign a role with more access than your own', 'PRIVILEGE_ESCALATION');
  }
  return role;
}

organizationRouter.patch(
  '/members/:id',
  requireOrgPermission('team.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ roleId: z.string().uuid().optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional() }), req.body);
    const member = await prisma.organizationMember.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!member) throw AppError.notFound('Member');
    if (member.isOwner) throw AppError.forbidden('The organization owner cannot be changed', 'OWNER_PROTECTED');
    if (member.id === req.org!.memberId) throw AppError.forbidden('You cannot change your own access', 'SELF_MODIFICATION');
    if (body.roleId) await assertAssignableRole(req, body.roleId);
    const updated = await prisma.organizationMember.update({ where: { id }, data: body });
    await audit({ actor: actorFromRequest(req), action: 'MEMBER_UPDATED', resource: 'organization_member', resourceId: id, organizationId: req.org!.id, metadata: body, meta: metaFromRequest(req) });
    return ok(res, updated, 'Member updated');
  }),
);

organizationRouter.delete(
  '/members/:id',
  requireOrgPermission('team.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const member = await prisma.organizationMember.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!member) throw AppError.notFound('Member');
    if (member.isOwner) throw AppError.forbidden('The organization owner cannot be removed', 'OWNER_PROTECTED');
    if (member.id === req.org!.memberId) throw AppError.forbidden('You cannot remove yourself', 'SELF_MODIFICATION');
    await prisma.organizationMember.delete({ where: { id } });
    await audit({ actor: actorFromRequest(req), action: 'MEMBER_REMOVED', resource: 'organization_member', resourceId: id, organizationId: req.org!.id, metadata: { userId: member.userId }, meta: metaFromRequest(req) });
    return ok(res, null, 'Member removed');
  }),
);

organizationRouter.get(
  '/invitations',
  requireOrgPermission('team.view'),
  asyncHandler(async (req, res) => {
    await prisma.organizationInvitation.updateMany({ where: { organizationId: req.org!.id, status: 'PENDING', expiresAt: { lt: new Date() } }, data: { status: 'EXPIRED' } });
    const items = await prisma.organizationInvitation.findMany({
      where: { organizationId: req.org!.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, status: true, expiresAt: true, createdAt: true, acceptedAt: true, role: { select: { id: true, name: true } }, invitedBy: { select: { fullName: true } } },
    });
    return ok(res, items);
  }),
);

organizationRouter.post(
  '/invitations',
  requireOrgPermission('team.invite'),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), roleId: z.string().uuid() }), req.body);
    const role = await assertAssignableRole(req, body.roleId);
    const alreadyMember = await prisma.organizationMember.findFirst({ where: { organizationId: req.org!.id, user: { email: body.email } } });
    if (alreadyMember) throw AppError.conflict('This person is already a member', 'ALREADY_MEMBER');
    await prisma.organizationInvitation.updateMany({ where: { organizationId: req.org!.id, email: body.email, status: 'PENDING' }, data: { status: 'REVOKED' } });
    const token = randomToken(32);
    const inv = await prisma.organizationInvitation.create({
      data: { organizationId: req.org!.id, email: body.email, roleId: role.id, tokenHash: sha256(token), invitedById: req.user!.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) },
    });
    await sendEmail({
      to: body.email,
      subject: `You're invited to join ${req.org!.name} on SMS Gateway`,
      template: 'invitation',
      text: `${req.user!.fullName} invited you to join ${req.org!.name} as ${role.name}.\n\nAccept the invitation (valid for 7 days):\n${env.FRONTEND_URL}/invitations/accept?token=${token}`,
    });
    await audit({ actor: actorFromRequest(req), action: 'MEMBER_INVITED', resource: 'organization_invitation', resourceId: inv.id, organizationId: req.org!.id, metadata: { email: body.email, role: role.name }, meta: metaFromRequest(req) });
    return created(res, { id: inv.id, email: inv.email, status: inv.status, expiresAt: inv.expiresAt }, `Invitation sent to ${body.email}`);
  }),
);

organizationRouter.delete(
  '/invitations/:id',
  requireOrgPermission('team.invite'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const result = await prisma.organizationInvitation.updateMany({ where: { id, organizationId: req.org!.id, status: 'PENDING' }, data: { status: 'REVOKED' } });
    if (result.count === 0) throw AppError.notFound('Pending invitation');
    await audit({ actor: actorFromRequest(req), action: 'INVITATION_REVOKED', resource: 'organization_invitation', resourceId: id, organizationId: req.org!.id, meta: metaFromRequest(req) });
    return ok(res, null, 'Invitation revoked');
  }),
);

// ── Organization roles ──────────────────────────────────────────────────

const roleBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional().nullable(),
  permissions: z.array(z.string().max(60)).max(200),
});

const orgRoleCtx = (req: Express.Request) => ({
  scope: 'ORGANIZATION' as const,
  organizationId: req.org!.id,
  actorPermissions: req.org!.permissions,
  actor: actorFromRequest(req as never),
  meta: metaFromRequest(req as never),
});

organizationRouter.get('/roles', requireOrgPermission('roles.view'), asyncHandler(async (req, res) => ok(res, await roles.listRoles('ORGANIZATION', req.org!.id))));
organizationRouter.get('/permissions', requireOrgPermission('roles.view'), asyncHandler(async (_req, res) => ok(res, await roles.listPermissionCatalog('ORGANIZATION'))));
organizationRouter.post(
  '/roles',
  requireOrgPermission('roles.create'),
  asyncHandler(async (req, res) => created(res, await roles.createRole(orgRoleCtx(req), parse(roleBody, req.body)), 'Role created')),
);
organizationRouter.patch(
  '/roles/:id',
  requireOrgPermission('roles.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    return ok(res, await roles.updateRole(orgRoleCtx(req), id, parse(roleBody.partial(), req.body)), 'Role updated');
  }),
);
organizationRouter.delete(
  '/roles/:id',
  requireOrgPermission('roles.delete'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await roles.deleteRole(orgRoleCtx(req), id);
    return ok(res, null, 'Role deleted');
  }),
);

// ── Invitation acceptance (public / authenticated) ──────────────────────

export const invitationRouter = Router();

async function findValidInvitation(token: string) {
  const inv = await prisma.organizationInvitation.findUnique({ where: { tokenHash: sha256(token) }, include: { organization: true, role: true } });
  if (!inv || inv.status !== 'PENDING' || inv.expiresAt < new Date()) throw AppError.badRequest('This invitation is invalid or has expired', 'INVITATION_INVALID');
  return inv;
}

invitationRouter.get(
  '/:token',
  authLimiter,
  asyncHandler(async (req, res) => {
    const inv = await findValidInvitation(String(req.params.token));
    const userExists = !!(await prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } }));
    return ok(res, { email: inv.email, organizationName: inv.organization.name, roleName: inv.role.name, expiresAt: inv.expiresAt, userExists });
  }),
);

/** New users: provide fullName + password. Existing users: must be signed in as the invited email. */
invitationRouter.post(
  '/accept',
  authLimiter,
  asyncHandler(async (req, res, next) => {
    const body = parse(z.object({ token: z.string().min(10), fullName: z.string().trim().min(2).max(120).optional(), password: passwordSchema.optional() }), req.body);
    const inv = await findValidInvitation(body.token);
    const existing = await prisma.user.findUnique({ where: { email: inv.email } });

    if (existing) {
      // Require an authenticated session for the invited account.
      return authenticate(req, res, async (err?: unknown) => {
        try {
          if (err) throw err;
          if (req.user!.id !== existing.id) throw AppError.forbidden('Sign in as the invited email address to accept', 'WRONG_ACCOUNT');
          await prisma.$transaction(async (tx) => {
            await tx.organizationMember.upsert({
              where: { organizationId_userId: { organizationId: inv.organizationId, userId: existing.id } },
              create: { organizationId: inv.organizationId, userId: existing.id, roleId: inv.roleId },
              update: { roleId: inv.roleId, status: 'ACTIVE' },
            });
            await tx.organizationInvitation.update({ where: { id: inv.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
            await audit({ actor: actorFromRequest(req), action: 'INVITATION_ACCEPTED', resource: 'organization_invitation', resourceId: inv.id, organizationId: inv.organizationId, meta: metaFromRequest(req) }, tx);
          });
          await notifyOrganization(inv.organizationId, { type: 'TEAM_JOINED', title: 'New team member', body: `${existing.fullName} joined as ${inv.role.name}`, link: '/app/settings/team' }, 'team.view');
          return ok(res, { organizationId: inv.organizationId }, `You joined ${inv.organization.name}`);
        } catch (e) {
          return next(e);
        }
      });
    }

    if (!body.fullName || !body.password) throw AppError.unprocessable('Full name and password are required', 'VALIDATION_ERROR', [{ field: 'password', message: 'Required' }]);
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: inv.email,
          fullName: body.fullName!,
          passwordHash,
          emailVerifiedAt: new Date(), // proven by the emailed token
          status: inv.organization.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING_REVIEW',
        },
      });
      await tx.organizationMember.create({ data: { organizationId: inv.organizationId, userId: user.id, roleId: inv.roleId } });
      await tx.organizationInvitation.update({ where: { id: inv.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
      await audit({ actor: { type: 'USER', userId: user.id, email: user.email }, action: 'USER_CREATED', resource: 'user', resourceId: user.id, organizationId: inv.organizationId, metadata: { via: 'invitation' }, meta: metaFromRequest(req) }, tx);
      return user;
    });
    await notifyOrganization(inv.organizationId, { type: 'TEAM_JOINED', title: 'New team member', body: `${user.fullName} joined as ${inv.role.name}`, link: '/app/settings/team' }, 'team.view');
    const session = await createSession(user.id, metaFromRequest(req));
    res.cookie(REFRESH_COOKIE, session.refreshToken, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/api/v1/auth', expires: session.refreshExpiresAt });
    return created(res, { accessToken: session.accessToken, organizationId: inv.organizationId }, `Welcome to ${inv.organization.name}!`);
  }),
);
