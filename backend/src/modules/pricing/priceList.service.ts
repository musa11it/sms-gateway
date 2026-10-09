import { Prisma, type MessageDirection, type PricingMetric, type RateApplication, type SmsPriceList, type SmsPricingTier } from '@prisma/client';
import { z } from 'zod';
import { prisma, type Db } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { audit } from '../audit-logs/audit.service';

/**
 * Pricing configurations and the one pricing engine every SMS purchase uses (general credits and
 * network lines, customer quotes and checkout).
 *
 * A price list = (network or general) × service × direction. Its configuration (SmsPriceList) says:
 *   - pricingMetric: which volume selects the tier
 *       PURCHASE_QUANTITY          the quantity of this purchase line
 *       MONTHLY_PURCHASE_QUANTITY  the quantity already bought for this price list in the current calendar
 *                                  month (UTC, successful payments only) plus this line
 *   - rateApplication: how tier rates apply
 *       WHOLE_PURCHASE  every unit at the rate of the tier the line's end volume falls in
 *       GRADUATED       each unit at the rate of the tier its own position falls in
 *   - limits (min/max per line), customer notes and an active flag.
 * There are no fees: a line costs its SMS × their price, nothing more.
 * Without a configuration row the defaults apply: purchase quantity, whole purchase, active —
 * exactly how every price worked before configurations existed.
 */

export type PriceRule = Pick<SmsPriceList, 'pricingMetric' | 'rateApplication' | 'minPurchaseQuantity' | 'maxPurchaseQuantity' | 'isActive' | 'customerNotes'> & { id: string | null };

export const DEFAULT_RULE: PriceRule = {
  id: null,
  pricingMetric: 'PURCHASE_QUANTITY',
  rateApplication: 'WHOLE_PURCHASE',
  minPurchaseQuantity: null,
  maxPurchaseQuantity: null,
  isActive: true,
  customerNotes: null,
};

export const scopeKey = (networkId: string | null, direction: MessageDirection = 'OUTBOUND', service = 'BULK_SMS') => `${networkId ?? 'general'}:${service}:${direction}`;

export async function ruleFor(db: Db, networkId: string | null, direction: MessageDirection = 'OUTBOUND'): Promise<PriceRule> {
  return (await db.smsPriceList.findUnique({ where: { scopeKey: scopeKey(networkId, direction) } })) ?? DEFAULT_RULE;
}

export async function rulesByKey(db: Db) {
  const rows = await db.smsPriceList.findMany();
  return (networkId: string | null, direction: MessageDirection = 'OUTBOUND'): PriceRule => rows.find((r) => r.scopeKey === scopeKey(networkId, direction)) ?? DEFAULT_RULE;
}

const fmtRange = (t: Pick<SmsPricingTier, 'minQuantity' | 'maxQuantity'>) =>
  t.maxQuantity === null ? `${t.minQuantity.toLocaleString()}+` : `${t.minQuantity.toLocaleString()}–${t.maxQuantity.toLocaleString()}`;

export interface BreakdownRow {
  tierId: string;
  label: string;
  units: number;
  unitPrice: string;
  amount: string;
}

export type LinePrice =
  | {
      ok: true;
      /** Tier containing the line's end volume (the tier the customer "is in"). */
      tier: SmsPricingTier;
      /** Exact tier price (whole purchase) or average price per SMS (graduated), 4 dp. */
      unitPrice: Prisma.Decimal;
      subtotal: Prisma.Decimal;
      breakdown: BreakdownRow[];
      volumeBefore: number;
      currency: string;
    }
  | { ok: false; code: string; message: string; field: 'quantity' | 'networkId' };

/**
 * Price `quantity` units against active, effective tiers under a rule. Pure: money is Decimal throughout.
 * `volumeBefore` is the metric volume already counted (monthly metric only; 0 otherwise).
 */
export function priceQuantity(tiers: SmsPricingTier[], rule: PriceRule, quantity: number, volumeBefore = 0, label = 'This price list'): LinePrice {
  if (!rule.isActive) return { ok: false, code: 'PRICE_LIST_INACTIVE', message: `${label}: prices are not currently offered`, field: 'networkId' };
  if (!tiers.length) return { ok: false, code: 'NO_PRICING_TIER', message: `${label}: no price is configured. Please contact support.`, field: 'networkId' };
  if (rule.minPurchaseQuantity !== null && quantity < rule.minPurchaseQuantity) return { ok: false, code: 'QUANTITY_BELOW_MINIMUM', message: `${label}: the minimum purchase is ${rule.minPurchaseQuantity.toLocaleString()} SMS`, field: 'quantity' };
  if (rule.maxPurchaseQuantity !== null && quantity > rule.maxPurchaseQuantity) return { ok: false, code: 'QUANTITY_ABOVE_MAXIMUM', message: `${label}: the maximum purchase is ${rule.maxPurchaseQuantity.toLocaleString()} SMS`, field: 'quantity' };

  const sorted = [...tiers].sort((a, b) => a.minQuantity - b.minQuantity);
  const before = rule.pricingMetric === 'MONTHLY_PURCHASE_QUANTITY' ? volumeBefore : 0;
  const start = before + 1;
  const end = before + quantity;
  const contains = (t: SmsPricingTier, v: number) => v >= t.minQuantity && (t.maxQuantity === null || v <= t.maxQuantity);
  const endTier = sorted.find((t) => contains(t, end));
  const outOfRange = (): LinePrice => {
    const min = sorted[0].minQuantity;
    const max = sorted.every((t) => t.maxQuantity !== null) ? Math.max(...sorted.map((t) => t.maxQuantity!)) : null;
    const monthly = rule.pricingMetric === 'MONTHLY_PURCHASE_QUANTITY' ? ' (counting this month’s purchases)' : '';
    if (end < min) return { ok: false, code: 'QUANTITY_BELOW_MINIMUM', message: `${label}: the minimum purchase is ${(min - before).toLocaleString()} SMS${monthly}`, field: 'quantity' };
    if (max !== null && end > max) return { ok: false, code: 'QUANTITY_ABOVE_MAXIMUM', message: `${label}: at most ${Math.max(0, max - before).toLocaleString()} more SMS can be bought${monthly}`, field: 'quantity' };
    return { ok: false, code: 'NO_PRICING_TIER', message: `${label}: no price is configured for ${quantity.toLocaleString()} SMS. Please contact support.`, field: 'quantity' };
  };
  if (!endTier) return outOfRange();

  let breakdown: BreakdownRow[];
  if (rule.rateApplication === 'WHOLE_PURCHASE') {
    const amount = endTier.unitPrice.mul(quantity);
    breakdown = [{ tierId: endTier.id, label: fmtRange(endTier), units: quantity, unitPrice: endTier.unitPrice.toFixed(4), amount: amount.toFixed(4) }];
  } else {
    breakdown = [];
    for (const t of sorted) {
      const lo = Math.max(start, t.minQuantity);
      const hi = Math.min(end, t.maxQuantity ?? Number.POSITIVE_INFINITY);
      if (hi < lo) continue;
      const units = hi - lo + 1;
      breakdown.push({ tierId: t.id, label: fmtRange(t), units, unitPrice: t.unitPrice.toFixed(4), amount: t.unitPrice.mul(units).toFixed(4) });
    }
    // Every unit must sit in a tier: a gap between ranges has no price.
    if (breakdown.reduce((s, b) => s + b.units, 0) !== quantity) return outOfRange();
  }
  const subtotal = breakdown.reduce((s, b) => s.plus(b.amount), new Prisma.Decimal(0)).toDecimalPlaces(2);
  const unitPrice = rule.rateApplication === 'WHOLE_PURCHASE' ? new Prisma.Decimal(endTier.unitPrice) : subtotal.div(quantity).toDecimalPlaces(4);
  return { ok: true, tier: endTier, unitPrice, subtotal, breakdown, volumeBefore: before, currency: endTier.currency };
}

/** First instant of the current calendar month (UTC): the window of the monthly metric. */
export const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Quantity an organization bought for a price list this month (successful payments only). */
export async function monthlyVolume(db: Db, organizationId: string, networkId: string | null, direction: MessageDirection = 'OUTBOUND') {
  const since = monthStart();
  if (networkId) {
    const r = await db.paymentItem.aggregate({ where: { networkId, direction, payment: { organizationId, status: 'SUCCESS', createdAt: { gte: since } } }, _sum: { quantity: true } });
    return r._sum.quantity ?? 0;
  }
  const r = await db.payment.aggregate({ where: { organizationId, status: 'SUCCESS', createdAt: { gte: since }, pricingTierId: { not: null } }, _sum: { credits: true } });
  return r._sum.credits ?? 0;
}

export function serializeRule(rule: PriceRule) {
  return {
    id: rule.id,
    pricingMetric: rule.pricingMetric,
    rateApplication: rule.rateApplication,
    minPurchaseQuantity: rule.minPurchaseQuantity,
    maxPurchaseQuantity: rule.maxPurchaseQuantity,
    customerNotes: rule.customerNotes,
    isActive: rule.isActive,
  };
}

export const METRIC_TEXT: Record<PricingMetric, string> = {
  PURCHASE_QUANTITY: 'Tier set by the quantity in this purchase',
  MONTHLY_PURCHASE_QUANTITY: 'Tier set by the quantity you buy for this network in the calendar month (UTC), this purchase included',
};

export const RATE_TEXT: Record<RateApplication, string> = {
  WHOLE_PURCHASE: 'The tier rate applies to the whole purchase',
  GRADUATED: 'Each tier rate applies only to the SMS inside that tier (graduated)',
};

// ── Admin ────────────────────────────────────────────────────────────────

export const priceListBody = z
  .object({
    networkId: z.string().uuid().nullable(),
    direction: z.enum(['OUTBOUND', 'INBOUND']).default('OUTBOUND'),
    pricingMetric: z.enum(['PURCHASE_QUANTITY', 'MONTHLY_PURCHASE_QUANTITY']).optional(),
    rateApplication: z.enum(['WHOLE_PURCHASE', 'GRADUATED']).optional(),
    minPurchaseQuantity: z.coerce.number().int().min(1).max(100_000_000).nullable().optional(),
    maxPurchaseQuantity: z.coerce.number().int().min(1).max(100_000_000).nullable().optional(),
    customerNotes: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

/** Create or update the configuration of one price list (audited with before/after). */
export async function upsertPriceList(input: z.infer<typeof priceListBody>, actor: Actor, meta?: RequestMeta) {
  const { reason, ...data } = input;
  if (data.networkId) {
    const network = await prisma.smsNetwork.findUnique({ where: { id: data.networkId } });
    if (!network) throw AppError.unprocessable('Unknown destination network', 'UNKNOWN_NETWORK', [{ field: 'networkId', message: 'Unknown network' }]);
    if (data.direction === 'INBOUND' && !network.supportsInbound) throw AppError.unprocessable(`${network.name} does not offer inbound SMS`, 'INBOUND_NOT_SUPPORTED', [{ field: 'direction', message: 'Network does not offer inbound SMS' }]);
  } else if (data.direction === 'INBOUND') {
    throw AppError.unprocessable('Inbound prices must belong to a destination network', 'INBOUND_NEEDS_NETWORK', [{ field: 'networkId', message: 'Required for inbound prices' }]);
  }
  const key = scopeKey(data.networkId, data.direction);
  return prisma.$transaction(async (tx) => {
    const before = await tx.smsPriceList.findUnique({ where: { scopeKey: key } });
    const next = {
      pricingMetric: data.pricingMetric ?? before?.pricingMetric ?? 'PURCHASE_QUANTITY',
      rateApplication: data.rateApplication ?? before?.rateApplication ?? 'WHOLE_PURCHASE',
      minPurchaseQuantity: data.minPurchaseQuantity !== undefined ? data.minPurchaseQuantity : (before?.minPurchaseQuantity ?? null),
      maxPurchaseQuantity: data.maxPurchaseQuantity !== undefined ? data.maxPurchaseQuantity : (before?.maxPurchaseQuantity ?? null),
      customerNotes: data.customerNotes !== undefined ? data.customerNotes : (before?.customerNotes ?? null),
      isActive: data.isActive ?? before?.isActive ?? true,
    };
    if (next.minPurchaseQuantity !== null && next.maxPurchaseQuantity !== null && next.maxPurchaseQuantity < next.minPurchaseQuantity) {
      throw AppError.unprocessable('The maximum must be greater than or equal to the minimum', 'INVALID_LIMITS', [{ field: 'maxPurchaseQuantity', message: 'Must be ≥ minimum' }]);
    }
    const row = await tx.smsPriceList.upsert({
      where: { scopeKey: key },
      create: { scopeKey: key, networkId: data.networkId, direction: data.direction, ...next, createdById: actorUserId(actor), updatedById: actorUserId(actor) },
      update: { ...next, updatedById: actorUserId(actor) },
    });
    await audit(
      {
        actor,
        action: before ? 'PRICE_LIST_UPDATED' : 'PRICE_LIST_CREATED',
        resource: 'sms_price_list',
        resourceId: row.id,
        metadata: { scopeKey: key, networkId: data.networkId, direction: data.direction, before: before ? serializeRule({ ...before }) : null, after: serializeRule({ ...row }), reason },
        meta,
      },
      tx,
    );
    return row;
  });
}
