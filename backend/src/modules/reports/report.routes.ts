import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { getSetting } from '../settings/settings.service';
import { requireOrgPermission } from '../../middlewares/rbac';
import { asyncHandler, ok, parse } from '../../utils/http';
import * as r from './report.service';

export const reportRouter = Router();

reportRouter.get(
  '/overview',
  requireOrgPermission('reports.view'),
  asyncHandler(async (req, res) => {
    const q = parse(r.rangeQuery, req.query);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.org!.id }, select: { timezone: true } });
    const tz = org.timezone || r.DEFAULT_TZ;
    const { from, to, unit } = r.resolveRange(q, tz);
    const orgId = req.org!.id;
    const [purchases, spending, wallet, topCampaigns, spendSeries] = await Promise.all([
      prisma.customerPurchase.aggregate({ where: { organizationId: orgId, createdAt: { gte: from, lte: to } }, _sum: { credits: true } }),
      prisma.payment.aggregate({ where: { organizationId: orgId, status: { in: ['SUCCESS', 'REFUNDED'] }, verifiedAt: { gte: from, lte: to } }, _sum: { amount: true } }),
      prisma.wallet.findUnique({ where: { organizationId: orgId } }),
      prisma.campaign.findMany({ where: { organizationId: orgId, launchedAt: { gte: from, lte: to } }, orderBy: { launchedAt: 'desc' }, take: 8, select: { id: true, name: true, status: true } }),
      prisma.$queryRaw<{ label: string; amount: string | null }[]>`
        WITH ${r.bucketsCte(from, to, unit, tz)}
        SELECT to_char(b, ${r.FMT[unit]}) AS label, SUM(p.amount)::text AS amount
        FROM buckets LEFT JOIN payments p ON ${r.localTrunc(Prisma.sql`p."verifiedAt"`, unit, tz)} = b
          AND p."organizationId" = ${orgId}::uuid AND p.status IN ('SUCCESS','REFUNDED') AND p."verifiedAt" >= ${from} AND p."verifiedAt" <= ${to}
        GROUP BY b ORDER BY b`,
    ]);
    const campaignStats = await r.campaignPerformance(topCampaigns.map((c) => c.id));
    const [totals, series, credits, campaigns, bySource] = await Promise.all([
      r.smsTotals(from, to, orgId),
      r.smsTimeseries(from, to, unit, orgId, tz),
      r.creditsConsumed(from, to, orgId),
      prisma.campaign.count({ where: { organizationId: orgId, createdAt: { gte: from, lte: to }, status: { notIn: ['DRAFT'] } } }),
      prisma.smsMessage.groupBy({ by: ['source'], where: { organizationId: orgId, createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } }, _sum: { recipientCount: true } }),
    ]);
    return ok(res, {
      range: { from, to, unit, timezone: tz },
      totals: { ...totals, creditsConsumed: credits, campaigns },
      billing: {
        creditsPurchased: purchases._sum.credits ?? 0,
        creditsUsed: credits,
        remainingBalance: wallet?.balance ?? 0,
        totalSpending: (spending._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
        currency: wallet ? await getSetting('billing.currency') : 'RWF',
      },
      spendingSeries: spendSeries.map((s) => ({ label: s.label, amount: s.amount ?? '0' })),
      campaignPerformance: topCampaigns.map((c) => ({ ...c, ...(campaignStats.get(c.id) ?? { recipients: 0, delivered: 0, failed: 0, pending: 0 }) })),
      bySource: bySource.map((s) => ({ source: s.source, messages: s._sum.recipientCount ?? 0 })),
      series,
    });
  }),
);

/** Compact numbers for the customer dashboard. */
reportRouter.get(
  '/dashboard',
  requireOrgPermission('dashboard.view'),
  asyncHandler(async (req, res) => {
    const orgId = req.org!.id;
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true } });
    const tz = org.timezone || r.DEFAULT_TZ;
    const today = r.resolveRange({ range: 'today' }, tz);
    const month = r.resolveRange({ range: 'month' }, tz);
    const last7 = r.resolveRange({ range: '7d' }, tz);
    const [todayTotals, monthTotals, series, wallet] = await Promise.all([
      r.smsTotals(today.from, today.to, orgId),
      r.smsTotals(month.from, month.to, orgId),
      r.smsTimeseries(last7.from, last7.to, 'day', orgId, tz),
      prisma.wallet.findUnique({ where: { organizationId: orgId } }),
    ]);
    return ok(res, {
      balance: wallet?.balance ?? 0,
      lowBalanceThreshold: wallet?.lowBalanceThreshold ?? 0,
      today: todayTotals,
      month: monthTotals,
      last7Days: series,
    });
  }),
);
