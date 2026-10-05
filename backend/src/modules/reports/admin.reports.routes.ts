import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { asyncHandler, ok, parse } from '../../utils/http';
import { getSetting } from '../settings/settings.service';
import * as r from './report.service';

export const adminReportsRouter = Router();

async function revenue(from: Date, to: Date) {
  const agg = await prisma.payment.aggregate({ where: { status: 'SUCCESS', verifiedAt: { gte: from, lte: to } }, _sum: { amount: true, credits: true }, _count: true });
  return { amount: (agg._sum.amount ?? new Prisma.Decimal(0)).toFixed(2), creditsSold: agg._sum.credits ?? 0, payments: agg._count };
}

adminReportsRouter.get(
  '/dashboard',
  requirePlatformPermission('dashboard.view'),
  asyncHandler(async (_req, res) => {
    const today = r.resolveRange({ range: 'today' });
    const d30 = r.resolveRange({ range: '30d' });
    const [orgs, pendingVerification, pendingSenders, pendingPayments, smsToday, rev30, series, growth, statusDist] = await Promise.all([
      prisma.organization.groupBy({ by: ['status'], _count: true }),
      prisma.verification.count({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } }),
      prisma.senderId.count({ where: { status: { in: ['PENDING', 'UNDER_REVIEW'] } } }),
      prisma.payment.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
      r.smsTotals(today.from, today.to),
      revenue(d30.from, d30.to),
      r.smsTimeseries(d30.from, d30.to, 'day'),
      r.customerGrowth(d30.from, d30.to, 'day'),
      r.smsTotals(d30.from, d30.to),
    ]);
    const revenueSeries = await r.revenueTimeseries(d30.from, d30.to, 'day');
    const count = (s: string) => orgs.find((o) => o.status === s)?._count ?? 0;
    return ok(res, {
      currency: await getSetting('billing.currency'),
      organizations: { total: orgs.reduce((a, o) => a + o._count, 0), active: count('ACTIVE'), suspended: count('SUSPENDED'), pendingReview: count('PENDING_REVIEW') },
      pendingVerification,
      pendingSenders,
      pendingPayments,
      smsToday,
      revenue30d: rev30,
      series,
      revenueSeries,
      growth,
      deliveryStatus30d: statusDist,
    });
  }),
);

adminReportsRouter.get(
  '/overview',
  requirePlatformPermission('reports.view'),
  asyncHandler(async (req, res) => {
    const q = parse(r.rangeQuery, req.query);
    const { from, to, unit } = r.resolveRange(q);
    const [totals, series, rev, revenueSeries, growth, top, providers, customers, activeCustomers, credits] = await Promise.all([
      r.smsTotals(from, to),
      r.smsTimeseries(from, to, unit),
      revenue(from, to),
      r.revenueTimeseries(from, to, unit),
      r.customerGrowth(from, to, unit),
      r.topOrganizations(from, to, 10),
      r.providerPerformance(from, to),
      prisma.organization.count(),
      prisma.organization.count({ where: { status: 'ACTIVE' } }),
      r.creditsConsumed(from, to),
    ]);
    return ok(res, {
      range: { from, to, unit, timezone: r.DEFAULT_TZ },
      currency: await getSetting('billing.currency'),
      customers: { total: customers, active: activeCustomers },
      sms: { ...totals, creditsConsumed: credits },
      revenue: rev,
      series,
      revenueSeries,
      growth,
      topOrganizations: top,
      providers,
    });
  }),
);
