import crypto from 'crypto';
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requireOrgPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { encrypt } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { stringList } from '../../utils/json';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { queue } from '../../workers/queue';
import { audit } from '../audit-logs/audit.service';
import { WEBHOOK_EVENTS, assertSafeWebhookUrl } from './webhook.service';

export const webhookRouter = Router();

const body = z.object({
  url: z.string().trim().url().max(500),
  description: z.string().trim().max(200).optional().nullable(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Select at least one event'),
  isActive: z.boolean().optional(),
});

const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;

const serialize = (w: { id: string; url: string; description: string | null; events: Prisma.JsonValue; isActive: boolean; createdAt: Date; updatedAt: Date }) => ({
  id: w.id,
  url: w.url,
  description: w.description,
  events: stringList(w.events),
  isActive: w.isActive,
  createdAt: w.createdAt,
  updatedAt: w.updatedAt,
});

webhookRouter.get('/events', asyncHandler(async (_req, res) => ok(res, WEBHOOK_EVENTS)));

webhookRouter.get(
  '/',
  requireOrgPermission('webhooks.view'),
  asyncHandler(async (req, res) => {
    const hooks = await prisma.webhook.findMany({ where: { organizationId: req.org!.id }, orderBy: { createdAt: 'desc' } });
    const since = new Date(Date.now() - 7 * 86_400_000);
    const stats = await prisma.webhookDelivery.groupBy({ by: ['webhookId', 'status'], where: { organizationId: req.org!.id, createdAt: { gte: since } }, _count: true });
    return ok(
      res,
      hooks.map((h) => {
        const s = stats.filter((x) => x.webhookId === h.id);
        const c = (st: string) => s.find((x) => x.status === st)?._count ?? 0;
        return { ...serialize(h), stats7d: { success: c('SUCCESS'), failed: c('FAILED'), pending: c('PENDING') + c('RETRYING') } };
      }),
    );
  }),
);

webhookRouter.post(
  '/',
  requireOrgPermission('webhooks.create'),
  asyncHandler(async (req, res) => {
    const input = parse(body, req.body);
    await assertSafeWebhookUrl(input.url);
    const count = await prisma.webhook.count({ where: { organizationId: req.org!.id } });
    if (count >= 10) throw AppError.conflict('You can configure up to 10 webhooks', 'WEBHOOK_LIMIT');
    const secret = newSecret();
    const hook = await prisma.webhook.create({
      data: { organizationId: req.org!.id, url: input.url, description: input.description, events: input.events, isActive: input.isActive ?? true, secretEncrypted: encrypt(secret), createdById: req.user!.id },
    });
    await audit({ actor: actorFromRequest(req), action: 'WEBHOOK_CREATED', resource: 'webhook', resourceId: hook.id, organizationId: req.org!.id, metadata: { url: hook.url, events: hook.events }, meta: metaFromRequest(req) });
    return created(res, { webhook: serialize(hook), secret }, 'Webhook created. Copy the signing secret now — it will not be shown again.');
  }),
);

webhookRouter.patch(
  '/:id',
  requireOrgPermission('webhooks.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const input = parse(body.partial(), req.body);
    const hook = await prisma.webhook.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!hook) throw AppError.notFound('Webhook');
    if (input.url) await assertSafeWebhookUrl(input.url);
    const updated = await prisma.webhook.update({ where: { id }, data: input });
    await audit({ actor: actorFromRequest(req), action: 'WEBHOOK_UPDATED', resource: 'webhook', resourceId: id, organizationId: req.org!.id, metadata: input, meta: metaFromRequest(req) });
    return ok(res, serialize(updated), 'Webhook updated');
  }),
);

webhookRouter.post(
  '/:id/rotate-secret',
  requireOrgPermission('webhooks.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const hook = await prisma.webhook.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!hook) throw AppError.notFound('Webhook');
    const secret = newSecret();
    await prisma.webhook.update({ where: { id }, data: { secretEncrypted: encrypt(secret) } });
    await audit({ actor: actorFromRequest(req), action: 'WEBHOOK_SECRET_ROTATED', resource: 'webhook', resourceId: id, organizationId: req.org!.id, meta: metaFromRequest(req) });
    return ok(res, { secret }, 'Signing secret rotated');
  }),
);

webhookRouter.delete(
  '/:id',
  requireOrgPermission('webhooks.delete'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const result = await prisma.webhook.deleteMany({ where: { id, organizationId: req.org!.id } });
    if (result.count === 0) throw AppError.notFound('Webhook');
    await audit({ actor: actorFromRequest(req), action: 'WEBHOOK_DELETED', resource: 'webhook', resourceId: id, organizationId: req.org!.id, meta: metaFromRequest(req) });
    return ok(res, null, 'Webhook deleted');
  }),
);

webhookRouter.post(
  '/:id/test',
  requireOrgPermission('webhooks.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const hook = await prisma.webhook.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!hook) throw AppError.notFound('Webhook');
    const eventId = `evt_test_${crypto.randomBytes(8).toString('hex')}`;
    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookId: id,
        organizationId: req.org!.id,
        event: 'webhook.test',
        eventId,
        payload: { id: eventId, type: 'webhook.test', created: new Date().toISOString(), data: { message: 'This is a test event from SMS Gateway' } },
        status: 'PENDING',
        nextAttemptAt: new Date(),
      },
    });
    await queue.enqueue('webhook.deliver', { deliveryId: delivery.id }, { jobId: delivery.id, attempts: 1 });
    return ok(res, { deliveryId: delivery.id }, 'Test event queued');
  }),
);

webhookRouter.get(
  '/:id/deliveries',
  requireOrgPermission('webhooks.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const q = parse(paginationSchema, req.query);
    const hook = await prisma.webhook.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!hook) throw AppError.notFound('Webhook');
    const [items, total] = await Promise.all([
      prisma.webhookDelivery.findMany({ where: { webhookId: id }, orderBy: { createdAt: 'desc' }, ...toSkipTake(q) }),
      prisma.webhookDelivery.count({ where: { webhookId: id } }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

webhookRouter.post(
  '/deliveries/:id/redeliver',
  requireOrgPermission('webhooks.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const d = await prisma.webhookDelivery.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!d) throw AppError.notFound('Delivery');
    if (d.status === 'SUCCESS') throw AppError.conflict('This delivery already succeeded', 'ALREADY_DELIVERED');
    await prisma.webhookDelivery.update({ where: { id }, data: { status: 'RETRYING', nextAttemptAt: new Date() } });
    await queue.enqueue('webhook.deliver', { deliveryId: id }, { jobId: `${id}:manual:${Date.now()}`, attempts: 1 });
    return ok(res, null, 'Redelivery queued');
  }),
);
