import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { asyncHandler, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { revokeApiKey, serializeApiKey } from './apiKey.service';

export const adminApiKeysRouter = Router();

adminApiKeysRouter.get(
  '/',
  requirePlatformPermission('api_keys.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ organizationId: z.string().uuid().optional(), status: z.enum(['active', 'revoked']).optional() }), req.query);
    const where: Prisma.ApiKeyWhereInput = {
      ...(q.organizationId ? { organizationId: q.organizationId } : {}),
      ...(q.status === 'active' ? { revokedAt: null } : q.status === 'revoked' ? { revokedAt: { not: null } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.apiKey.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { organization: { select: { id: true, name: true } }, createdBy: { select: { fullName: true } } } }),
      prisma.apiKey.count({ where }),
    ]);
    return paginated(res, items.map((k) => ({ ...serializeApiKey(k), organization: k.organization })), q.page, q.limit, total);
  }),
);

adminApiKeysRouter.post(
  '/:id/revoke',
  requirePlatformPermission('api_keys.revoke'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await revokeApiKey(null, id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'API key revoked');
  }),
);
