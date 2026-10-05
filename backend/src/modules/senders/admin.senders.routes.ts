import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { reviewSender, type SenderReviewAction } from './sender.service';

export const adminSendersRouter = Router();

adminSendersRouter.get(
  '/',
  requirePlatformPermission('senders.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        status: z.enum(['PENDING', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'SUSPENDED']).optional(),
        search: z.string().trim().max(60).optional(),
        organizationId: z.string().uuid().optional(),
      }),
      req.query,
    );
    const where: Prisma.SenderIdWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.organizationId ? { organizationId: q.organizationId } : {}),
      ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { organization: { name: { contains: q.search, mode: 'insensitive' } } }] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.senderId.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { organization: { select: { id: true, name: true, status: true } } } }),
      prisma.senderId.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

const PERMISSION_FOR: Record<SenderReviewAction, string> = {
  review: 'senders.review',
  request_info: 'senders.review',
  approve: 'senders.approve',
  reject: 'senders.reject',
  suspend: 'senders.suspend',
  reactivate: 'senders.suspend',
};

adminSendersRouter.post(
  '/:id/:action',
  asyncHandler(async (req, res, next) => {
    const { id, action } = parse(z.object({ id: z.string().uuid(), action: z.enum(['review', 'approve', 'reject', 'request_info', 'suspend', 'reactivate']) }), req.params);
    if (!req.user!.platformPermissions.has(PERMISSION_FOR[action])) return next(AppError.forbidden(undefined, 'PERMISSION_DENIED'));
    const { note } = parse(z.object({ note: z.string().trim().max(1000).optional() }), req.body ?? {});
    const s = await reviewSender(id, action, note, actorFromRequest(req), metaFromRequest(req));
    return ok(res, s, `Sender ID ${s.status.toLowerCase().replace('_', ' ')}`);
  }),
);

adminSendersRouter.get(
  '/:id',
  requirePlatformPermission('senders.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const s = await prisma.senderId.findUnique({
      where: { id },
      include: {
        organization: true,
        reviews: { orderBy: { createdAt: 'desc' } },
        registrations: { include: { provider: { select: { code: true, name: true } } } },
      },
    });
    if (!s) throw AppError.notFound('Sender ID');
    return ok(res, s);
  }),
);
