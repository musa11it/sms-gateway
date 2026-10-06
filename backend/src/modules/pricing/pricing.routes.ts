import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { asyncHandler, created, ok, parse, uuidParam } from '../../utils/http';
import * as svc from './pricing.service';

/** Customer-facing: active tiers and server-side quotes (any authenticated user, like packages). */
export const pricingRouter = Router();

pricingRouter.get(
  '/tiers',
  asyncHandler(async (_req, res) => ok(res, (await svc.activeTiers()).map(svc.serializeTier))),
);

pricingRouter.get(
  '/quote',
  asyncHandler(async (req, res) => {
    const { quantity } = parse(z.object({ quantity: z.unknown() }), req.query);
    return ok(res, await svc.calculateSmsPurchasePrice(quantity));
  }),
);

/** Admin: manage tiers (same permissions as SMS packages). */
export const adminPricingRouter = Router();

adminPricingRouter.get(
  '/tiers',
  requirePlatformPermission('packages.view'),
  asyncHandler(async (_req, res) => {
    const tiers = await prisma.smsPricingTier.findMany({ orderBy: [{ isActive: 'desc' }, { minQuantity: 'asc' }], include: { _count: { select: { payments: true } } } });
    return ok(res, tiers.map((t) => ({ ...svc.serializeTier(t), purchaseCount: t._count.payments })));
  }),
);

adminPricingRouter.post(
  '/tiers',
  requirePlatformPermission('packages.manage'),
  asyncHandler(async (req, res) => {
    const body = parse(svc.tierBody, req.body);
    return created(res, svc.serializeTier(await svc.createTier(body, actorFromRequest(req), metaFromRequest(req))), 'Pricing tier created');
  }),
);

adminPricingRouter.patch(
  '/tiers/:id',
  requirePlatformPermission('packages.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(svc.tierBody.partial(), req.body);
    return ok(res, svc.serializeTier(await svc.updateTier(id, body, actorFromRequest(req), metaFromRequest(req))), 'Pricing tier updated');
  }),
);

adminPricingRouter.delete(
  '/tiers/:id',
  requirePlatformPermission('packages.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.deleteTier(id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Pricing tier deleted');
  }),
);

/** Profit planning: cost per credit, fees and margin for every range, plus what each range has sold. */
adminPricingRouter.get(
  '/economics',
  requirePlatformPermission('packages.view'),
  asyncHandler(async (req, res) => {
    const data = await svc.pricingEconomics();
    // Costs and margins follow the same rule as the finance pages.
    if (!req.user!.platformPermissions.has('profit.view')) return ok(res, { restricted: true, tiers: [], inputs: null, formulas: data.formulas });
    return ok(res, { restricted: false, ...data });
  }),
);

/** Quote preview for staff (same engine as customers). */
adminPricingRouter.get(
  '/quote',
  requirePlatformPermission('packages.view'),
  asyncHandler(async (req, res) => {
    const { quantity } = parse(z.object({ quantity: z.unknown() }), req.query);
    return ok(res, await svc.calculateSmsPurchasePrice(quantity));
  }),
);
