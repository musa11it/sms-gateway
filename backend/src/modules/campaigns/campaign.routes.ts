import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requireActiveOrganization } from '../../middlewares/organization';
import { requireOrgPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { MESSAGE_INPUT_HARD_LIMIT } from '../sms/segmentation.service';
import * as svc from './campaign.service';

export const campaignRouter = Router();

const body = z.object({
  name: z.string().trim().min(2).max(120),
  senderId: z.string().uuid(),
  message: z.string().min(1).max(MESSAGE_INPUT_HARD_LIMIT),
  groupIds: z.array(z.string().uuid()).max(100).optional(),
  contactIds: z.array(z.string().uuid()).max(50_000).optional(),
  phones: z.array(z.string().trim().min(3).max(30)).max(50_000).optional(),
  scheduledAt: z.coerce.date().optional().nullable(),
  timezone: z.string().max(64).optional(),
  // Destination networks the campaign is limited to (empty = any configured network).
  networkIds: z.array(z.string().uuid()).max(50).optional().nullable(),
});

campaignRouter.get(
  '/',
  requireOrgPermission('campaigns.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        status: z.enum(['DRAFT', 'SCHEDULED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED']).optional(),
        search: z.string().trim().max(100).optional(),
      }),
      req.query,
    );
    const where: Prisma.CampaignWhereInput = {
      organizationId: req.org!.id,
      ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { name: { contains: q.search } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.campaign.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { sender: { select: { id: true, name: true, status: true } } } }),
      prisma.campaign.count({ where }),
    ]);
    const stats = await svc.campaignStats(items.map((i) => i.id));
    return paginated(res, items.map((c) => ({ ...c, stats: stats.get(c.id) ?? svc.emptyStats() })), q.page, q.limit, total);
  }),
);

campaignRouter.post(
  '/',
  requireOrgPermission('campaigns.create'),
  asyncHandler(async (req, res) => {
    const input = parse(body, req.body);
    const c = await svc.createCampaign(req.org!.id, input, actorFromRequest(req), metaFromRequest(req));
    return created(res, c, 'Campaign saved as draft');
  }),
);

campaignRouter.get(
  '/:id',
  requireOrgPermission('campaigns.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const c = await prisma.campaign.findFirst({
      where: { id, organizationId: req.org!.id },
      include: {
        sender: { select: { id: true, name: true, status: true } },
        groups: { include: { group: { select: { id: true, name: true, color: true, _count: { select: { members: true } } } } } },
        recipients: { take: 500, select: { id: true, phone: true, contactId: true } },
        smsMessage: { select: { id: true, status: true, segments: true, encoding: true, totalCredits: true, recipientCount: true, characterCount: true } },
        _count: { select: { recipients: true } },
      },
    });
    if (!c) throw AppError.notFound('Campaign');
    const stats = (await svc.campaignStats([id])).get(id) ?? svc.emptyStats();
    return ok(res, {
      ...c,
      groups: c.groups.map((g) => ({ id: g.group.id, name: g.group.name, color: g.group.color, contactCount: g.group._count.members })),
      explicitRecipientCount: c._count.recipients,
      stats,
    });
  }),
);

campaignRouter.patch(
  '/:id',
  requireOrgPermission('campaigns.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const input = parse(body.partial(), req.body);
    return ok(res, await svc.updateCampaign(req.org!.id, id, input, actorFromRequest(req), metaFromRequest(req)), 'Campaign updated');
  }),
);

campaignRouter.delete(
  '/:id',
  requireOrgPermission('campaigns.delete'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.deleteCampaign(req.org!.id, id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Campaign deleted');
  }),
);

campaignRouter.post(
  '/:id/launch',
  requireActiveOrganization,
  asyncHandler(async (req, res, next) => {
    const { id } = parse(uuidParam, req.params);
    const { scheduledAt } = parse(z.object({ scheduledAt: z.coerce.date().optional().nullable() }), req.body ?? {});
    const needed = scheduledAt ? 'campaigns.schedule' : 'campaigns.send';
    if (!req.org!.permissions.has(needed)) return next(AppError.forbidden(undefined, 'PERMISSION_DENIED'));
    const result = await svc.launchCampaign(req.org!.id, id, scheduledAt ?? null, actorFromRequest(req), metaFromRequest(req));
    return ok(
      res,
      { messageId: result.message.id, status: result.message.status, recipients: result.message.recipientCount, totalCredits: result.message.totalCredits, skipped: result.skipped },
      scheduledAt ? 'Campaign scheduled' : 'Campaign launched',
    );
  }),
);

campaignRouter.post(
  '/:id/cancel',
  requireOrgPermission('campaigns.cancel'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const c = await svc.cancelCampaign(req.org!.id, id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, c, 'Campaign cancelled');
  }),
);

campaignRouter.post(
  '/:id/duplicate',
  requireOrgPermission('campaigns.create'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const c = await prisma.campaign.findFirst({ where: { id, organizationId: req.org!.id }, include: { groups: true, recipients: true } });
    if (!c) throw AppError.notFound('Campaign');
    const copy = await svc.createCampaign(
      req.org!.id,
      {
        name: `${c.name} (copy)`.slice(0, 120),
        senderId: c.senderId,
        message: c.message,
        groupIds: c.groups.map((g) => g.groupId),
        phones: c.recipients.map((r) => r.phone),
        timezone: c.timezone,
        networkIds: Array.isArray(c.networkIds) ? (c.networkIds as string[]) : null,
      },
      actorFromRequest(req),
      metaFromRequest(req),
    );
    return created(res, copy, 'Campaign duplicated');
  }),
);
