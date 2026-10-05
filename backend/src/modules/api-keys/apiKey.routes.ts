import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requireOrgPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, uuidParam, toSkipTake } from '../../utils/http';
import * as svc from './apiKey.service';

export const apiKeyRouter = Router();

apiKeyRouter.get(
  '/',
  requireOrgPermission('api_keys.view'),
  asyncHandler(async (req, res) => {
    const keys = await prisma.apiKey.findMany({
      where: { organizationId: req.org!.id },
      orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
      include: { createdBy: { select: { fullName: true } } },
    });
    return ok(res, keys.map(svc.serializeApiKey));
  }),
);

apiKeyRouter.post(
  '/',
  requireOrgPermission('api_keys.create'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(60),
        scopes: z.array(z.enum(svc.API_SCOPES)).min(1).optional(),
        allowedIps: z.array(z.string().trim()).max(20).optional(),
        expiresAt: z.coerce.date().optional().nullable(),
        environment: z.enum(['production', 'staging', 'development']).optional(),
        rateLimitPerMinute: z.coerce.number().int().min(1).max(10_000).optional().nullable(),
      }),
      req.body,
    );
    const result = await svc.createApiKey(req.org!.id, body, actorFromRequest(req), metaFromRequest(req));
    return created(res, result, 'API key created. Copy the secret now — it will not be shown again.');
  }),
);

apiKeyRouter.post(
  '/:id/revoke',
  requireOrgPermission('api_keys.revoke'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.revokeApiKey(req.org!.id, id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'API key revoked');
  }),
);

apiKeyRouter.post(
  '/:id/:action(enable|disable)',
  requireOrgPermission('api_keys.revoke'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, { id: req.params.id });
    const enable = req.params.action === 'enable';
    await svc.setApiKeyEnabled(req.org!.id, id, enable, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, enable ? 'API key enabled' : 'API key disabled');
  }),
);

apiKeyRouter.post(
  '/:id/regenerate',
  requireOrgPermission('api_keys.create', 'api_keys.revoke'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const result = await svc.regenerateApiKey(req.org!.id, id, actorFromRequest(req), metaFromRequest(req));
    return created(res, result, 'API key regenerated. The old key no longer works.');
  }),
);

/** API request logs + usage (developer dashboard). */
export const apiLogRouter = Router();

apiLogRouter.get(
  '/',
  requireOrgPermission('api_keys.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        apiKeyId: z.string().uuid().optional(),
        status: z.enum(['success', 'error']).optional(),
        path: z.string().trim().max(120).optional(),
        requestId: z.string().trim().max(100).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      }),
      req.query,
    );
    const where: Prisma.ApiRequestLogWhereInput = {
      organizationId: req.org!.id,
      ...(q.apiKeyId ? { apiKeyId: q.apiKeyId } : {}),
      ...(q.status === 'success' ? { statusCode: { lt: 400 } } : q.status === 'error' ? { statusCode: { gte: 400 } } : {}),
      ...(q.path ? { path: { contains: q.path } } : {}),
      ...(q.requestId ? { requestId: q.requestId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.apiRequestLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { apiKey: { select: { name: true, prefix: true } } } }),
      prisma.apiRequestLog.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

apiLogRouter.get(
  '/usage',
  requireOrgPermission('api_keys.view'),
  asyncHandler(async (req, res) => {
    const since = new Date(Date.now() - 14 * 86_400_000);
    since.setHours(0, 0, 0, 0);
    const rows = await prisma.$queryRaw<{ day: Date; total: bigint; errors: bigint }[]>`
      SELECT DATE(createdAt) AS day, COUNT(*) AS total, COUNT(CASE WHEN statusCode >= 400 THEN 1 END) AS errors
      FROM api_request_logs WHERE organizationId = ${req.org!.id} AND createdAt >= ${since}
      GROUP BY day ORDER BY day`;
    const [total24h, errors24h, smsViaApi] = await Promise.all([
      prisma.apiRequestLog.count({ where: { organizationId: req.org!.id, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
      prisma.apiRequestLog.count({ where: { organizationId: req.org!.id, createdAt: { gte: new Date(Date.now() - 86_400_000) }, statusCode: { gte: 400 } } }),
      prisma.smsRecipient.count({ where: { organizationId: req.org!.id, message: { source: 'API' }, createdAt: { gte: since } } }),
    ]);
    return ok(res, {
      last24h: { requests: total24h, errors: errors24h },
      smsViaApi14d: smsViaApi,
      daily: rows.map((r) => ({ date: r.day.toISOString().slice(0, 10), requests: Number(r.total), errors: Number(r.errors) })),
    });
  }),
);
