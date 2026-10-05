import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { SmsProviderFactory } from '../../integrations/sms/SmsProviderFactory';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { audit } from '../audit-logs/audit.service';
import { rangeQuery, resolveRange } from '../reports/report.service';
import { adjustCapacity, purchaseCapacity, serializeProvider } from './provider.service';
import { createProvider, listProviders, providerCreateBody, providerDetail, providersOverview, providerUpdateBody, updateProvider } from './providerAdmin.service';

export const adminProvidersRouter = Router();

const serializePurchase = (p: Prisma.ProviderPurchaseGetPayload<{ include: { provider: { select: { code: true; name: true } } } }>) => ({
  ...p,
  unitCost: p.unitCost.toFixed(4),
  totalCost: p.totalCost.toFixed(2),
});

adminProvidersRouter.get(
  '/',
  requirePlatformPermission('providers.view'),
  asyncHandler(async (_req, res) => ok(res, await listProviders())),
);

/** Supply-side overview: capacity, cost and gross SMS margin for the period. */
adminProvidersRouter.get(
  '/overview',
  requirePlatformPermission('providers.view'),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveRange(parse(rangeQuery, req.query));
    const overview = await providersOverview(from, to);
    // Margin figures need profit.view, like the finance pages.
    if (!req.user!.platformPermissions.has('profit.view')) overview.economics = { ...overview.economics, grossMargin: null, marginPercent: null };
    return ok(res, overview);
  }),
);

/** All capacity purchases across providers. */
adminProvidersRouter.get(
  '/purchases',
  requirePlatformPermission('provider_purchases.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({ providerId: z.string().uuid().optional(), status: z.enum(['PENDING', 'SUCCESS', 'FAILED']).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
      req.query,
    );
    const where: Prisma.ProviderPurchaseWhereInput = {
      ...(q.providerId ? { providerId: q.providerId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.providerPurchase.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { provider: { select: { code: true, name: true } } } }),
      prisma.providerPurchase.count({ where }),
    ]);
    return paginated(res, items.map(serializePurchase), q.page, q.limit, total);
  }),
);

/** Capacity ledger (provider wallets) across providers. */
adminProvidersRouter.get(
  '/ledger',
  requirePlatformPermission('providers.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ providerId: z.string().uuid().optional(), type: z.enum(['PURCHASE', 'USAGE', 'RELEASE', 'ADJUSTMENT']).optional() }), req.query);
    const where: Prisma.ProviderCapacityLedgerWhereInput = { ...(q.providerId ? { providerId: q.providerId } : {}), ...(q.type ? { type: q.type } : {}) };
    const [items, total] = await Promise.all([
      prisma.providerCapacityLedger.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { provider: { select: { code: true, name: true } } } }),
      prisma.providerCapacityLedger.count({ where }),
    ]);
    return paginated(res, items.map((e) => ({ ...e, unitCost: e.unitCost?.toFixed(4) ?? null })), q.page, q.limit, total);
  }),
);

adminProvidersRouter.get(
  '/:id',
  requirePlatformPermission('providers.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const p = await prisma.smsProvider.findUnique({ where: { id } });
    if (!p) throw AppError.notFound('Provider');
    const adapter = SmsProviderFactory.forProvider(p);
    let reported: { available: number | null; currency: string; checkedAt: Date } | null = null;
    let reportedError: string | null = null;
    if (adapter) {
      try {
        reported = await adapter.getBalance();
      } catch (err) {
        reportedError = (err as Error).message;
      }
    }
    const since = new Date(Date.now() - 86_400_000);
    const traffic = await prisma.smsRecipient.groupBy({ by: ['status'], where: { providerId: id, createdAt: { gte: since } }, _count: true });
    const { from, to } = resolveRange(parse(rangeQuery, req.query));
    const detail = await providerDetail(id, from, to);
    if (!req.user!.platformPermissions.has('profit.view')) detail.economics = { ...detail.economics, grossMargin: null, marginPercent: null };
    return ok(res, {
      ...detail,
      network: adapter?.network ?? null,
      reportedBalance: reported,
      reportedBalanceError: reportedError,
      // Positive = provider reports more than our ledger (e.g. messages still in flight on their side).
      reconciliationDifference: reported?.available != null ? reported.available - p.capacityBalance : null,
      traffic24h: traffic.map((t) => ({ status: t.status, count: t._count })),
    });
  }),
);

/** Register a new provider account. It only receives traffic once ACTIVE, healthy and its adapter is installed. */
adminProvidersRouter.post(
  '/',
  requirePlatformPermission('providers.manage'),
  asyncHandler(async (req, res) => {
    const body = parse(providerCreateBody, req.body);
    const p = await createProvider(body, actorFromRequest(req), metaFromRequest(req));
    return created(res, serializeProvider(p), 'Provider created');
  }),
);

/** Edit configuration: cost, priority, health, capacity reserve, destinations… (audited field by field). */
adminProvidersRouter.patch(
  '/:id',
  requirePlatformPermission('providers.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(providerUpdateBody, req.body);
    const updated = await updateProvider(id, body, actorFromRequest(req), metaFromRequest(req));
    return ok(res, serializeProvider(updated), 'Provider updated');
  }),
);

adminProvidersRouter.post(
  '/:id/purchase',
  requirePlatformPermission('provider_purchases.create'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        quantity: z.coerce.number().int().min(100, 'Minimum order is 100 SMS').max(10_000_000),
        unitCost: z.string().regex(/^\d{1,8}(\.\d{1,4})?$/).optional(),
        notes: z.string().trim().max(500).optional(),
      }),
      req.body,
    );
    const purchase = await purchaseCapacity(id, body, actorFromRequest(req), metaFromRequest(req));
    if (purchase.status === 'FAILED') throw AppError.unprocessable(`Provider declined the order: ${purchase.failureReason}`, 'PROVIDER_PURCHASE_FAILED');
    const full = await prisma.providerPurchase.findUniqueOrThrow({ where: { id: purchase.id }, include: { provider: { select: { code: true, name: true } } } });
    return created(res, serializePurchase(full), `Purchased ${body.quantity.toLocaleString()} SMS (${purchase.reference})`);
  }),
);

adminProvidersRouter.post(
  '/:id/adjust',
  requirePlatformPermission('providers.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        amount: z.coerce.number().int().refine((v) => v !== 0, 'Amount cannot be zero'),
        reason: z.string().trim().min(5).max(500),
        reference: z.string().trim().min(3).max(100).regex(/^[\w\-./#]+$/),
        unitCost: z.string().trim().regex(/^\d{1,8}(\.\d{1,4})?$/).optional(),
      }),
      req.body,
    );
    return ok(res, await adjustCapacity(id, body, actorFromRequest(req), metaFromRequest(req)), 'Capacity adjusted');
  }),
);
