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
import { adjustCapacity, purchaseCapacity, serializeProvider } from './provider.service';

export const adminProvidersRouter = Router();

const serializePurchase = (p: Prisma.ProviderPurchaseGetPayload<{ include: { provider: { select: { code: true; name: true } } } }>) => ({
  ...p,
  unitCost: p.unitCost.toFixed(4),
  totalCost: p.totalCost.toFixed(2),
});

adminProvidersRouter.get(
  '/',
  requirePlatformPermission('providers.view'),
  asyncHandler(async (_req, res) => {
    const providers = await prisma.smsProvider.findMany({ orderBy: [{ priority: 'asc' }, { name: 'asc' }] });
    const last = await prisma.providerPurchase.groupBy({ by: ['providerId'], _max: { createdAt: true } });
    return ok(
      res,
      providers.map((p) => ({ ...serializeProvider(p), lastPurchaseAt: last.find((l) => l.providerId === p.id)?._max.createdAt ?? null })),
    );
  }),
);

/** All capacity purchases across providers. */
adminProvidersRouter.get(
  '/purchases',
  requirePlatformPermission('provider_purchases.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ providerId: z.string().uuid().optional(), status: z.enum(['PENDING', 'SUCCESS', 'FAILED']).optional() }), req.query);
    const where: Prisma.ProviderPurchaseWhereInput = { ...(q.providerId ? { providerId: q.providerId } : {}), ...(q.status ? { status: q.status } : {}) };
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
    return ok(res, {
      ...serializeProvider(p),
      network: adapter?.network ?? null,
      reportedBalance: reported,
      reportedBalanceError: reportedError,
      // Positive = provider reports more than our ledger (e.g. messages still in flight on their side).
      reconciliationDifference: reported?.available != null ? reported.available - p.capacityBalance : null,
      traffic24h: traffic.map((t) => ({ status: t.status, count: t._count })),
    });
  }),
);

const providerConfig = z.object({
  name: z.string().trim().min(2).max(80),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
  mode: z.enum(['SIMULATION', 'PRODUCTION']),
  currency: z.string().trim().length(3).toUpperCase(),
  costPerSms: z.string().regex(/^\d{1,8}(\.\d{1,4})?$/, 'Decimal with up to 4 places'),
  routePrefixes: z.array(z.string().trim().regex(/^\+\d{1,8}$/, 'Prefixes look like +25078')).max(50),
  priority: z.coerce.number().int().min(0).max(1000),
  allowOverdraft: z.boolean(),
  overdraftLimit: z.coerce.number().int().min(0).max(10_000_000),
  lowCapacityThreshold: z.coerce.number().int().min(0).max(100_000_000),
  notes: z.string().trim().max(1000).nullable(),
});

adminProvidersRouter.patch(
  '/:id',
  requirePlatformPermission('providers.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(providerConfig.partial(), req.body);
    const before = await prisma.smsProvider.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Provider');
    if (body.allowOverdraft === false || (body.overdraftLimit !== undefined && body.overdraftLimit < before.overdraftLimit)) {
      const floor = (body.allowOverdraft ?? before.allowOverdraft) ? -(body.overdraftLimit ?? before.overdraftLimit) : 0;
      if (before.capacityBalance < floor) throw AppError.conflict('Current capacity is below the new overdraft floor — buy capacity first', 'CAPACITY_BELOW_FLOOR');
    }
    const updated = await prisma.smsProvider.update({ where: { id }, data: { ...body, costPerSms: body.costPerSms ? new Prisma.Decimal(body.costPerSms) : undefined } });
    await audit({
      actor: actorFromRequest(req),
      action: body.costPerSms && !new Prisma.Decimal(body.costPerSms).equals(before.costPerSms) ? 'PROVIDER_PRICING_CHANGED' : 'PROVIDER_UPDATED',
      resource: 'sms_provider',
      resourceId: id,
      metadata: { changes: body, previousCostPerSms: before.costPerSms.toFixed(4) },
      meta: metaFromRequest(req),
    });
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
      }),
      req.body,
    );
    return ok(res, await adjustCapacity(id, body, actorFromRequest(req), metaFromRequest(req)), 'Capacity adjusted');
  }),
);
