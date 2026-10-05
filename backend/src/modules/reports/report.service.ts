import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/errors';

export const DEFAULT_TZ = 'Africa/Kigali';

export const rangeQuery = z.object({
  range: z.enum(['today', 'yesterday', 'week', '7d', '30d', 'month', 'lastMonth', 'year', 'all', 'custom']).default('30d'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type Unit = 'hour' | 'day' | 'month';

function tzOffsetMs(at: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

function localParts(at: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(at).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month - 1, d: +p.day };
}

function zonedDate(y: number, m: number, d: number, tz: string) {
  const guess = Date.UTC(y, m, d);
  return new Date(guess - tzOffsetMs(guess, tz));
}

/** Earliest date reports can start from when "all time" is selected. */
export const ALL_TIME_START = new Date('2020-01-01T00:00:00Z');

export function resolveRange(q: z.infer<typeof rangeQuery>, tz = DEFAULT_TZ, allTimeFrom = ALL_TIME_START): { from: Date; to: Date; unit: Unit } {
  const now = new Date();
  const { y, m, d } = localParts(now, tz);
  switch (q.range) {
    case 'today':
      return { from: zonedDate(y, m, d, tz), to: now, unit: 'hour' };
    case 'yesterday':
      return { from: zonedDate(y, m, d - 1, tz), to: new Date(zonedDate(y, m, d, tz).getTime() - 1), unit: 'hour' };
    case 'week': {
      const dow = (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7; // Monday = 0
      return { from: zonedDate(y, m, d - dow, tz), to: now, unit: 'day' };
    }
    case 'lastMonth':
      return { from: zonedDate(y, m - 1, 1, tz), to: new Date(zonedDate(y, m, 1, tz).getTime() - 1), unit: 'day' };
    case 'all': {
      const days = (now.getTime() - allTimeFrom.getTime()) / 86_400_000;
      return { from: allTimeFrom, to: now, unit: days <= 62 ? 'day' : 'month' };
    }
    case '7d':
      return { from: zonedDate(y, m, d - 6, tz), to: now, unit: 'day' };
    case '30d':
      return { from: zonedDate(y, m, d - 29, tz), to: now, unit: 'day' };
    case 'month':
      return { from: zonedDate(y, m, 1, tz), to: now, unit: 'day' };
    case 'year':
      return { from: zonedDate(y, 0, 1, tz), to: now, unit: 'month' };
    case 'custom': {
      if (!q.from || !q.to) throw AppError.unprocessable('Custom range needs "from" and "to"', 'INVALID_RANGE');
      if (q.from > q.to) throw AppError.unprocessable('"from" must be before "to"', 'INVALID_RANGE');
      const days = (q.to.getTime() - q.from.getTime()) / 86_400_000;
      if (days > 366 * 2) throw AppError.unprocessable('Custom range can span at most 2 years', 'INVALID_RANGE');
      return { from: q.from, to: q.to, unit: days <= 2 ? 'hour' : days <= 120 ? 'day' : 'month' };
    }
  }
}

export const FMT: Record<Unit, string> = { hour: 'YYYY-MM-DD"T"HH24:00', day: 'YYYY-MM-DD', month: 'YYYY-MM' };

export function bucketsCte(from: Date, to: Date, unit: Unit, tz: string) {
  return Prisma.sql`buckets AS (
    SELECT generate_series(
      date_trunc(${unit}, ${from}::timestamptz AT TIME ZONE ${tz}),
      date_trunc(${unit}, ${to}::timestamptz AT TIME ZONE ${tz}),
      ${`1 ${unit}`}::interval
    ) AS b
  )`;
}

export function localTrunc(column: Prisma.Sql, unit: Unit, tz: string) {
  return Prisma.sql`date_trunc(${unit}, (${column} AT TIME ZONE 'UTC') AT TIME ZONE ${tz})`;
}

export async function smsTimeseries(from: Date, to: Date, unit: Unit, organizationId?: string, tz = DEFAULT_TZ) {
  const orgFilter = organizationId ? Prisma.sql`AND r."organizationId" = ${organizationId}::uuid` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ label: string; total: bigint; delivered: bigint; failed: bigint; pending: bigint }[]>`
    WITH ${bucketsCte(from, to, unit, tz)}
    SELECT to_char(b, ${FMT[unit]}) AS label,
      COUNT(r.id) FILTER (WHERE r.status <> 'CANCELLED') AS total,
      COUNT(r.id) FILTER (WHERE r.status = 'DELIVERED') AS delivered,
      COUNT(r.id) FILTER (WHERE r.status IN ('FAILED','EXPIRED')) AS failed,
      COUNT(r.id) FILTER (WHERE r.status IN ('QUEUED','PROCESSING','SENT')) AS pending
    FROM buckets
    LEFT JOIN sms_recipients r ON ${localTrunc(Prisma.sql`r."createdAt"`, unit, tz)} = b
      AND r."createdAt" >= ${from} AND r."createdAt" <= ${to} ${orgFilter}
    GROUP BY b ORDER BY b`;
  return rows.map((r) => ({ label: r.label, total: Number(r.total), delivered: Number(r.delivered), failed: Number(r.failed), pending: Number(r.pending) }));
}

export async function smsTotals(from: Date, to: Date, organizationId?: string) {
  const grouped = await prisma.smsRecipient.groupBy({
    by: ['status'],
    where: { createdAt: { gte: from, lte: to }, ...(organizationId ? { organizationId } : {}) },
    _count: true,
  });
  const c = (s: string) => grouped.find((g) => g.status === s)?._count ?? 0;
  const delivered = c('DELIVERED');
  const failed = c('FAILED') + c('EXPIRED');
  const pending = c('QUEUED') + c('PROCESSING') + c('SENT');
  const total = delivered + failed + pending;
  const final = delivered + failed;
  return {
    total,
    delivered,
    failed,
    pending,
    cancelled: c('CANCELLED'),
    // Only computed over messages with a final outcome — pending messages are not counted as failures or successes.
    deliveryRate: final > 0 ? Math.round((delivered / final) * 1000) / 10 : null,
    deliveryRateBasis: { final, total },
  };
}

export async function creditsConsumed(from: Date, to: Date, organizationId?: string) {
  const agg = await prisma.walletTransaction.aggregate({
    where: { type: { in: ['SMS_DEBIT', 'REFUND'] }, createdAt: { gte: from, lte: to }, ...(organizationId ? { organizationId } : {}), NOT: { reference: { startsWith: 'admin:' } } },
    _sum: { amount: true },
  });
  return Math.max(0, -(agg._sum.amount ?? 0));
}

export async function revenueTimeseries(from: Date, to: Date, unit: Unit, tz = DEFAULT_TZ) {
  const rows = await prisma.$queryRaw<{ label: string; revenue: Prisma.Decimal | null; credits: bigint | null; payments: bigint }[]>`
    WITH ${bucketsCte(from, to, unit, tz)}
    SELECT to_char(b, ${FMT[unit]}) AS label, SUM(p.amount) AS revenue, SUM(p.credits) AS credits, COUNT(p.id) AS payments
    FROM buckets
    LEFT JOIN payments p ON ${localTrunc(Prisma.sql`p."verifiedAt"`, unit, tz)} = b
      AND p.status = 'SUCCESS' AND p."verifiedAt" >= ${from} AND p."verifiedAt" <= ${to}
    GROUP BY b ORDER BY b`;
  return rows.map((r) => ({ label: r.label, revenue: (r.revenue ?? new Prisma.Decimal(0)).toFixed(2), credits: Number(r.credits ?? 0), payments: Number(r.payments) }));
}

export async function customerGrowth(from: Date, to: Date, unit: Unit, tz = DEFAULT_TZ) {
  const rows = await prisma.$queryRaw<{ label: string; signups: bigint; approved: bigint }[]>`
    WITH ${bucketsCte(from, to, unit, tz)}
    SELECT to_char(b, ${FMT[unit]}) AS label,
      (SELECT COUNT(*) FROM organizations o WHERE ${localTrunc(Prisma.sql`o."createdAt"`, unit, tz)} = b AND o."createdAt" >= ${from}) AS signups,
      (SELECT COUNT(*) FROM organizations o WHERE ${localTrunc(Prisma.sql`o."approvedAt"`, unit, tz)} = b AND o."approvedAt" >= ${from}) AS approved
    FROM buckets ORDER BY b`;
  return rows.map((r) => ({ label: r.label, signups: Number(r.signups), approved: Number(r.approved) }));
}

export async function providerPerformance(from: Date, to: Date) {
  const rows = await prisma.$queryRaw<{ provider: string; total: bigint; delivered: bigint; failed: bigint; avg_latency_ms: number | null }[]>`
    SELECT COALESCE(provider, 'unassigned') AS provider,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'DELIVERED') AS delivered,
      COUNT(*) FILTER (WHERE status IN ('FAILED','EXPIRED')) AS failed,
      AVG(EXTRACT(EPOCH FROM ("deliveredAt" - "sentAt")) * 1000) FILTER (WHERE status = 'DELIVERED') AS avg_latency_ms
    FROM sms_recipients WHERE "createdAt" >= ${from} AND "createdAt" <= ${to} AND status <> 'CANCELLED'
    GROUP BY 1 ORDER BY 2 DESC`;
  return rows.map((r) => {
    const final = Number(r.delivered) + Number(r.failed);
    return {
      provider: r.provider,
      total: Number(r.total),
      delivered: Number(r.delivered),
      failed: Number(r.failed),
      deliveryRate: final ? Math.round((Number(r.delivered) / final) * 1000) / 10 : null,
      avgDeliveryLatencyMs: r.avg_latency_ms !== null ? Math.round(Number(r.avg_latency_ms)) : null,
    };
  });
}

export async function campaignPerformance(ids: string[]) {
  const map = new Map<string, { recipients: number; delivered: number; failed: number; pending: number }>();
  if (!ids.length) return map;
  const g = await prisma.smsRecipient.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: ids } }, _count: true });
  for (const row of g) {
    const s = map.get(row.campaignId!) ?? { recipients: 0, delivered: 0, failed: 0, pending: 0 };
    s.recipients += row._count;
    if (row.status === 'DELIVERED') s.delivered += row._count;
    else if (row.status === 'FAILED' || row.status === 'EXPIRED') s.failed += row._count;
    else if (row.status !== 'CANCELLED') s.pending += row._count;
    map.set(row.campaignId!, s);
  }
  return map;
}

export async function topOrganizations(from: Date, to: Date, limit = 5) {
  const rows = await prisma.smsRecipient.groupBy({
    by: ['organizationId'],
    where: { createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } },
    _count: true,
    _sum: { credits: true },
    orderBy: { _count: { organizationId: 'desc' } },
    take: limit,
  });
  const orgs = await prisma.organization.findMany({ where: { id: { in: rows.map((r) => r.organizationId) } }, select: { id: true, name: true, status: true } });
  return rows.map((r) => ({ ...orgs.find((o) => o.id === r.organizationId)!, messages: r._count, credits: r._sum.credits ?? 0 }));
}
