import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { audit } from '../audit-logs/audit.service';
import { notifyOrganization } from '../notifications/notification.service';
import { syncVerificationSuspension } from '../verification/verification.service';

export const adminOrganizationsRouter = Router();

adminOrganizationsRouter.get(
  '/',
  requirePlatformPermission('organizations.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({ search: z.string().trim().max(100).optional(), status: z.enum(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED']).optional() }),
      req.query,
    );
    const where: Prisma.OrganizationWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { OR: [{ name: { contains: q.search } }, { registrationNumber: { contains: q.search } }] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(q),
        include: {
          wallet: { select: { balance: true } },
          members: { where: { isOwner: true }, select: { user: { select: { fullName: true, email: true } } } },
          _count: { select: { members: true, senders: true } },
        },
      }),
      prisma.organization.count({ where }),
    ]);
    return paginated(
      res,
      items.map(({ members, wallet, _count, ...o }) => ({ ...o, owner: members[0]?.user ?? null, balance: wallet?.balance ?? 0, memberCount: _count.members, senderCount: _count.senders })),
      q.page,
      q.limit,
      total,
    );
  }),
);

adminOrganizationsRouter.get(
  '/:id',
  requirePlatformPermission('organizations.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const org = await prisma.organization.findUnique({
      where: { id },
      include: {
        wallet: true,
        members: { include: { user: { select: { id: true, fullName: true, email: true, status: true, lastLoginAt: true } }, role: { select: { name: true } } } },
        senders: { orderBy: { createdAt: 'desc' } },
        verifications: { orderBy: { createdAt: 'desc' }, take: 1, include: { documents: { select: { id: true, documentType: true, originalName: true, status: true, createdAt: true } } } },
        _count: { select: { contacts: true, campaigns: true, apiKeys: true, webhooks: true } },
      },
    });
    if (!org) throw AppError.notFound('Organization');
    const [smsTotal, paymentsTotal] = await Promise.all([
      prisma.smsRecipient.count({ where: { organizationId: id } }),
      prisma.payment.aggregate({ where: { organizationId: id, status: 'SUCCESS' }, _sum: { amount: true }, _count: true }),
    ]);
    return ok(res, { ...org, stats: { smsTotal, payments: paymentsTotal._count, revenue: (paymentsTotal._sum.amount ?? 0).toString() } });
  }),
);

/** Suspension blocks SMS, campaigns, API and purchases; billing/history stay readable. */
adminOrganizationsRouter.post(
  '/:id/status',
  requirePlatformPermission('organizations.suspend'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ action: z.enum(['suspend', 'reactivate']), reason: z.string().trim().max(500).optional() }), req.body);
    const org = await prisma.organization.findUnique({ where: { id } });
    if (!org) throw AppError.notFound('Organization');
    if (body.action === 'suspend') {
      if (org.status === 'SUSPENDED') throw AppError.conflict('Organization is already suspended', 'INVALID_TRANSITION');
      if (!body.reason) throw AppError.unprocessable('A reason is required', 'NOTE_REQUIRED', [{ field: 'reason', message: 'Required' }]);
    } else if (org.status !== 'SUSPENDED') throw AppError.conflict('Organization is not suspended', 'INVALID_TRANSITION');

    await prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id },
        data: body.action === 'suspend'
          ? { status: 'SUSPENDED', suspendedAt: new Date(), statusReason: body.reason }
          : { status: org.approvedAt ? 'ACTIVE' : 'DRAFT', suspendedAt: null, statusReason: null },
      });
      await syncVerificationSuspension(tx, id, body.action === 'suspend', body.reason, actorFromRequest(req));
      await audit({ actor: actorFromRequest(req), action: body.action === 'suspend' ? 'CUSTOMER_SUSPENDED' : 'CUSTOMER_REACTIVATED', resource: 'organization', resourceId: id, organizationId: id, metadata: { reason: body.reason }, meta: metaFromRequest(req) }, tx);
    });
    await notifyOrganization(id, body.action === 'suspend'
      ? { type: 'ACCOUNT_SUSPENDED', title: 'Your account has been suspended', body: `Messaging is disabled. Reason: ${body.reason}`, link: '/app' }
      : { type: 'ACCOUNT_REACTIVATED', title: 'Your account has been reactivated', body: 'Messaging is enabled again.', link: '/app' });
    return ok(res, null, body.action === 'suspend' ? 'Organization suspended' : 'Organization reactivated');
  }),
);

adminOrganizationsRouter.patch(
  '/:id',
  requirePlatformPermission('organizations.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(160).optional(),
        registrationNumber: z.string().trim().max(80).nullable().optional(),
        taxId: z.string().trim().max(80).nullable().optional(),
        businessType: z.string().trim().max(80).nullable().optional(),
        country: z.string().trim().max(80).nullable().optional(),
      }),
      req.body,
    );
    const updated = await prisma.organization.update({ where: { id }, data: body });
    await audit({ actor: actorFromRequest(req), action: 'ORGANIZATION_UPDATED', resource: 'organization', resourceId: id, organizationId: id, metadata: { fields: Object.keys(body), byStaff: true }, meta: metaFromRequest(req) });
    return ok(res, updated, 'Organization updated');
  }),
);
