import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { audit } from '../audit-logs/audit.service';
import { getSetting } from '../settings/settings.service';
import { adminAdjust } from '../wallet/wallet.service';
import { serializeInvoice } from './payment.routes';
import { streamInvoicePdf } from '../invoices/invoicePdf';
import { refundPayment, serializePayment, verifyAndApply } from './payment.service';

export const adminBillingRouter = Router();

// ── Payments ────────────────────────────────────────────────────────────

adminBillingRouter.get(
  '/payments',
  requirePlatformPermission('payments.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        status: z.enum(['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED']).optional(),
        organizationId: z.string().uuid().optional(),
        search: z.string().trim().max(60).optional(),
      }),
      req.query,
    );
    const where: Prisma.PaymentWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.organizationId ? { organizationId: q.organizationId } : {}),
      ...(q.search ? { OR: [{ reference: { contains: q.search } }, { providerReference: { contains: q.search } }] } : {}),
    };
    const [items, total, summary] = await Promise.all([
      prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { invoice: { select: { id: true, number: true } }, organization: { select: { id: true, name: true } } } }),
      prisma.payment.count({ where }),
      prisma.payment.groupBy({ by: ['status'], where: q.organizationId ? { organizationId: q.organizationId } : {}, _count: true, _sum: { amount: true } }),
    ]);
    res.json({
      success: true,
      data: items.map((p) => ({ ...serializePayment(p), organization: p.organization })),
      pagination: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
      summary: summary.map((s) => ({ status: s.status, count: s._count, amount: (s._sum.amount ?? new Prisma.Decimal(0)).toFixed(2) })),
    });
  }),
);

adminBillingRouter.post(
  '/payments/:id/verify',
  requirePlatformPermission('payments.verify'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const p = await verifyAndApply(id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, serializePayment(p), `Payment status: ${p.status}`);
  }),
);

adminBillingRouter.post(
  '/payments/:id/refund',
  requirePlatformPermission('payments.refund'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    await refundPayment(id, reason, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Refund recorded and credits reversed');
  }),
);

adminBillingRouter.get(
  '/invoices',
  requirePlatformPermission('invoices.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ organizationId: z.string().uuid().optional() }), req.query);
    const where = q.organizationId ? { organizationId: q.organizationId } : {};
    const [items, total] = await Promise.all([
      prisma.invoice.findMany({ where, orderBy: { issuedAt: 'desc' }, ...toSkipTake(q), include: { payment: true } }),
      prisma.invoice.count({ where }),
    ]);
    return paginated(res, items.map(serializeInvoice), q.page, q.limit, total);
  }),
);

adminBillingRouter.get(
  '/invoices/:id/pdf',
  requirePlatformPermission('invoices.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const inv = await prisma.invoice.findUnique({ where: { id }, include: { payment: true } });
    if (!inv) throw AppError.notFound('Invoice');
    streamInvoicePdf(res, serializeInvoice(inv) as unknown as Parameters<typeof streamInvoicePdf>[1], {
      name: await getSetting('billing.companyName'),
      address: await getSetting('billing.companyAddress'),
    });
  }),
);

adminBillingRouter.get(
  '/invoices/:id',
  requirePlatformPermission('invoices.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const inv = await prisma.invoice.findUnique({ where: { id }, include: { payment: true } });
    if (!inv) throw AppError.notFound('Invoice');
    return ok(res, { ...serializeInvoice(inv), issuer: { name: await getSetting('billing.companyName'), address: await getSetting('billing.companyAddress') } });
  }),
);

// ── Wallets & ledger ────────────────────────────────────────────────────

adminBillingRouter.get(
  '/wallets',
  requirePlatformPermission('wallet.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ search: z.string().trim().max(100).optional() }), req.query);
    const where: Prisma.WalletWhereInput = q.search ? { organization: { name: { contains: q.search } } } : {};
    const [items, total] = await Promise.all([
      prisma.wallet.findMany({ where, orderBy: { balance: 'desc' }, ...toSkipTake(q), include: { organization: { select: { id: true, name: true, status: true } } } }),
      prisma.wallet.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

adminBillingRouter.get(
  '/wallet-transactions',
  requirePlatformPermission('wallet.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        organizationId: z.string().uuid().optional(),
        type: z.enum(['PURCHASE', 'SMS_DEBIT', 'REFUND', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'ADJUSTMENT', 'EXPIRATION']).optional(),
      }),
      req.query,
    );
    const where: Prisma.WalletTransactionWhereInput = { ...(q.organizationId ? { organizationId: q.organizationId } : {}), ...(q.type ? { type: q.type } : {}) };
    const [items, total] = await Promise.all([
      prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(q),
        include: { organization: { select: { id: true, name: true } }, createdBy: { select: { fullName: true } } },
      }),
      prisma.walletTransaction.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

adminBillingRouter.post(
  '/wallets/:organizationId/adjust',
  asyncHandler(async (req, res, next) => {
    const { organizationId } = parse(z.object({ organizationId: z.string().uuid() }), req.params);
    const body = parse(
      z.object({
        kind: z.enum(['CREDIT', 'DEBIT', 'REFUND']),
        amount: z.coerce.number().int().min(1).max(100_000_000),
        reason: z.string().trim().min(5, 'Explain the adjustment (min 5 characters)').max(500),
        reference: z.string().trim().min(3).max(100).regex(/^[\w\-./#]+$/, 'Use letters, digits and - _ . / #'),
      }),
      req.body,
    );
    const needed = body.kind === 'REFUND' ? 'wallet.refund' : 'wallet.adjust';
    if (!req.user!.platformPermissions.has(needed)) return next(AppError.forbidden(undefined, 'PERMISSION_DENIED'));
    const tx = await adminAdjust({ organizationId, ...body }, actorFromRequest(req), metaFromRequest(req));
    return ok(res, tx, 'Wallet adjusted');
  }),
);
