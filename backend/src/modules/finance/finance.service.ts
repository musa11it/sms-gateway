import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { getSetting } from '../settings/settings.service';
import { DEFAULT_TZ, FMT, bucketsCte, creditsConsumed, localTrunc, topOrganizations, type Unit } from '../reports/report.service';

/**
 * Financial model (all figures come from ledgers — never from the frontend):
 *
 *   Customer revenue      = Σ verified customer payments (SUCCESS or later REFUNDED)       [payments]
 *   Provider spend        = Σ successful purchases of SMS capacity from providers           [provider_purchases]
 *   Gross SMS margin      = Customer revenue − Provider spend                                (cash basis)
 *   Refunds               = Σ refunds issued to customers                                   [refunds]
 *   Payment fees          = Σ processing fees reported by the payment provider              [payments.feeAmount]
 *   Other expenses        = Σ recorded operating expenses                                   [expenses]
 *   Net profit            = Gross SMS margin − Refunds − Payment fees − Other expenses
 *
 * Unit economics (accrual view, per sale):
 *   Sale contribution     = revenue − estimated provider cost of the credits − payment fee  [customer_purchases]
 *   Cost of SMS delivered = Σ weighted-average provider cost of messages actually submitted [sms_recipients.providerCost]
 *
 * Amounts are summed in the platform currency (billing.currency); multi-currency FX is not applied.
 */

const ZERO = new Prisma.Decimal(0);
const dec = (v: Prisma.Decimal | null | undefined) => v ?? ZERO;
const money = (v: Prisma.Decimal) => v.toFixed(2);

export async function financialSummary(from: Date, to: Date) {
  const inRange = { gte: from, lte: to };
  const [payments, refunds, purchases, expenses, sales, deliveredCost, providers, wallets] = await Promise.all([
    prisma.payment.aggregate({ where: { status: { in: ['SUCCESS', 'REFUNDED'] }, verifiedAt: inRange }, _sum: { amount: true, feeAmount: true }, _count: true }),
    prisma.refund.aggregate({ where: { createdAt: inRange }, _sum: { amount: true, creditsReversed: true }, _count: true }),
    prisma.providerPurchase.aggregate({ where: { status: 'SUCCESS', completedAt: inRange }, _sum: { totalCost: true, quantity: true }, _count: true }),
    prisma.expense.aggregate({ where: { deletedAt: null, incurredAt: inRange }, _sum: { amount: true }, _count: true }),
    prisma.customerPurchase.aggregate({ where: { createdAt: inRange }, _sum: { revenue: true, estimatedProviderCost: true, paymentFee: true, contribution: true, credits: true }, _count: true }),
    prisma.smsRecipient.aggregate({ where: { createdAt: inRange, refunded: false, status: { in: ['SENT', 'DELIVERED', 'FAILED', 'EXPIRED'] } }, _sum: { providerCost: true } }),
    prisma.smsProvider.aggregate({ _sum: { capacityBalance: true } }),
    prisma.wallet.aggregate({ _sum: { balance: true } }),
  ]);
  const usage = await prisma.providerCapacityLedger.groupBy({ by: ['type'], where: { createdAt: inRange, type: { in: ['USAGE', 'RELEASE'] } }, _sum: { amount: true } });
  const segmentsDelivered = -usage.reduce((a, u) => a + (u._sum.amount ?? 0), 0);

  const revenue = dec(payments._sum.amount);
  const providerSpend = dec(purchases._sum.totalCost);
  const refundTotal = dec(refunds._sum.amount);
  const paymentFees = dec(payments._sum.feeAmount);
  const otherExpenses = dec(expenses._sum.amount);
  const grossMargin = revenue.minus(providerSpend);
  const netProfit = grossMargin.minus(refundTotal).minus(paymentFees).minus(otherExpenses);

  return {
    currency: await getSetting('billing.currency'),
    money: {
      revenue: money(revenue),
      providerSpend: money(providerSpend),
      grossMargin: money(grossMargin),
      refunds: money(refundTotal),
      paymentFees: money(paymentFees),
      otherExpenses: money(otherExpenses),
      netProfit: money(netProfit),
      netMarginPercent: revenue.gt(0) ? netProfit.div(revenue).mul(100).toDecimalPlaces(1).toNumber() : null,
    },
    unitEconomics: {
      salesRevenue: money(dec(sales._sum.revenue)),
      estimatedProviderCostOfSales: money(dec(sales._sum.estimatedProviderCost)),
      paymentFeesOnSales: money(dec(sales._sum.paymentFee)),
      salesContribution: money(dec(sales._sum.contribution)),
      costOfSmsDelivered: money(dec(deliveredCost._sum.providerCost)),
    },
    sms: {
      purchasedFromProviders: purchases._sum.quantity ?? 0,
      soldToCustomers: sales._sum.credits ?? 0,
      refundedCredits: refunds._sum.creditsReversed ?? 0,
      usedByCustomers: await creditsConsumed(from, to),
      segmentsThroughProviders: segmentsDelivered,
      providerCapacityRemaining: providers._sum.capacityBalance ?? 0,
      customerCreditsOutstanding: wallets._sum.balance ?? 0,
    },
    counts: { payments: payments._count, providerPurchases: purchases._count, refunds: refunds._count, expenses: expenses._count, sales: sales._count },
    formula: {
      grossMargin: 'Customer revenue − Provider spend',
      netProfit: 'Gross SMS margin − Refunds − Payment fees − Other expenses',
      saleContribution: 'Sale revenue − Estimated provider cost of credits − Payment fee',
      costBasis: 'Provider cost uses the weighted-average cost of purchased capacity',
    },
  };
}

export async function financialSeries(from: Date, to: Date, unit: Unit, tz = DEFAULT_TZ) {
  const t = (col: string) => localTrunc(Prisma.raw(col), unit, tz);
  const rows = await prisma.$queryRaw<
    { label: string; revenue: Prisma.Decimal | null; spend: Prisma.Decimal | null; fees: Prisma.Decimal | null; refunds: Prisma.Decimal | null; expenses: Prisma.Decimal | null; sold: bigint | null; purchased: bigint | null; used: bigint | null }[]
  >`
    WITH ${bucketsCte(from, to, unit, tz)}
    SELECT to_char(b, ${FMT[unit]}) AS label,
      (SELECT SUM(amount) FROM payments p WHERE ${t('p."verifiedAt"')} = b AND p.status IN ('SUCCESS','REFUNDED') AND p."verifiedAt" BETWEEN ${from} AND ${to}) AS revenue,
      (SELECT SUM("feeAmount") FROM payments p WHERE ${t('p."verifiedAt"')} = b AND p.status IN ('SUCCESS','REFUNDED') AND p."verifiedAt" BETWEEN ${from} AND ${to}) AS fees,
      (SELECT SUM("totalCost") FROM provider_purchases pp WHERE ${t('pp."completedAt"')} = b AND pp.status = 'SUCCESS' AND pp."completedAt" BETWEEN ${from} AND ${to}) AS spend,
      (SELECT SUM(quantity) FROM provider_purchases pp WHERE ${t('pp."completedAt"')} = b AND pp.status = 'SUCCESS' AND pp."completedAt" BETWEEN ${from} AND ${to}) AS purchased,
      (SELECT SUM(amount) FROM refunds r WHERE ${t('r."createdAt"')} = b AND r."createdAt" BETWEEN ${from} AND ${to}) AS refunds,
      (SELECT SUM(amount) FROM expenses e WHERE ${t('e."incurredAt"')} = b AND e."deletedAt" IS NULL AND e."incurredAt" BETWEEN ${from} AND ${to}) AS expenses,
      (SELECT SUM(credits) FROM customer_purchases c WHERE ${t('c."createdAt"')} = b AND c."createdAt" BETWEEN ${from} AND ${to}) AS sold,
      (SELECT -SUM(amount) FROM provider_capacity_ledger l WHERE ${t('l."createdAt"')} = b AND l.type IN ('USAGE','RELEASE') AND l."createdAt" BETWEEN ${from} AND ${to}) AS used
    FROM buckets ORDER BY b`;
  return rows.map((r) => {
    const revenue = dec(r.revenue);
    const spend = dec(r.spend);
    const profit = revenue.minus(spend).minus(dec(r.refunds)).minus(dec(r.fees)).minus(dec(r.expenses));
    return {
      label: r.label,
      revenue: money(revenue),
      providerSpend: money(spend),
      costs: money(spend.plus(dec(r.refunds)).plus(dec(r.fees)).plus(dec(r.expenses))),
      profit: money(profit),
      smsSold: Number(r.sold ?? 0),
      smsPurchased: Number(r.purchased ?? 0),
      smsUsed: Number(r.used ?? 0),
    };
  });
}

export async function providerBreakdown(from: Date, to: Date) {
  const [providers, spend, usage] = await Promise.all([
    prisma.smsProvider.findMany({ orderBy: { priority: 'asc' } }),
    prisma.providerPurchase.groupBy({ by: ['providerId'], where: { status: 'SUCCESS', completedAt: { gte: from, lte: to } }, _sum: { totalCost: true, quantity: true } }),
    prisma.providerCapacityLedger.groupBy({ by: ['providerId'], where: { createdAt: { gte: from, lte: to }, type: { in: ['USAGE', 'RELEASE'] } }, _sum: { amount: true } }),
  ]);
  return providers.map((p) => {
    const s = spend.find((x) => x.providerId === p.id);
    const u = usage.find((x) => x.providerId === p.id);
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      status: p.status,
      purchased: s?._sum.quantity ?? 0,
      spend: money(dec(s?._sum.totalCost)),
      used: -(u?._sum.amount ?? 0),
      remaining: p.capacityBalance,
      lowCapacityThreshold: p.lowCapacityThreshold,
    };
  });
}

export async function financialTables(from: Date, to: Date) {
  const inRange = { gte: from, lte: to };
  const [recentPayments, recentProviderPurchases, recentSales, topUsage, revenueByOrg, failedPayments, failedPurchases] = await Promise.all([
    prisma.payment.findMany({ where: { createdAt: inRange }, orderBy: { createdAt: 'desc' }, take: 8, include: { organization: { select: { id: true, name: true } } } }),
    prisma.providerPurchase.findMany({ where: { createdAt: inRange }, orderBy: { createdAt: 'desc' }, take: 8, include: { provider: { select: { code: true, name: true } } } }),
    prisma.customerPurchase.findMany({ where: { createdAt: inRange }, orderBy: { createdAt: 'desc' }, take: 8, include: { organization: { select: { id: true, name: true } } } }),
    topOrganizations(from, to, 5),
    prisma.customerPurchase.groupBy({ by: ['organizationId'], where: { createdAt: inRange }, _sum: { revenue: true, credits: true }, orderBy: { _sum: { revenue: 'desc' } }, take: 5 }),
    prisma.payment.findMany({ where: { status: 'FAILED', createdAt: inRange }, orderBy: { createdAt: 'desc' }, take: 5, include: { organization: { select: { id: true, name: true } } } }),
    prisma.providerPurchase.findMany({ where: { status: 'FAILED', createdAt: inRange }, orderBy: { createdAt: 'desc' }, take: 5, include: { provider: { select: { name: true } } } }),
  ]);
  const orgs = await prisma.organization.findMany({ where: { id: { in: revenueByOrg.map((r) => r.organizationId) } }, select: { id: true, name: true } });
  return {
    recentPayments: recentPayments.map((p) => ({ id: p.id, reference: p.reference, organization: p.organization, amount: money(p.amount), fee: money(p.feeAmount), currency: p.currency, status: p.status, createdAt: p.createdAt })),
    recentProviderPurchases: recentProviderPurchases.map((p) => ({ id: p.id, reference: p.reference, provider: p.provider, quantity: p.quantity, totalCost: money(p.totalCost), currency: p.currency, status: p.status, createdAt: p.createdAt })),
    recentSales: recentSales.map((s) => ({ id: s.id, organization: s.organization, packageName: s.packageName, credits: s.credits, revenue: money(s.revenue), contribution: money(s.contribution), createdAt: s.createdAt })),
    topCustomersByUsage: topUsage,
    topCustomersByRevenue: revenueByOrg.map((r) => ({ id: r.organizationId, name: orgs.find((o) => o.id === r.organizationId)?.name ?? '—', revenue: money(dec(r._sum.revenue)), credits: r._sum.credits ?? 0 })),
    failedTransactions: [
      ...failedPayments.map((p) => ({ id: p.id, kind: 'CUSTOMER_PAYMENT' as const, reference: p.reference, party: p.organization.name, amount: money(p.amount), reason: p.failureReason, createdAt: p.createdAt })),
      ...failedPurchases.map((p) => ({ id: p.id, kind: 'PROVIDER_PURCHASE' as const, reference: p.reference, party: p.provider.name, amount: money(p.totalCost), reason: p.failureReason, createdAt: p.createdAt })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  };
}
