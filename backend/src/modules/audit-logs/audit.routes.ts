import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requireOrgPermission, requirePlatformPermission } from '../../middlewares/rbac';
import { asyncHandler, paginated, paginationSchema, parse, toSkipTake } from '../../utils/http';

const query = paginationSchema.extend({
  action: z.string().trim().max(60).optional(),
  resource: z.string().trim().max(60).optional(),
  actorId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function buildWhere(q: z.infer<typeof query>, organizationId?: string): Prisma.AuditLogWhereInput {
  return {
    ...(organizationId ? { organizationId } : q.organizationId ? { organizationId: q.organizationId } : {}),
    ...(q.action ? { action: { contains: q.action.toUpperCase() } } : {}),
    ...(q.resource ? { resource: q.resource } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
  };
}

const include = { actor: { select: { id: true, fullName: true, email: true } }, organization: { select: { id: true, name: true } } } as const;

/** Tenant view: only the organization's own audit trail. */
export const orgAuditRouter = Router();
orgAuditRouter.get(
  '/',
  requireOrgPermission('audit_logs.view'),
  asyncHandler(async (req, res) => {
    const q = parse(query, req.query);
    const where = buildWhere(q, req.org!.id);
    const [items, total] = await Promise.all([prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include }), prisma.auditLog.count({ where })]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

/** Platform view: all audit records. */
export const adminAuditRouter = Router();
adminAuditRouter.get(
  '/',
  requirePlatformPermission('audit_logs.view'),
  asyncHandler(async (req, res) => {
    const q = parse(query, req.query);
    const where = buildWhere(q);
    const [items, total] = await Promise.all([prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include }), prisma.auditLog.count({ where })]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);
