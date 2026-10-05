import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { campaignStats, cancelCampaign, emptyStats } from '../campaigns/campaign.service';
import { cancelScheduledMessage, retryRecipient } from './sms.service';

export const adminSmsRouter = Router();

adminSmsRouter.get(
  '/messages',
  requirePlatformPermission('sms.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        status: z.enum(['QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED', 'CANCELLED']).optional(),
        organizationId: z.string().uuid().optional(),
        search: z.string().trim().max(40).optional(),
        provider: z.string().max(40).optional(),
      }),
      req.query,
    );
    const where: Prisma.SmsRecipientWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.organizationId ? { organizationId: q.organizationId } : {}),
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.search ? { OR: [{ phone: { contains: q.search } }, { providerMessageId: { contains: q.search } }] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.smsRecipient.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(q),
        include: { organization: { select: { id: true, name: true } }, message: { select: { senderName: true, body: true, source: true, segments: true } } },
      }),
      prisma.smsRecipient.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

adminSmsRouter.get(
  '/messages/:id',
  requirePlatformPermission('sms.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const r = await prisma.smsRecipient.findUnique({
      where: { id },
      include: { organization: { select: { id: true, name: true } }, message: true, deliveryReports: { orderBy: { createdAt: 'asc' } } },
    });
    if (!r) throw AppError.notFound('Message');
    return ok(res, r);
  }),
);

adminSmsRouter.post(
  '/messages/:id/retry',
  requirePlatformPermission('sms.retry'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await retryRecipient(id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Message re-queued');
  }),
);

adminSmsRouter.post(
  '/batches/:id/cancel',
  requirePlatformPermission('sms.cancel'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await cancelScheduledMessage(null, id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Scheduled message cancelled and refunded');
  }),
);

adminSmsRouter.get(
  '/campaigns',
  requirePlatformPermission('campaigns.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ status: z.enum(['DRAFT', 'SCHEDULED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED']).optional(), organizationId: z.string().uuid().optional() }), req.query);
    const where: Prisma.CampaignWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.organizationId ? { organizationId: q.organizationId } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.campaign.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { organization: { select: { id: true, name: true } }, sender: { select: { name: true } } } }),
      prisma.campaign.count({ where }),
    ]);
    const stats = await campaignStats(items.map((i) => i.id));
    return paginated(res, items.map((c) => ({ ...c, stats: stats.get(c.id) ?? emptyStats() })), q.page, q.limit, total);
  }),
);

adminSmsRouter.post(
  '/campaigns/:id/cancel',
  requirePlatformPermission('campaigns.cancel'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await cancelCampaign(null, id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Campaign cancelled');
  }),
);
