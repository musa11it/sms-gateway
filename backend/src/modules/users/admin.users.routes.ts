import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { audit } from '../audit-logs/audit.service';
import { hashPassword, passwordSchema } from '../auth/password';
import { notifyUser } from '../notifications/notification.service';
import { loadRolePermissions } from '../permissions/permission.service';

export const adminUsersRouter = Router();

const userSelect = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  status: true,
  statusReason: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  roles: { select: { role: { select: { id: true, code: true, name: true } } } },
  memberships: { select: { isOwner: true, organization: { select: { id: true, name: true, status: true } }, role: { select: { name: true } } } },
} satisfies Prisma.UserSelect;

adminUsersRouter.get(
  '/',
  requirePlatformPermission('users.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        search: z.string().trim().max(100).optional(),
        status: z.enum(['PENDING_EMAIL_VERIFICATION', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'DEACTIVATED']).optional(),
        type: z.enum(['staff', 'customer']).optional(),
      }),
      req.query,
    );
    const where: Prisma.UserWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.type === 'staff' ? { roles: { some: {} } } : q.type === 'customer' ? { roles: { none: {} } } : {}),
      ...(q.search ? { OR: [{ email: { contains: q.search, mode: 'insensitive' } }, { fullName: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), select: userSelect }),
      prisma.user.count({ where }),
    ]);
    return paginated(res, items.map((u) => ({ ...u, roles: u.roles.map((r) => r.role) })), q.page, q.limit, total);
  }),
);

adminUsersRouter.get(
  '/:id',
  requirePlatformPermission('users.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const u = await prisma.user.findUnique({ where: { id }, select: userSelect });
    if (!u) throw AppError.notFound('User');
    return ok(res, { ...u, roles: u.roles.map((r) => r.role) });
  }),
);

/** Only roles whose permissions the actor fully holds can be assigned (SUPER_ADMIN by SUPER_ADMIN only). */
async function assertAssignable(req: Express.Request, roleIds: string[]) {
  const roles = await prisma.role.findMany({ where: { id: { in: roleIds }, scope: 'PLATFORM' } });
  if (roles.length !== new Set(roleIds).size) throw AppError.unprocessable('Unknown platform role', 'ROLE_NOT_FOUND');
  const isSuper = req.user!.platformRoles.includes('SUPER_ADMIN');
  for (const role of roles) {
    if (role.code === 'SUPER_ADMIN' && !isSuper) throw AppError.forbidden('Only a Super Admin can grant Super Admin', 'PRIVILEGE_ESCALATION');
    const perms = await loadRolePermissions(role.id);
    if ([...perms.permissions].some((p) => !req.user!.platformPermissions.has(p))) {
      throw AppError.forbidden(`You cannot assign "${role.name}" because it has permissions you do not hold`, 'PRIVILEGE_ESCALATION');
    }
  }
  return roles;
}

adminUsersRouter.post(
  '/',
  requirePlatformPermission('users.create', 'roles.assign'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ email: z.string().trim().toLowerCase().email(), fullName: z.string().trim().min(2).max(120), password: passwordSchema, roleIds: z.array(z.string().uuid()).min(1) }),
      req.body,
    );
    await assertAssignable(req, body.roleIds);
    if (await prisma.user.findUnique({ where: { email: body.email } })) throw AppError.conflict('A user with this email already exists', 'EMAIL_TAKEN');
    const user = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: body.email,
          fullName: body.fullName,
          passwordHash: await hashPassword(body.password),
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          roles: { create: body.roleIds.map((roleId) => ({ roleId, assignedById: req.user!.id })) },
        },
      });
      await audit({ actor: actorFromRequest(req), action: 'USER_CREATED', resource: 'user', resourceId: user.id, metadata: { email: user.email, roleIds: body.roleIds, staff: true }, meta: metaFromRequest(req) }, tx);
      return user;
    });
    return created(res, { id: user.id, email: user.email }, 'Staff user created');
  }),
);

adminUsersRouter.patch(
  '/:id',
  requirePlatformPermission('users.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ fullName: z.string().trim().min(2).max(120).optional() }), req.body);
    const u = await prisma.user.update({ where: { id }, data: body, select: { id: true, fullName: true } });
    await audit({ actor: actorFromRequest(req), action: 'USER_UPDATED', resource: 'user', resourceId: id, metadata: body, meta: metaFromRequest(req) });
    return ok(res, u, 'User updated');
  }),
);

adminUsersRouter.put(
  '/:id/roles',
  requirePlatformPermission('roles.assign'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { roleIds } = parse(z.object({ roleIds: z.array(z.string().uuid()) }), req.body);
    if (id === req.user!.id) throw AppError.forbidden('You cannot change your own roles', 'SELF_MODIFICATION');
    const target = await prisma.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } });
    if (!target) throw AppError.notFound('User');
    const current = target.roles.map((r) => r.roleId);
    const added = roleIds.filter((r) => !current.includes(r));
    const removed = target.roles.filter((r) => !roleIds.includes(r.roleId));
    await assertAssignable(req, added);
    if (removed.some((r) => r.role.code === 'SUPER_ADMIN') && !req.user!.platformRoles.includes('SUPER_ADMIN')) {
      throw AppError.forbidden('Only a Super Admin can remove Super Admin', 'PRIVILEGE_ESCALATION');
    }
    for (const r of removed) {
      const perms = await loadRolePermissions(r.roleId);
      if ([...perms.permissions].some((p) => !req.user!.platformPermissions.has(p))) {
        throw AppError.forbidden(`You cannot remove "${r.role.name}" because it has permissions you do not hold`, 'PRIVILEGE_ESCALATION');
      }
    }
    await prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId: id, roleId: { in: removed.map((r) => r.roleId) } } });
      if (added.length) await tx.userRole.createMany({ data: added.map((roleId) => ({ userId: id, roleId, assignedById: req.user!.id })) });
      await audit({ actor: actorFromRequest(req), action: 'PERMISSION_CHANGED', resource: 'user', resourceId: id, metadata: { addedRoleIds: added, removedRoles: removed.map((r) => r.role.code) }, meta: metaFromRequest(req) }, tx);
    });
    return ok(res, null, 'Roles updated');
  }),
);

adminUsersRouter.post(
  '/:id/status',
  requirePlatformPermission('users.suspend'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ action: z.enum(['suspend', 'reactivate', 'deactivate']), reason: z.string().trim().max(500).optional() }), req.body);
    if (id === req.user!.id) throw AppError.forbidden('You cannot change your own account status', 'SELF_MODIFICATION');
    const u = await prisma.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } });
    if (!u) throw AppError.notFound('User');
    if (u.roles.some((r) => r.role.code === 'SUPER_ADMIN') && !req.user!.platformRoles.includes('SUPER_ADMIN')) {
      throw AppError.forbidden('Only a Super Admin can change a Super Admin', 'PRIVILEGE_ESCALATION');
    }
    if (body.action !== 'reactivate' && !body.reason) throw AppError.unprocessable('A reason is required', 'NOTE_REQUIRED', [{ field: 'reason', message: 'Required' }]);
    const status = body.action === 'suspend' ? 'SUSPENDED' : body.action === 'deactivate' ? 'DEACTIVATED' : u.emailVerifiedAt ? 'ACTIVE' : 'PENDING_EMAIL_VERIFICATION';
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status, statusReason: body.reason ?? null } });
      if (status !== 'ACTIVE') await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: `account_${body.action}` } });
      await audit({ actor: actorFromRequest(req), action: body.action === 'suspend' ? 'USER_SUSPENDED' : body.action === 'deactivate' ? 'USER_DEACTIVATED' : 'USER_REACTIVATED', resource: 'user', resourceId: id, metadata: { reason: body.reason }, meta: metaFromRequest(req) }, tx);
    });
    if (body.action === 'reactivate') await notifyUser(id, null, { type: 'ACCOUNT_REACTIVATED', title: 'Your account was reactivated', body: 'You can sign in again.' });
    return ok(res, { status }, `User ${body.action}d`);
  }),
);

adminUsersRouter.post(
  '/:id/approve',
  requirePlatformPermission('users.approve'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { decision, reason } = parse(z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).optional() }), req.body);
    const u = await prisma.user.findUnique({ where: { id } });
    if (!u) throw AppError.notFound('User');
    if (u.status !== 'PENDING_REVIEW') throw AppError.conflict('Only users pending review can be approved or rejected', 'INVALID_TRANSITION');
    await prisma.user.update({ where: { id }, data: { status: decision === 'approve' ? 'ACTIVE' : 'REJECTED', statusReason: reason ?? null } });
    await audit({ actor: actorFromRequest(req), action: decision === 'approve' ? 'USER_APPROVED' : 'USER_REJECTED', resource: 'user', resourceId: id, metadata: { reason }, meta: metaFromRequest(req) });
    return ok(res, null, decision === 'approve' ? 'User approved' : 'User rejected');
  }),
);
