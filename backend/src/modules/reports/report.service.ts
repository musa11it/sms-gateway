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

// Bucket labels, e.g. 2026-10-05T14:00 / 2026-10-05 / 2026-10 (MySQL DATE_FORMAT patterns).
export const FMT: Record<Unit, string> = { hour: '%Y-%m-%dT%H:00', day: '%Y-%m-%d', month: '%Y-%m' };

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** UTC offset of `tz` at instant `at`, in whole seconds. */
function offsetSeconds(at: number, tz: string): number {
  let fmt = offsetFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    offsetFormatters.set(tz, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 1000);
}

/**
 * The time zone's UTC offsets over [from, to]: each segment applies to instants before `until`
 * (the last one has no end). Transitions are located to the minute.
 */
function offsetSegments(from: Date, to: Date, tz: string): { until: Date | null; offset: number }[] {
  const DAY = 86_400_000;
  const segments: { until: Date | null; offset: number }[] = [];
  let current = offsetSeconds(from.getTime(), tz);
  for (let t = from.getTime(); t < to.getTime(); t += DAY) {
    const next = Math.min(t + DAY, to.getTime());
    const o = offsetSeconds(next, tz);
    if (o === current) continue;
    let lo = t;
    let hi = next;
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (offsetSeconds(mid, tz) === current) lo = mid;
      else hi = mid;
    }
    segments.push({ until: new Date(hi), offset: current });
    current = o;
  }
  segments.push({ until: null, offset: current });
  return segments;
}

/**
 * SQL expression giving the local-time bucket label of a timestamp column. Timestamps are stored in UTC
 * and MySQL may not have named time zones loaded, so the offsets are computed here (DST-aware).
 */
export function localBucket(column: Prisma.Sql, unit: Unit, tz: string, from: Date, to: Date) {
  const segments = offsetSegments(from, to, tz);
  const offset =
    segments.length === 1
      ? Prisma.sql`${segments[0].offset}`
      : Prisma.sql`CASE ${Prisma.join(
          segments.map((s) => (s.until ? Prisma.sql`WHEN ${column} < ${s.until} THEN ${s.offset}` : Prisma.sql`ELSE ${s.offset}`)),
          ' ',
        )} END`;
  return Prisma.sql`DATE_FORMAT(DATE_ADD(${column}, INTERVAL ${offset} SECOND), ${FMT[unit]})`;
}

/** Every bucket label between `from` and `to` (inclusive) in local time. */
export function bucketLabels(from: Date, to: Date, unit: Unit, tz: string): string[] {
  const local = (d: Date) => {
    const x = new Date(d.getTime() + offsetSeconds(d.getTime(), tz) * 1000);
    return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), h: x.getUTCHours() };
  };
  const start = local(from);
  const end = local(to);
  const bucket = (y: number, m: number, d: number, h: number) =>
    unit === 'hour' ? Date.UTC(y, m, d, h) : unit === 'day' ? Date.UTC(y, m, d) : Date.UTC(y, m, 1);
  const last = bucket(end.y, end.m, end.d, end.h);
  const pad = (n: number) => String(n).padStart(2, '0');
  const labels: string[] = [];
  for (let i = 0; ; i++) {
    const b = new Date(
      unit === 'hour' ? bucket(start.y, start.m, start.d, start.h + i) : unit === 'day' ? bucket(start.y, start.m, start.d + i, 0) : bucket(start.y, start.m + i, 1, 0),
    );
    if (b.getTime() > last) break;
    const day = `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`;
    labels.push(unit === 'hour' ? `${day}T${pad(b.getUTCHours())}:00` : unit === 'day' ? day : day.slice(0, 7));
  }
  return labels;
}

/** Line grouped rows up with the full list of buckets, so empty buckets are still reported. */
export function fillBuckets<T extends { label: string }>(labels: string[], rows: T[]): (T | undefined)[] {
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  return labels.map((l) => byLabel.get(l));
}

export async function smsTimeseries(from: Date, to: Date, unit: Unit, organizationId?: string, tz = DEFAULT_TZ) {
  const orgFilter = organizationId ? Prisma.sql`AND r.organizationId = ${organizationId}` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ label: string; total: bigint; delivered: bigint; failed: bigint; pending: bigint }[]>`
    SELECT ${localBucket(Prisma.sql`r.createdAt`, unit, tz, from, to)} AS label,
      COUNT(CASE WHEN r.status <> 'CANCELLED' THEN 1 END) AS total,
      COUNT(CASE WHEN r.status = 'DELIVERED' THEN 1 END) AS delivered,
      COUNT(CASE WHEN r.status IN ('FAILED','EXPIRED','REJECTED') THEN 1 END) AS failed,
      COUNT(CASE WHEN r.status IN ('QUEUED','PROCESSING','SENT') THEN 1 END) AS pending
    FROM sms_recipients r
    WHERE r.createdAt >= ${from} AND r.createdAt <= ${to} ${orgFilter}
    GROUP BY label`;
  const labels = bucketLabels(from, to, unit, tz);
  return fillBuckets(labels, rows).map((r, i) => ({
    label: labels[i],
    total: Number(r?.total ?? 0),
    delivered: Number(r?.delivered ?? 0),
    failed: Number(r?.failed ?? 0),
    pending: Number(r?.pending ?? 0),
  }));
}

export async function smsTotals(from: Date, to: Date, organizationId?: string) {
  const grouped = await prisma.smsRecipient.groupBy({
    by: ['status'],
    where: { createdAt: { gte: from, lte: to }, ...(organizationId ? { organizationId } : {}) },
    _count: true,
  });
  const c = (s: string) => grouped.find((g) => g.status === s)?._count ?? 0;
  const delivered = c('DELIVERED');
  const failed = c('FAILED') + c('EXPIRED') + c('REJECTED');
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
  const rows = await prisma.$queryRaw<{ label: string; revenue: Prisma.Decimal | null; credits: Prisma.Decimal | null; payments: bigint }[]>`
    SELECT ${localBucket(Prisma.sql`p.verifiedAt`, unit, tz, from, to)} AS label, SUM(p.amount) AS revenue, SUM(p.credits) AS credits, COUNT(p.id) AS payments
    FROM payments p
    WHERE p.status = 'SUCCESS' AND p.verifiedAt >= ${from} AND p.verifiedAt <= ${to}
    GROUP BY label`;
  const labels = bucketLabels(from, to, unit, tz);
  return fillBuckets(labels, rows).map((r, i) => ({
    label: labels[i],
    revenue: (r?.revenue ?? new Prisma.Decimal(0)).toFixed(2),
    credits: Number(r?.credits ?? 0),
    payments: Number(r?.payments ?? 0),
  }));
}

export async function customerGrowth(from: Date, to: Date, unit: Unit, tz = DEFAULT_TZ) {
  const [signups, approved] = await Promise.all([
    prisma.$queryRaw<{ label: string; n: bigint }[]>`
      SELECT ${localBucket(Prisma.sql`o.createdAt`, unit, tz, from, to)} AS label, COUNT(*) AS n
      FROM organizations o WHERE o.createdAt >= ${from} GROUP BY label`,
    prisma.$queryRaw<{ label: string; n: bigint }[]>`
      SELECT ${localBucket(Prisma.sql`o.approvedAt`, unit, tz, from, to)} AS label, COUNT(*) AS n
      FROM organizations o WHERE o.approvedAt >= ${from} GROUP BY label`,
  ]);
  const labels = bucketLabels(from, to, unit, tz);
  const approvedByBucket = fillBuckets(labels, approved);
  return fillBuckets(labels, signups).map((r, i) => ({ label: labels[i], signups: Number(r?.n ?? 0), approved: Number(approvedByBucket[i]?.n ?? 0) }));
}

export async function providerPerformance(from: Date, to: Date) {
  const rows = await prisma.$queryRaw<{ provider: string; total: bigint; delivered: bigint; failed: bigint; avg_latency_ms: Prisma.Decimal | number | null }[]>`
    SELECT COALESCE(provider, 'unassigned') AS provider,
      COUNT(*) AS total,
      COUNT(CASE WHEN status = 'DELIVERED' THEN 1 END) AS delivered,
      COUNT(CASE WHEN status IN ('FAILED','EXPIRED','REJECTED') THEN 1 END) AS failed,
      AVG(CASE WHEN status = 'DELIVERED' THEN TIMESTAMPDIFF(MICROSECOND, sentAt, deliveredAt) / 1000 END) AS avg_latency_ms
    FROM sms_recipients WHERE createdAt >= ${from} AND createdAt <= ${to} AND status <> 'CANCELLED'
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
    else if (row.status === 'FAILED' || row.status === 'EXPIRED' || row.status === 'REJECTED') s.failed += row._count;
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
