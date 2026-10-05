import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requireOrgPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { asyncHandler, ok, paginated, paginationSchema, parse, toSkipTake } from '../../utils/http';
import { getWallet, updateLowBalanceThreshold } from './wallet.service';

export const walletRouter = Router();

const EXPIRING_SOON_DAYS = 30;

walletRouter.get(
  '/',
  requireOrgPermission('wallet.view'),
  asyncHandler(async (req, res) => {
    const wallet = await getWallet(req.org!.id);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const soon = new Date(Date.now() + EXPIRING_SOON_DAYS * 86_400_000);
    const [purchased, used, expiring, nextLot] = await Promise.all([
      prisma.walletTransaction.aggregate({ where: { organizationId: req.org!.id, type: 'PURCHASE', createdAt: { gte: monthStart } }, _sum: { amount: true } }),
      prisma.walletTransaction.aggregate({ where: { organizationId: req.org!.id, type: { in: ['SMS_DEBIT', 'REFUND'] }, createdAt: { gte: monthStart } }, _sum: { amount: true } }),
      prisma.smsCreditLot.aggregate({ where: { walletId: wallet.id, remaining: { gt: 0 }, expiresAt: { not: null, lte: soon } }, _sum: { remaining: true } }),
      prisma.smsCreditLot.findFirst({ where: { walletId: wallet.id, remaining: { gt: 0 }, expiresAt: { not: null } }, orderBy: { expiresAt: 'asc' }, select: { expiresAt: true, remaining: true } }),
    ]);
    return ok(res, {
      balance: wallet.balance,
      lowBalanceThreshold: wallet.lowBalanceThreshold,
      isLow: wallet.balance < wallet.lowBalanceThreshold,
      thisMonth: { purchased: purchased._sum.amount ?? 0, consumed: -(used._sum.amount ?? 0) },
      expiringSoon: { credits: expiring._sum.remaining ?? 0, withinDays: EXPIRING_SOON_DAYS, nextExpiry: nextLot ? { at: nextLot.expiresAt, credits: nextLot.remaining } : null },
      updatedAt: wallet.updatedAt,
    });
  }),
);

walletRouter.get(
  '/transactions',
  requireOrgPermission('wallet.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        type: z.enum(['PURCHASE', 'SMS_DEBIT', 'REFUND', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'ADJUSTMENT', 'EXPIRATION']).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      }),
      req.query,
    );
    const where: Prisma.WalletTransactionWhereInput = {
      organizationId: req.org!.id,
      ...(q.type ? { type: q.type } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.walletTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { createdBy: { select: { fullName: true } } } }),
      prisma.walletTransaction.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

walletRouter.patch(
  '/settings',
  requireOrgPermission('settings.update'),
  asyncHandler(async (req, res) => {
    const { lowBalanceThreshold } = parse(z.object({ lowBalanceThreshold: z.coerce.number().int().min(0).max(10_000_000) }), req.body);
    const w = await updateLowBalanceThreshold(req.org!.id, lowBalanceThreshold, actorFromRequest(req), metaFromRequest(req));
    return ok(res, { lowBalanceThreshold: w.lowBalanceThreshold }, 'Low balance alert updated');
  }),
);

/** Credit lots that still hold credits, soonest expiry first. */
walletRouter.get(
  '/lots',
  requireOrgPermission('wallet.view'),
  asyncHandler(async (req, res) => {
    const wallet = await getWallet(req.org!.id);
    const lots = await prisma.smsCreditLot.findMany({
      where: { walletId: wallet.id, remaining: { gt: 0 } },
      select: { id: true, sourceType: true, credits: true, remaining: true, expiresAt: true, createdAt: true },
    });
    lots.sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) || a.createdAt.getTime() - b.createdAt.getTime());
    return ok(res, lots);
  }),
);
