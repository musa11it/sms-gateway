import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { asyncHandler, ok, paginated, paginationSchema, parse, uuidParam } from '../../utils/http';
import { AppError } from '../../utils/errors';

/** Notifications belong to the signed-in user (not the organization), so no tenant header is needed. */
export const notificationRouter = Router();

notificationRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ unread: z.enum(['true', 'false']).optional() }), req.query);
    const where = { userId: req.user!.id, ...(q.unread === 'true' ? { readAt: null } : {}) };
    const [items, total, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: req.user!.id, readAt: null } }),
    ]);
    res.setHeader('X-Unread-Count', String(unread));
    return paginated(res, items, q.page, q.limit, total);
  }),
);

notificationRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => ok(res, { count: await prisma.notification.count({ where: { userId: req.user!.id, readAt: null } }) })),
);

notificationRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const r = await prisma.notification.updateMany({ where: { id, userId: req.user!.id }, data: { readAt: new Date() } });
    if (r.count === 0) throw AppError.notFound('Notification');
    return ok(res, null);
  }),
);

notificationRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({ where: { userId: req.user!.id, readAt: null }, data: { readAt: new Date() } });
    return ok(res, null, 'All notifications marked as read');
  }),
);
