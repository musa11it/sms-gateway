import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { asyncHandler, created, ok, parse, uuidParam } from '../../utils/http';
import * as svc from './pricing.service';
import * as net from './networkPricing.service';
import * as lists from './priceList.service';
import { paginationSchema, toSkipTake, paginated } from '../../utils/http';

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

/** Destination countries with their networks, prices and availability (only countries with something to buy). */
pricingRouter.get(
  '/destinations',
  asyncHandler(async (_req, res) => ok(res, await net.destinationCatalog())),
);

pricingRouter.get(
  '/destinations/:isoCode',
  asyncHandler(async (req, res) => {
    const { isoCode } = parse(z.object({ isoCode: z.string().trim().length(2) }), req.params);
    return ok(res, await net.countryNetworks(isoCode));
  }),
);

/** Server-side quote of a purchase for one or more destination networks: [{ networkId, quantity }]. */
pricingRouter.post(
  '/network-quote',
  asyncHandler(async (req, res) => {
    const { items } = parse(z.object({ items: z.unknown() }).strict(), req.body);
    return ok(res, await net.quoteNetworkPurchase(items));
  }),
);

/** Admin: manage tiers (same permissions as SMS packages). */
export const adminPricingRouter = Router();

adminPricingRouter.get(
  '/tiers',
  requirePlatformPermission('packages.view'),
  asyncHandler(async (req, res) => {
    // list: "general" = general credits, a network id = that network's prices; omitted = every tier.
    const { list } = parse(z.object({ list: z.union([z.literal('general'), z.string().uuid()]).optional() }), req.query);
    const tiers = await prisma.smsPricingTier.findMany({
      where: list === undefined ? {} : { networkId: list === 'general' ? null : list },
      orderBy: [{ networkId: 'asc' }, { isActive: 'desc' }, { minQuantity: 'asc' }],
      include: { _count: { select: { payments: true, paymentItems: true } }, network: { select: { name: true, countryCode: true } } },
    });
    return ok(res, tiers.map((t) => ({ ...svc.serializeTier(t), purchaseCount: t._count.payments + t._count.paymentItems })));
  }),
);

/** Every destination network as customers see it (availability, prices), plus usable provider capacity for staff who may see it. */
adminPricingRouter.get(
  '/networks',
  requirePlatformPermission('packages.view'),
  asyncHandler(async (req, res) => {
    const rows = await net.networkCommerceOverview();
    const showStock = req.user!.platformPermissions.has('providers.view');
    return ok(res, rows.map(({ usableProviderCapacity, ...r }) => ({ ...r, usableProviderCapacity: showStock ? usableProviderCapacity : null })));
  }),
);

/** Pricing configuration of every price list (general credits, each network × direction). */
adminPricingRouter.get(
  '/lists',
  requirePlatformPermission('packages.view'),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.smsPriceList.findMany({ include: { network: { select: { name: true, countryCode: true } }, _count: { select: { paymentItems: true } } }, orderBy: { createdAt: 'asc' } });
    return ok(
      res,
      rows.map((r) => ({ ...lists.serializeRule(r), scopeKey: r.scopeKey, networkId: r.networkId, network: r.network, service: r.service, direction: r.direction, purchaseCount: r._count.paymentItems, updatedAt: r.updatedAt })),
    );
  }),
);

/** The configuration of one price list (defaults when none was saved yet). */
adminPricingRouter.get(
  '/lists/current',
  requirePlatformPermission('packages.view'),
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ networkId: z.string().uuid().optional(), direction: z.enum(['OUTBOUND', 'INBOUND']).default('OUTBOUND') }), req.query);
    const rule = await lists.ruleFor(prisma, q.networkId ?? null, q.direction);
    return ok(res, { ...lists.serializeRule(rule), networkId: q.networkId ?? null, direction: q.direction, metricText: lists.METRIC_TEXT[rule.pricingMetric], rateText: lists.RATE_TEXT[rule.rateApplication] });
  }),
);

adminPricingRouter.put(
  '/lists',
  requirePlatformPermission('packages.manage'),
  asyncHandler(async (req, res) => {
    const body = parse(lists.priceListBody, req.body);
    return ok(res, lists.serializeRule(await lists.upsertPriceList(body, actorFromRequest(req), metaFromRequest(req))), 'Pricing configuration saved');
  }),
);

/** Audit trail of price changes (tiers and configurations), newest first; optionally for one network's price list. */
adminPricingRouter.get(
  '/history',
  requirePlatformPermission('packages.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ networkId: z.union([z.literal('general'), z.string().uuid()]).optional() }), req.query);
    let ids: string[] | undefined;
    if (q.networkId) {
      const networkId = q.networkId === 'general' ? null : q.networkId;
      const [tiers, listRows] = await Promise.all([prisma.smsPricingTier.findMany({ where: { networkId }, select: { id: true } }), prisma.smsPriceList.findMany({ where: { networkId }, select: { id: true } })]);
      // Ladder changes are recorded against the network id (or "general").
      ids = [...tiers, ...listRows].map((r) => r.id).concat(q.networkId);
    }
    const where = { resource: { in: ['sms_pricing_tier', 'sms_price_list'] }, ...(ids ? { resourceId: { in: ids } } : {}) };
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { actor: { select: { fullName: true, email: true } } } }),
      prisma.auditLog.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

/** Provider stock, cost and consumption per destination network (default period: last 30 days). */
adminPricingRouter.get(
  '/networks/inventory',
  requirePlatformPermission('providers.view'),
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000);
    const rows = await net.networkInventory(from, to);
    // Costs follow the same rule as the finance pages.
    const showCost = req.user!.platformPermissions.has('profit.view') || req.user!.platformPermissions.has('finance.view');
    return ok(res, {
      from,
      to,
      networks: showCost
        ? rows
        : rows.map((r) => ({ ...r, providers: r.providers.map((p) => ({ ...p, averageRemainingCost: null, currentQuotedCost: null, consumed: { ...p.consumed, providerCost: null } })) })),
    });
  }),
);

/** Staff preview of a network purchase quote (same engine as customers). */
adminPricingRouter.post(
  '/network-quote',
  requirePlatformPermission('packages.view'),
  asyncHandler(async (req, res) => {
    const { items } = parse(z.object({ items: z.unknown() }).strict(), req.body);
    return ok(res, await net.quoteNetworkPurchase(items));
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

/** Replace a price list's prices with a simple ladder ("from N SMS → price"). */
adminPricingRouter.put(
  '/ladder',
  requirePlatformPermission('packages.manage'),
  asyncHandler(async (req, res) => {
    const body = parse(svc.ladderBody, req.body);
    return ok(res, (await svc.setPriceLadder(body, actorFromRequest(req), metaFromRequest(req))).map((t) => svc.serializeTier(t)), 'Prices saved');
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
