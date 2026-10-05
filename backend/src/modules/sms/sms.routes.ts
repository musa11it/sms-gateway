import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requireActiveOrganization } from '../../middlewares/organization';
import { requireOrgPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { resolveAudience } from '../contacts/contact.service';
import * as sms from './sms.service';

export const smsRouter = Router();

const sendBody = z
  .object({
    senderId: z.string().uuid(),
    message: z.string().min(1, 'Message is required').max(1600),
    recipients: z.array(z.string().trim().min(1).max(30)).max(100_000).optional().default([]),
    contactIds: z.array(z.string().uuid()).max(100_000).optional(),
    groupIds: z.array(z.string().uuid()).max(100).optional(),
    scheduledAt: z.coerce.date().optional().nullable(),
    timezone: z.string().max(64).optional().nullable(),
    idempotencyKey: z.string().trim().min(8).max(100).optional(),
  })
  .refine((b) => b.recipients.length || b.contactIds?.length || b.groupIds?.length, { message: 'Add at least one recipient', path: ['recipients'] })
  .refine((b) => !b.scheduledAt || b.scheduledAt.getTime() > Date.now(), { message: 'Scheduled time must be in the future', path: ['scheduledAt'] });

/** Cost preview for the composer. Informational only — /send recalculates everything. */
smsRouter.post(
  '/quote',
  requireOrgPermission('sms.view'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        message: z.string().max(1600),
        recipients: z.array(z.string().max(30)).max(100_000).optional().default([]),
        contactIds: z.array(z.string().uuid()).max(100_000).optional(),
        groupIds: z.array(z.string().uuid()).max(100).optional(),
      }),
      req.body,
    );
    const audience = await resolveAudience(req.org!.id, { phones: body.recipients, contactIds: body.contactIds, groupIds: body.groupIds });
    const prepared = await sms.prepareRecipients(req.org!.id, audience);
    const q = await sms.quote(body.message, prepared.recipients.length);
    const wallet = await prisma.wallet.findUnique({ where: { organizationId: req.org!.id } });
    return ok(res, {
      ...q,
      invalid: prepared.invalid,
      duplicates: prepared.duplicates,
      optedOut: prepared.optedOut,
      balance: wallet?.balance ?? 0,
      sufficientBalance: (wallet?.balance ?? 0) >= q.totalCredits,
    });
  }),
);

smsRouter.post(
  '/send',
  requireActiveOrganization,
  requireOrgPermission('sms.send'),
  asyncHandler(async (req, res) => {
    const body = parse(sendBody, req.body);
    const audience = await resolveAudience(req.org!.id, { phones: body.recipients, contactIds: body.contactIds, groupIds: body.groupIds });
    const result = await sms.sendSms({
      organizationId: req.org!.id,
      actor: actorFromRequest(req),
      meta: metaFromRequest(req),
      senderId: body.senderId,
      recipients: audience,
      message: body.message,
      source: 'DASHBOARD',
      scheduledAt: body.scheduledAt ?? null,
      timezone: body.timezone,
      idempotencyKey: body.idempotencyKey,
    });
    const m = result.message;
    return created(
      res,
      { id: m.id, status: m.status, recipientCount: m.recipientCount, segments: m.segments, encoding: m.encoding, totalCredits: m.totalCredits, scheduledAt: m.scheduledAt, skipped: result.skipped, duplicate: result.duplicate },
      m.status === 'SCHEDULED' ? 'Message scheduled' : 'Message queued for delivery',
    );
  }),
);

// Batches (send requests)
const batchQuery = paginationSchema.extend({
  status: z.enum(['SCHEDULED', 'QUEUED', 'PROCESSING', 'SENT', 'COMPLETED', 'CANCELLED', 'FAILED']).optional(),
  source: z.enum(['DASHBOARD', 'API', 'CAMPAIGN']).optional(),
});

smsRouter.get(
  '/',
  requireOrgPermission('sms.view'),
  asyncHandler(async (req, res) => {
    const q = parse(batchQuery, req.query);
    const where: Prisma.SmsMessageWhereInput = { organizationId: req.org!.id, ...(q.status ? { status: q.status } : {}), ...(q.source ? { source: q.source } : {}) };
    const [items, total] = await Promise.all([
      prisma.smsMessage.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { campaign: { select: { id: true, name: true } } } }),
      prisma.smsMessage.count({ where }),
    ]);
    const stats = await prisma.smsRecipient.groupBy({ by: ['messageId', 'status'], where: { messageId: { in: items.map((i) => i.id) } }, _count: true });
    const data = items.map((m) => {
      const s = stats.filter((x) => x.messageId === m.id);
      const c = (st: string) => s.find((x) => x.status === st)?._count ?? 0;
      return { ...m, stats: { delivered: c('DELIVERED'), failed: c('FAILED') + c('EXPIRED'), pending: c('QUEUED') + c('PROCESSING') + c('SENT'), cancelled: c('CANCELLED') } };
    });
    return paginated(res, data, q.page, q.limit, total);
  }),
);

smsRouter.get(
  '/scheduled',
  requireOrgPermission('sms.view'),
  asyncHandler(async (req, res) => {
    const items = await prisma.smsMessage.findMany({
      where: { organizationId: req.org!.id, status: 'SCHEDULED' },
      orderBy: { scheduledAt: 'asc' },
      include: { campaign: { select: { id: true, name: true } } },
      take: 200,
    });
    return ok(res, items);
  }),
);

// Per-recipient history
const historyQuery = paginationSchema.extend({
  status: z.enum(['QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED', 'CANCELLED']).optional(),
  search: z.string().trim().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  source: z.enum(['DASHBOARD', 'API', 'CAMPAIGN']).optional(),
  batchId: z.string().uuid().optional(),
});

smsRouter.get(
  '/messages',
  requireOrgPermission('sms.view'),
  asyncHandler(async (req, res) => {
    const q = parse(historyQuery, req.query);
    const where: Prisma.SmsRecipientWhereInput = {
      organizationId: req.org!.id,
      ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { phone: { contains: q.search.replace(/\s/g, '') } } : {}),
      ...(q.batchId ? { messageId: q.batchId } : {}),
      ...(q.source ? { message: { source: q.source } } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.smsRecipient.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(q),
        include: { message: { select: { id: true, body: true, senderName: true, source: true, segments: true, encoding: true, campaignId: true } } },
      }),
      prisma.smsRecipient.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

smsRouter.get(
  '/messages/:id',
  requireOrgPermission('sms.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const item = await prisma.smsRecipient.findFirst({
      where: { id, organizationId: req.org!.id },
      include: { message: true, deliveryReports: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, status: true, providerStatus: true, errorCode: true, errorMessage: true, source: true, provider: true, occurredAt: true, createdAt: true },
        },
      },
    });
    if (!item) throw AppError.notFound('Message');
    return ok(res, item);
  }),
);

smsRouter.get(
  '/:id',
  requireOrgPermission('sms.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const msg = await prisma.smsMessage.findFirst({ where: { id, organizationId: req.org!.id }, include: { campaign: { select: { id: true, name: true } } } });
    if (!msg) throw AppError.notFound('Message');
    const grouped = await prisma.smsRecipient.groupBy({ by: ['status'], where: { messageId: id }, _count: true });
    return ok(res, { ...msg, statusBreakdown: Object.fromEntries(grouped.map((g) => [g.status, g._count])) });
  }),
);

smsRouter.post(
  '/:id/cancel',
  requireOrgPermission('sms.cancel'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await sms.cancelScheduledMessage(req.org!.id, id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Scheduled message cancelled and credits refunded');
  }),
);
