import { Prisma, type SmsRecipientStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/errors';
import type { LotConsumption } from '../wallet/creditLots';
import { splitSlices } from '../providers/provider.service';
import { DEFAULT_TZ, localBucket, type Unit } from '../reports/report.service';

/**
 * The one place SMS gross profit is defined. Every view (finance overview, customers, providers,
 * campaigns, a single SMS, the routing simulator) reads these figures; none re-implements them.
 *
 * Unit: one SMS segment = one credit. For every recipient we freeze, at send time:
 *   revenue      = Σ credits × selling price of the customer credit lot they came from   (revenueLots)
 *   providerCost = Σ segments × unit cost of the provider capacity lot they came from      (costLots)
 * Changing customer prices, provider prices, rules or statuses later never changes these numbers.
 *
 * Realized (counted in SMS revenue / gross profit): a provider accepted the message (SENT,
 * DELIVERED, or later FAILED/EXPIRED in delivery — still billed) and it was not refunded.
 * Pending: QUEUED/PROCESSING (credits reserved). Never counted: REJECTED/CANCELLED (refunded).
 *
 *   Gross profit       = SMS revenue − provider cost            (direct cost only)
 *   Gross margin (%)   = gross profit ÷ SMS revenue × 100       (0 when revenue is 0)
 * Payment fees, refunds and operating expenses are NOT direct SMS costs; they belong to net profit.
 */

export const REALIZED_STATUSES: SmsRecipientStatus[] = ['SENT', 'DELIVERED', 'FAILED', 'EXPIRED'];
export const PENDING_STATUSES: SmsRecipientStatus[] = ['QUEUED', 'PROCESSING'];

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);

export interface RevenueLot extends LotConsumption {
  unitPrice: string | null;
}

/** Split a debit's consumed credit lots across `count` recipients of `creditsEach` credits, in order. */
export function recipientRevenue(consumed: LotConsumption[], creditsEach: number, count: number) {
  return splitSlices(
    consumed.map((c) => ({ ...c, qty: c.credits })),
    creditsEach,
    count,
  ).map((mine) => {
    const revenueLots: RevenueLot[] = mine.map(({ lotId, qty, unitPrice }) => ({ lotId, credits: qty, unitPrice: unitPrice ?? null }));
    return { revenue: revenueLots.reduce((s, l) => s.plus(D(l.unitPrice).mul(l.credits)), D(0)), revenueLots };
  });
}

/**
 * Money figures from exact (4-dp) sums. Revenue and cost are rounded to 2 dp and gross profit is
 * their difference, so what is displayed always reconciles: revenue − cost = gross profit.
 */
export function figures(input: { revenue: Prisma.Decimal.Value; providerCost: Prisma.Decimal.Value; segments?: number; credits?: number; messages?: number }) {
  const revenue = D(input.revenue).toDecimalPlaces(2);
  const providerCost = D(input.providerCost).toDecimalPlaces(2);
  const grossProfit = revenue.minus(providerCost);
  return {
    messages: input.messages ?? 0,
    segments: input.segments ?? 0,
    credits: input.credits ?? 0,
    revenue: revenue.toFixed(2),
    providerCost: providerCost.toFixed(2),
    grossProfit: grossProfit.toFixed(2),
    grossMarginPercent: marginPercent(revenue, grossProfit),
  };
}

export function marginPercent(revenue: Prisma.Decimal.Value, grossProfit: Prisma.Decimal.Value) {
  const r = D(revenue);
  return r.gt(0) ? D(grossProfit).div(r).mul(100).toDecimalPlaces(2).toNumber() : 0;
}

export type SmsFigures = ReturnType<typeof figures>;

export interface ProfitFilter {
  from: Date;
  to: Date;
  organizationId?: string;
  providerId?: string;
  campaignId?: string;
  countryCode?: string;
  networkId?: string;
}

export type ProfitGroup = 'provider' | 'organization' | 'campaign' | 'country' | 'network' | 'day' | 'month';

function whereSql(f: ProfitFilter, statuses: SmsRecipientStatus[]) {
  return Prisma.sql`r.status IN (${Prisma.join(statuses)}) AND r.refunded = FALSE AND r.createdAt >= ${f.from} AND r.createdAt <= ${f.to}
    ${f.organizationId ? Prisma.sql`AND r.organizationId = ${f.organizationId}` : Prisma.empty}
    ${f.providerId ? Prisma.sql`AND r.providerId = ${f.providerId}` : Prisma.empty}
    ${f.campaignId ? Prisma.sql`AND r.campaignId = ${f.campaignId}` : Prisma.empty}
    ${f.countryCode ? Prisma.sql`AND r.countryCode = ${f.countryCode}` : Prisma.empty}
    ${f.networkId ? Prisma.sql`AND r.networkId = ${f.networkId}` : Prisma.empty}`;
}

type SumRow = { k: string | null; messages: bigint; segments: unknown; credits: unknown; revenue: unknown; cost: unknown };

async function sums(f: ProfitFilter, statuses: SmsRecipientStatus[], key: Prisma.Sql | null) {
  return prisma.$queryRaw<SumRow[]>`
    SELECT ${key ?? Prisma.sql`NULL`} AS k, COUNT(*) AS messages, COALESCE(SUM(m.segments), 0) AS segments, COALESCE(SUM(r.credits), 0) AS credits,
           COALESCE(SUM(r.revenue), 0) AS revenue, COALESCE(SUM(r.providerCost), 0) AS cost
    FROM sms_recipients r JOIN sms_messages m ON m.id = r.messageId
    WHERE ${whereSql(f, statuses)}
    ${key ? Prisma.sql`GROUP BY k` : Prisma.empty}`;
}

const toFigures = (r: SumRow | undefined) =>
  figures({ revenue: String(r?.revenue ?? 0), providerCost: String(r?.cost ?? 0), segments: Number(r?.segments ?? 0), credits: Number(r?.credits ?? 0), messages: Number(r?.messages ?? 0) });

/** Realized SMS gross profit for the filter, with the credits still pending (reserved, not yet accepted). */
export async function profitTotals(f: ProfitFilter) {
  const [[realized], [pending]] = await Promise.all([sums(f, REALIZED_STATUSES, null), sums(f, PENDING_STATUSES, null)]);
  const p = toFigures(pending);
  return { ...toFigures(realized), pending: { messages: p.messages, credits: p.credits, revenue: p.revenue, providerCost: p.providerCost } };
}

/** Realized SMS gross profit grouped by provider / customer / campaign / destination / day / month. */
export async function profitBreakdown(f: ProfitFilter, groupBy: ProfitGroup, tz = DEFAULT_TZ) {
  const key: Record<ProfitGroup, Prisma.Sql> = {
    provider: Prisma.sql`r.providerId`,
    organization: Prisma.sql`r.organizationId`,
    campaign: Prisma.sql`r.campaignId`,
    country: Prisma.sql`r.countryCode`,
    network: Prisma.sql`r.networkId`,
    day: localBucket(Prisma.sql`r.createdAt`, 'day' as Unit, tz, f.from, f.to),
    month: localBucket(Prisma.sql`r.createdAt`, 'month' as Unit, tz, f.from, f.to),
  };
  const rows = await sums(f, REALIZED_STATUSES, key[groupBy]);
  const ids = rows.map((r) => r.k).filter((k): k is string => !!k);
  const names = new Map<string, string>();
  if (groupBy === 'provider') (await prisma.smsProvider.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).forEach((x) => names.set(x.id, x.name));
  if (groupBy === 'organization') (await prisma.organization.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).forEach((x) => names.set(x.id, x.name));
  if (groupBy === 'campaign') (await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).forEach((x) => names.set(x.id, x.name));
  if (groupBy === 'network') (await prisma.smsNetwork.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).forEach((x) => names.set(x.id, x.name));
  if (groupBy === 'country') (await prisma.smsCountry.findMany({ where: { isoCode: { in: ids } }, select: { isoCode: true, name: true } })).forEach((x) => names.set(x.isoCode, x.name));
  const fallback: Partial<Record<ProfitGroup, string>> = { campaign: 'Not part of a campaign', network: 'Other numbers', country: 'Unknown', provider: 'Unassigned' };
  const out = rows.map((r) => ({ key: r.k, label: r.k ? (names.get(r.k) ?? r.k) : (fallback[groupBy] ?? '—'), ...toFigures(r) }));
  return groupBy === 'day' || groupBy === 'month' ? out.sort((a, b) => String(a.key).localeCompare(String(b.key))) : out.sort((a, b) => Number(b.revenue) - Number(a.revenue));
}

/** Everything about one SMS (recipient): what the customer paid, which provider and lots carried it, and the gross profit. */
export async function recipientFinancials(id: string) {
  const r = await prisma.smsRecipient.findUnique({
    where: { id },
    include: { message: { select: { id: true, segments: true, senderName: true, campaignId: true, createdAt: true } }, smsProvider: { select: { id: true, name: true, code: true } }, organization: { select: { id: true, name: true } } },
  });
  if (!r) throw AppError.notFound('Message');
  const costLots = (Array.isArray(r.costLots) ? r.costLots : []) as { lotId: string; segments: number; unitCost: string }[];
  const revenueLots = (Array.isArray(r.revenueLots) ? r.revenueLots : []) as unknown as RevenueLot[];
  const [pLots, cLots] = await Promise.all([
    prisma.providerCapacityLot.findMany({ where: { id: { in: costLots.map((l) => l.lotId) } }, select: { id: true, reference: true, createdAt: true, purchase: { select: { reference: true } } } }),
    prisma.smsCreditLot.findMany({ where: { id: { in: revenueLots.map((l) => l.lotId) } }, select: { id: true, sourceType: true, createdAt: true, sourceTransactionId: true } }),
  ]);
  const txs = await prisma.walletTransaction.findMany({ where: { id: { in: cLots.map((l) => l.sourceTransactionId).filter((x): x is string => !!x) } }, select: { id: true, reference: true } });
  const realized = REALIZED_STATUSES.includes(r.status) && !r.refunded;
  const f = figures({ revenue: String(r.revenue ?? 0), providerCost: String(r.providerCost ?? 0), segments: r.message.segments, credits: r.credits, messages: 1 });
  return {
    id: r.id,
    phone: r.phone,
    status: r.status,
    organization: r.organization,
    messageId: r.message.id,
    campaignId: r.message.campaignId,
    sentAt: r.message.createdAt,
    provider: r.smsProvider,
    realized,
    state: realized ? 'REALIZED' : PENDING_STATUSES.includes(r.status) && !r.refunded ? 'PENDING' : 'NOT_CHARGED',
    customerPricePerCredit: r.credits ? D(r.revenue).div(r.credits).toFixed(4) : '0.0000',
    providerCostPerSegment: r.message.segments ? D(r.providerCost).div(r.message.segments).toFixed(4) : '0.0000',
    ...f,
    revenueLots: revenueLots.map((l) => {
      const lot = cLots.find((c) => c.id === l.lotId);
      return { ...l, source: lot?.sourceType ?? null, purchasedAt: lot?.createdAt ?? null, reference: txs.find((t) => t.id === lot?.sourceTransactionId)?.reference ?? null };
    }),
    costLots: costLots.map((l) => {
      const lot = pLots.find((p) => p.id === l.lotId);
      return { ...l, reference: lot?.purchase?.reference ?? lot?.reference ?? null, purchasedAt: lot?.createdAt ?? null, cost: D(l.unitCost).mul(l.segments).toFixed(4) };
    }),
  };
}

/** Per customer credit lot: realized credits, revenue and the provider cost of the SMS they paid for. */
export async function creditLotUsage(lotIds: string[]) {
  if (!lotIds.length) return new Map<string, { credits: number; revenue: Prisma.Decimal; providerCost: Prisma.Decimal }>();
  const rows = await prisma.$queryRaw<{ lotId: string; credits: unknown; revenue: unknown; cost: unknown }[]>`
    SELECT jt.lotId, SUM(jt.credits) AS credits, SUM(jt.credits * COALESCE(jt.unitPrice, 0)) AS revenue, SUM(COALESCE(r.providerCost, 0) * jt.credits / r.credits) AS cost
    FROM sms_recipients r,
         JSON_TABLE(r.revenueLots, '$[*]' COLUMNS (lotId CHAR(36) PATH '$.lotId', credits INT PATH '$.credits', unitPrice DECIMAL(14, 4) PATH '$.unitPrice')) jt
    WHERE r.revenueLots IS NOT NULL AND r.status IN (${Prisma.join(REALIZED_STATUSES)}) AND r.refunded = FALSE AND r.credits > 0
      AND jt.lotId IN (${Prisma.join(lotIds)})
    GROUP BY jt.lotId`;
  return new Map(rows.map((r) => [r.lotId, { credits: Number(r.credits ?? 0), revenue: D(String(r.revenue ?? 0)), providerCost: D(String(r.cost ?? 0)) }]));
}

/**
 * Financial view of customer purchases: credits sold at the frozen price, how many were used for
 * accepted SMS (realized revenue, provider cost, gross profit) and how many remain. Unused credits
 * carry no provider cost.
 */
export async function purchaseFinancials(purchases: { id: string; paymentId: string; credits: number }[]) {
  const txs = await prisma.walletTransaction.findMany({ where: { reference: { in: purchases.map((p) => `payment:${p.paymentId}`) } }, select: { id: true, reference: true } });
  const lots = await prisma.smsCreditLot.findMany({ where: { sourceTransactionId: { in: txs.map((t) => t.id) } } });
  const usage = await creditLotUsage(lots.map((l) => l.id));
  return new Map(
    purchases.map((p) => {
      const tx = txs.find((t) => t.reference === `payment:${p.paymentId}`);
      const lot = lots.find((l) => l.sourceTransactionId === tx?.id);
      const u = lot ? usage.get(lot.id) : undefined;
      const f = figures({ revenue: u?.revenue ?? 0, providerCost: u?.providerCost ?? 0, credits: u?.credits ?? 0 });
      return [
        p.id,
        {
          unitPrice: lot?.unitPrice?.toFixed(4) ?? null,
          creditsUsed: u?.credits ?? 0,
          creditsRemaining: lot?.remaining ?? 0,
          // Credits that left the lot without being realized yet: in-flight sends, expiry, purchase reversal.
          creditsOther: lot ? Math.max(0, lot.credits - lot.remaining - (u?.credits ?? 0)) : 0,
          revenueUsed: f.revenue,
          providerCost: f.providerCost,
          grossProfit: f.grossProfit,
          grossMarginPercent: f.grossMarginPercent,
        },
      ];
    }),
  );
}

/**
 * Per provider capacity lot: segments consumed by SMS (net of capacity returned by rejected or
 * cancelled messages) and their historical cost, separately from stock written off by adjustments.
 */
export async function providerLotConsumption(lotIds: string[]) {
  type Usage = { consumed: number; consumedCost: Prisma.Decimal; writtenOff: number; writtenOffCost: Prisma.Decimal };
  if (!lotIds.length) return new Map<string, Usage>();
  const rows = await prisma.$queryRaw<{ lotId: string; usage: unknown; cost: unknown; off: unknown; offCost: unknown }[]>`
    SELECT c.lotId,
           SUM(CASE WHEN l.type = 'USAGE' THEN c.quantity - c.returned ELSE 0 END) AS \`usage\`,
           SUM(CASE WHEN l.type = 'USAGE' THEN (c.quantity - c.returned) * c.unitCost ELSE 0 END) AS cost,
           SUM(CASE WHEN l.type <> 'USAGE' THEN c.quantity - c.returned ELSE 0 END) AS off,
           SUM(CASE WHEN l.type <> 'USAGE' THEN (c.quantity - c.returned) * c.unitCost ELSE 0 END) AS offCost
    FROM provider_lot_consumptions c JOIN provider_capacity_ledger l ON l.id = c.ledgerEntryId
    WHERE c.lotId IN (${Prisma.join(lotIds)}) GROUP BY c.lotId`;
  return new Map<string, Usage>(
    rows.map((r) => [r.lotId, { consumed: Number(r.usage ?? 0), consumedCost: D(String(r.cost ?? 0)), writtenOff: Number(r.off ?? 0), writtenOffCost: D(String(r.offCost ?? 0)) }]),
  );
}

/**
 * Expected per-segment economics of a route, read-only (routing simulator): the customer's next
 * credits (their own frozen lot prices, else the platform's realized average) against the
 * provider lots that would be consumed.
 */
export async function expectedPrice(organizationId: string | null | undefined, credits: number) {
  if (organizationId && credits > 0) {
    const wallet = await prisma.wallet.findUnique({ where: { organizationId }, select: { id: true } });
    const lots = wallet ? await prisma.smsCreditLot.findMany({ where: { walletId: wallet.id, remaining: { gt: 0 } } }) : [];
    // Same FEFO order as real debits (soonest expiry first, non-expiring last, oldest first).
    lots.sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) || a.createdAt.getTime() - b.createdAt.getTime());
    let left = credits;
    let revenue = D(0);
    for (const l of lots) {
      if (left === 0) break;
      const n = Math.min(left, l.remaining);
      revenue = revenue.plus(D(l.unitPrice).mul(n));
      left -= n;
    }
    if (left === 0) return { revenue, source: 'CUSTOMER_LOTS' as const };
  }
  const [agg] = await prisma.$queryRaw<{ revenue: unknown; credits: unknown }[]>`
    SELECT COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(credits), 0) AS credits FROM sms_recipients
    WHERE status IN (${Prisma.join(REALIZED_STATUSES)}) AND refunded = FALSE`;
  const total = Number(agg?.credits ?? 0);
  if (!total) return null;
  return { revenue: D(String(agg.revenue ?? 0)).div(total).mul(credits), source: 'PLATFORM_AVERAGE' as const };
}
