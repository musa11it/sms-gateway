import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { asyncHandler, ok, paginated, paginationSchema, parse, toSkipTake } from '../../utils/http';

/** Platform-wide developer activity: API usage and webhook deliveries. */
export const adminDeveloperRouter = Router();

adminDeveloperRouter.get(
  '/api-logs',
  requirePlatformPermission('api_keys.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        organizationId: z.string().uuid().optional(),
        status: z.enum(['success', 'error']).optional(),
        path: z.string().trim().max(120).optional(),
        requestId: z.string().trim().max(100).optional(),
      }),
      req.query,
    );
    const where: Prisma.ApiRequestLogWhereInput = {
      ...(q.organizationId ? { organizationId: q.organizationId } : {}),
      ...(q.status === 'success' ? { statusCode: { lt: 400 } } : q.status === 'error' ? { statusCode: { gte: 400 } } : {}),
      ...(q.path ? { path: { contains: q.path } } : {}),
      ...(q.requestId ? { requestId: q.requestId } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.apiRequestLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { apiKey: { select: { name: true, prefix: true } }, organization: { select: { id: true, name: true } } } }),
      prisma.apiRequestLog.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

adminDeveloperRouter.get(
  '/usage',
  requirePlatformPermission('api_keys.view'),
  asyncHandler(async (_req, res) => {
    const since = new Date(Date.now() - 86_400_000);
    const [total, errors, byOrg] = await Promise.all([
      prisma.apiRequestLog.count({ where: { createdAt: { gte: since } } }),
      prisma.apiRequestLog.count({ where: { createdAt: { gte: since }, statusCode: { gte: 400 } } }),
      prisma.apiRequestLog.groupBy({ by: ['organizationId'], where: { createdAt: { gte: since } }, _count: true, orderBy: { _count: { organizationId: 'desc' } }, take: 10 }),
    ]);
    const orgs = await prisma.organization.findMany({ where: { id: { in: byOrg.map((b) => b.organizationId) } }, select: { id: true, name: true } });
    return ok(res, { last24h: { requests: total, errors }, topOrganizations: byOrg.map((b) => ({ id: b.organizationId, name: orgs.find((o) => o.id === b.organizationId)?.name ?? '—', requests: b._count })) });
  }),
);

adminDeveloperRouter.get(
  '/webhooks',
  requirePlatformPermission('webhooks.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ status: z.enum(['PENDING', 'SUCCESS', 'RETRYING', 'FAILED']).optional() }), req.query);
    const where: Prisma.WebhookDeliveryWhereInput = q.status ? { status: q.status } : {};
    const [items, total] = await Promise.all([
      prisma.webhookDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), select: { id: true, event: true, status: true, attempts: true, responseStatus: true, lastError: true, createdAt: true, deliveredAt: true, nextAttemptAt: true, webhook: { select: { url: true, organization: { select: { id: true, name: true } } } } } }),
      prisma.webhookDelivery.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);
