import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { humanOnly } from '../../middlewares/integrationAuth';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { asyncHandler, created, ok, parse, uuidParam } from '../../utils/http';
import { SCOPES } from './scopes';
import { INTEGRATION_SCOPES, createIntegration, revokeIntegration, serializeIntegration, setIntegrationEnabled } from './integration.service';

/** Super-admin management of credentials for external systems. */
export const adminIntegrationsRouter = Router();
adminIntegrationsRouter.use(humanOnly);

/** Every scope that exists, with its level, so the admin UI can offer them. */
adminIntegrationsRouter.get('/scopes', requirePlatformPermission('integrations.view'), (_req, res) => ok(res, SCOPES));

adminIntegrationsRouter.get(
  '/',
  requirePlatformPermission('integrations.view'),
  asyncHandler(async (_req, res) => ok(res, (await prisma.integrationClient.findMany({ orderBy: { createdAt: 'desc' } })).map(serializeIntegration))),
);

adminIntegrationsRouter.post(
  '/',
  requirePlatformPermission('integrations.manage'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(100),
        scopes: z.array(z.enum(INTEGRATION_SCOPES)).min(1).max(200),
        allowedIps: z.array(z.string().trim()).max(20).default([]),
        expiresAt: z.coerce.date().nullish(),
      }),
      req.body,
    );
    return created(res, await createIntegration(body, actorFromRequest(req), metaFromRequest(req)), 'Credential created — copy the key now, it will not be shown again');
  }),
);

for (const [path, enabled, message] of [['enable', true, 'Credential enabled'], ['disable', false, 'Credential disabled']] as const) {
  adminIntegrationsRouter.post(
    `/:id/${path}`,
    requirePlatformPermission('integrations.manage'),
    asyncHandler(async (req, res) => {
      const { id } = parse(uuidParam, req.params);
      await setIntegrationEnabled(id, enabled, actorFromRequest(req), metaFromRequest(req));
      return ok(res, null, message);
    }),
  );
}

adminIntegrationsRouter.post(
  '/:id/revoke',
  requirePlatformPermission('integrations.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await revokeIntegration(id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Credential revoked');
  }),
);

/** What this credential has read or changed (newest first). */
adminIntegrationsRouter.get(
  '/:id/activity',
  requirePlatformPermission('integrations.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const rows = await prisma.auditLog.findMany({
      where: { actorType: 'API_KEY', apiKeyId: id, action: { startsWith: 'INTEGRATION_' } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, action: true, resourceId: true, organizationId: true, metadata: true, ipAddress: true, createdAt: true },
    });
    return ok(res, rows);
  }),
);
