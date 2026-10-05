import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { audit } from '../audit-logs/audit.service';
import { rangeQuery, resolveRange } from '../reports/report.service';
import { getSetting } from '../settings/settings.service';
import { customerReport, financialSeries, financialSummary, financialTables, providerBreakdown } from './finance.service';

export const adminFinanceRouter = Router();

async function earliestActivity() {
  const [p, pp] = await Promise.all([prisma.payment.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }), prisma.providerPurchase.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } })]);
  const dates = [p?.createdAt, pp?.createdAt].filter(Boolean) as Date[];
  return dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : new Date(Date.now() - 30 * 86_400_000);
}

/** Business overview: revenue, costs, margin, profit, SMS inventory — with the formula. */
adminFinanceRouter.get(
  '/overview',
  requirePlatformPermission('finance.view'),
  asyncHandler(async (req, res) => {
    const q = parse(rangeQuery, req.query);
    const { from, to, unit } = resolveRange(q, undefined, await earliestActivity());
    const [summary, series, providers, tables] = await Promise.all([financialSummary(from, to), financialSeries(from, to, unit), providerBreakdown(from, to), financialTables(from, to)]);
    // Profit figures need profit.view; everyone with finance.view sees revenue/costs.
    const canProfit = req.user!.platformPermissions.has('profit.view');
    if (!canProfit) {
      summary.money.grossMargin = null as unknown as string;
      summary.money.netProfit = null as unknown as string;
      summary.money.netMarginPercent = null;
      summary.unitEconomics.salesContribution = null as unknown as string;
    }
    return ok(res, {
      range: { from, to, unit, range: q.range },
      ...summary,
      canViewProfit: canProfit,
      series: canProfit ? series : series.map((s) => ({ ...s, profit: null })),
      providers,
      ...tables,
    });
  }),
);

/** Per-customer purchases, usage, balance, provider cost and gross margin for the period. */
adminFinanceRouter.get(
  '/customers',
  requirePlatformPermission('finance.view'),
  asyncHandler(async (req, res) => {
    const q = parse(rangeQuery.extend({ search: z.string().trim().max(100).optional() }), req.query);
    const { from, to } = resolveRange(q, undefined, await earliestActivity());
    const canProfit = req.user!.platformPermissions.has('profit.view');
    let rows = await customerReport(from, to);
    if (q.search) rows = rows.filter((r) => r.organization.name.toLowerCase().includes(q.search!.toLowerCase()));
    return ok(res, { range: { from, to, range: q.range }, canViewProfit: canProfit, customers: rows.map((r) => (canProfit ? r : { ...r, grossMargin: null })) });
  }),
);

adminFinanceRouter.get(
  '/sales',
  requirePlatformPermission('finance.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ organizationId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
    const where: Prisma.CustomerPurchaseWhereInput = {
      ...(q.organizationId ? { organizationId: q.organizationId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [items, total, sums] = await Promise.all([
      prisma.customerPurchase.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { organization: { select: { id: true, name: true } }, payment: { select: { reference: true, method: true, status: true } } } }),
      prisma.customerPurchase.count({ where }),
      prisma.customerPurchase.aggregate({ where, _sum: { revenue: true, credits: true, estimatedProviderCost: true, paymentFee: true, contribution: true } }),
    ]);
    res.json({
      success: true,
      data: items.map((s) => ({ ...s, revenue: s.revenue.toFixed(2), estimatedProviderCost: s.estimatedProviderCost.toFixed(2), paymentFee: s.paymentFee.toFixed(2), contribution: s.contribution.toFixed(2) })),
      pagination: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
      totals: {
        credits: sums._sum.credits ?? 0,
        revenue: (sums._sum.revenue ?? new Prisma.Decimal(0)).toFixed(2),
        estimatedProviderCost: (sums._sum.estimatedProviderCost ?? new Prisma.Decimal(0)).toFixed(2),
        paymentFees: (sums._sum.paymentFee ?? new Prisma.Decimal(0)).toFixed(2),
        contribution: (sums._sum.contribution ?? new Prisma.Decimal(0)).toFixed(2),
      },
    });
  }),
);

adminFinanceRouter.get(
  '/refunds',
  requirePlatformPermission('finance.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema, req.query);
    const [items, total] = await Promise.all([
      prisma.refund.findMany({ orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { organization: { select: { id: true, name: true } }, payment: { select: { reference: true } } } }),
      prisma.refund.count(),
    ]);
    return paginated(res, items.map((r) => ({ ...r, amount: r.amount.toFixed(2) })), q.page, q.limit, total);
  }),
);

// ── Expenses ─────────────────────────────────────────────────────────────

const CATEGORIES = ['INFRASTRUCTURE', 'SOFTWARE', 'PERSONNEL', 'MARKETING', 'REGULATORY', 'PAYMENT_PROCESSING', 'OTHER'] as const;
const expenseBody = z.object({
  category: z.enum(CATEGORIES),
  description: z.string().trim().min(3).max(300),
  vendor: z.string().trim().max(120).optional().nullable(),
  reference: z.string().trim().max(100).optional().nullable(),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Amount must be a decimal, e.g. 25000 or 25000.50'),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  incurredAt: z.coerce.date(),
});
const serializeExpense = (e: Prisma.ExpenseGetPayload<object>) => ({ ...e, amount: e.amount.toFixed(2) });

adminFinanceRouter.get(
  '/expenses',
  requirePlatformPermission('expenses.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ category: z.enum(CATEGORIES).optional() }), req.query);
    const where: Prisma.ExpenseWhereInput = { deletedAt: null, ...(q.category ? { category: q.category } : {}) };
    const [items, total, sum] = await Promise.all([
      prisma.expense.findMany({ where, orderBy: { incurredAt: 'desc' }, ...toSkipTake(q) }),
      prisma.expense.count({ where }),
      prisma.expense.aggregate({ where, _sum: { amount: true } }),
    ]);
    res.json({
      success: true,
      data: items.map(serializeExpense),
      pagination: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
      total: (sum._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
    });
  }),
);

adminFinanceRouter.post(
  '/expenses',
  requirePlatformPermission('expenses.manage'),
  asyncHandler(async (req, res) => {
    const body = parse(expenseBody, req.body);
    const e = await prisma.expense.create({ data: { ...body, amount: new Prisma.Decimal(body.amount), currency: body.currency ?? (await getSetting('billing.currency')), createdById: req.user!.id } });
    await audit({ actor: actorFromRequest(req), action: 'EXPENSE_RECORDED', resource: 'expense', resourceId: e.id, metadata: { category: e.category, amount: e.amount.toFixed(2) }, meta: metaFromRequest(req) });
    return created(res, serializeExpense(e), 'Expense recorded');
  }),
);

adminFinanceRouter.patch(
  '/expenses/:id',
  requirePlatformPermission('expenses.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(expenseBody.partial(), req.body);
    const before = await prisma.expense.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw AppError.notFound('Expense');
    const e = await prisma.expense.update({ where: { id }, data: { ...body, amount: body.amount ? new Prisma.Decimal(body.amount) : undefined } });
    await audit({ actor: actorFromRequest(req), action: 'EXPENSE_UPDATED', resource: 'expense', resourceId: id, metadata: { changes: body, previousAmount: before.amount.toFixed(2) }, meta: metaFromRequest(req) });
    return ok(res, serializeExpense(e), 'Expense updated');
  }),
);

/** Soft delete keeps the record for audit; it is excluded from all reports. */
adminFinanceRouter.delete(
  '/expenses/:id',
  requirePlatformPermission('expenses.manage'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const r = await prisma.expense.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
    if (r.count === 0) throw AppError.notFound('Expense');
    await audit({ actor: actorFromRequest(req), action: 'EXPENSE_DELETED', resource: 'expense', resourceId: id, meta: metaFromRequest(req) });
    return ok(res, null, 'Expense removed');
  }),
);
