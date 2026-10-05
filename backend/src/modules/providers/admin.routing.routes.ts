import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { asyncHandler, created, ok, parse, uuidParam } from '../../utils/http';
import { simulateBody, simulateRouting } from './providerAdmin.service';
import * as svc from './routingAdmin.service';

/** Super Admin routing management: destination networks, routing rules and the simulator. */
export const adminRoutingRouter = Router();

adminRoutingRouter.get(
  '/networks',
  requirePlatformPermission('providers.view'),
  asyncHandler(async (_req, res) => {
    const networks = await prisma.smsNetwork.findMany({ orderBy: [{ countryCode: 'asc' }, { name: 'asc' }], include: { _count: { select: { providers: true } } } });
    return ok(res, networks.map(svc.serializeNetwork));
  }),
);

adminRoutingRouter.post(
  '/networks',
  requirePlatformPermission('providers.manage'),
  asyncHandler(async (req, res) => {
    const n = await svc.createNetwork(parse(svc.networkBody, req.body), actorFromRequest(req), metaFromRequest(req));
    return created(res, svc.serializeNetwork(n), 'Network created');
  }),
);

adminRoutingRouter.patch(
  '/networks/:id',
  requirePlatformPermission('providers.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(svc.networkBody.partial(), req.body);
    return ok(res, svc.serializeNetwork(await svc.updateNetwork(id, body, actorFromRequest(req), metaFromRequest(req))), 'Network updated');
  }),
);

adminRoutingRouter.get('/rules', requirePlatformPermission('providers.view'), asyncHandler(async (_req, res) => ok(res, await svc.listRules())));

adminRoutingRouter.post(
  '/rules',
  requirePlatformPermission('providers.manage'),
  asyncHandler(async (req, res) => {
    const rule = await svc.createRule(parse(svc.ruleCreateBody, req.body), actorFromRequest(req), metaFromRequest(req));
    return created(res, (await svc.listRules()).find((r) => r.id === rule.id), 'Routing rule created');
  }),
);

adminRoutingRouter.post(
  '/rules/reorder',
  requirePlatformPermission('providers.manage'),
  asyncHandler(async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }), req.body);
    await svc.reorderRules(ids, actorFromRequest(req), metaFromRequest(req));
    return ok(res, await svc.listRules(), 'Rule order saved');
  }),
);

adminRoutingRouter.patch(
  '/rules/:id',
  requirePlatformPermission('providers.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.updateRule(id, parse(svc.ruleUpdateBody, req.body), actorFromRequest(req), metaFromRequest(req));
    return ok(res, (await svc.listRules()).find((r) => r.id === id), 'Routing rule updated');
  }),
);

/** Explain how a send would be routed right now. Read-only: no credits or capacity are touched. */
adminRoutingRouter.post(
  '/simulate',
  requirePlatformPermission('providers.view'),
  asyncHandler(async (req, res) => {
    const result = await simulateRouting(parse(simulateBody, req.body));
    if (!req.user!.platformPermissions.has('profit.view')) result.estimate = { ...result.estimate, grossMargin: null };
    return ok(res, result);
  }),
);
