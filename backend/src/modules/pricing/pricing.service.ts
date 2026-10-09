import { Prisma, type SmsPricingTier } from '@prisma/client';
import { z } from 'zod';
import { prisma, type Db, type Tx } from '../../config/prisma';
import { SmsProviderFactory } from '../../integrations/sms/SmsProviderFactory';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { audit } from '../audit-logs/audit.service';
import { getSetting } from '../settings/settings.service';
import { METRIC_TEXT, RATE_TEXT, monthlyVolume, priceQuantity, ruleFor } from './priceList.service';

/**
 * Volume pricing for any-quantity SMS purchases.
 *
 * Simple tier price: the tier whose [minQuantity, maxQuantity] range contains the purchased
 * quantity sets the unit price for the whole purchase (2,000 SMS in the 1,001–5,000 tier at
 * RWF 11 = RWF 22,000; not 1,000 × 13 + 1,000 × 11). Active tiers never overlap, so at most one
 * tier applies. Prices always come from the database; clients never submit a price.
 *
 * Price lists: tiers with networkId = null price general credits (usable on any network — the
 * original product); tiers with a networkId price credits for that destination network only (see
 * networkPricing.service.ts). Overlap rules apply within one list (network + direction), and only
 * between tiers whose effective periods overlap, so a future price can be scheduled in advance.
 * Past purchases keep the price frozen on their payment, payment items and credit lots.
 */

export const MAX_PURCHASE_QUANTITY = 100_000_000;

const money = z.string().trim().regex(/^\d{1,10}(\.\d{1,4})?$/, 'Enter an amount such as 9 or 8.50');

export const tierBody = z
  .object({
    name: z.string().trim().max(80).optional().nullable(),
    // null/omitted = general credits; a network id = credits for that destination network only.
    networkId: z.string().uuid().nullable().optional(),
    direction: z.enum(['OUTBOUND', 'INBOUND']).optional(),
    effectiveFrom: z.coerce.date().nullable().optional(),
    effectiveTo: z.coerce.date().nullable().optional(),
    minQuantity: z.coerce.number().int().min(1).max(MAX_PURCHASE_QUANTITY),
    maxQuantity: z.coerce.number().int().min(1).max(MAX_PURCHASE_QUANTITY).nullable().optional(),
    unitPrice: money,
    currency: z.string().trim().length(3).toUpperCase().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
  })
  .strict();

export const quantitySchema = z.coerce
  .number({ invalid_type_error: 'Enter a whole number of SMS' })
  .int('Enter a whole number of SMS')
  .min(1, 'Buy at least 1 SMS')
  .max(MAX_PURCHASE_QUANTITY, `At most ${MAX_PURCHASE_QUANTITY.toLocaleString()} SMS per purchase`);

export function serializeTier(t: SmsPricingTier & { network?: { name: string; countryCode: string } | null }) {
  return {
    id: t.id,
    name: t.name,
    networkId: t.networkId,
    network: t.network ? { name: t.network.name, countryCode: t.network.countryCode } : null,
    direction: t.direction,
    effectiveFrom: t.effectiveFrom,
    effectiveTo: t.effectiveTo,
    minQuantity: t.minQuantity,
    maxQuantity: t.maxQuantity,
    unitPrice: t.unitPrice.toFixed(2),
    currency: t.currency,
    isActive: t.isActive,
    sortOrder: t.sortOrder,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** Tiers whose effective period contains `at` (null bounds are open). */
export const effectiveAt = (at: Date): Prisma.SmsPricingTierWhereInput => ({
  AND: [{ OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: at } }] }, { OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] }],
});

/** Current general-credit tiers (no network, outbound, effective now). */
export async function activeTiers(db: Db = prisma, at = new Date()) {
  return db.smsPricingTier.findMany({ where: { isActive: true, networkId: null, direction: 'OUTBOUND', ...effectiveAt(at) }, orderBy: { minQuantity: 'asc' } });
}

const fmtRange = (t: Pick<SmsPricingTier, 'minQuantity' | 'maxQuantity'>) =>
  t.maxQuantity === null ? `${t.minQuantity.toLocaleString()}+` : `${t.minQuantity.toLocaleString()}–${t.maxQuantity.toLocaleString()}`;

/**
 * Server-side price of a purchase of `quantity` general SMS credits, under the general price list's
 * configuration (pricing metric, rate application, limits). `organizationId` is needed for the
 * monthly metric; without it (anonymous estimates) no earlier purchases are counted.
 */
export async function calculateSmsPurchasePrice(quantityInput: unknown, db: Db = prisma, opts: { organizationId?: string } = {}) {
  const parsed = quantitySchema.safeParse(quantityInput);
  if (!parsed.success) throw AppError.unprocessable(parsed.error.issues[0].message, 'INVALID_QUANTITY', [{ field: 'quantity', message: parsed.error.issues[0].message }]);
  const quantity = parsed.data;

  const tiers = await activeTiers(db);
  const rule = await ruleFor(db, null);
  const before = rule.pricingMetric === 'MONTHLY_PURCHASE_QUANTITY' && opts.organizationId ? await monthlyVolume(db, opts.organizationId, null) : 0;
  const line = priceQuantity(tiers, rule, quantity, before, 'General credits');
  if (!line.ok) {
    if (line.code === 'NO_PRICING_TIER' || line.code === 'PRICE_LIST_INACTIVE') throw AppError.unprocessable(`No price is configured for ${quantity.toLocaleString()} SMS. Please contact support.`, 'NO_PRICING_TIER');
    throw AppError.unprocessable(line.message, line.code, [{ field: 'quantity', message: line.message }]);
  }
  const tier = line.tier;
  const unitPrice = line.unitPrice;
  const total = line.subtotal;
  // Savings against the highest active unit price in the same currency (the base rate).
  const base = tiers.filter((t) => t.currency === tier.currency).reduce((m, t) => (t.unitPrice.gt(m) ? new Prisma.Decimal(t.unitPrice) : m), unitPrice);
  const savings = base.gt(unitPrice)
    ? { comparedToUnitPrice: base.toFixed(2), amount: base.mul(quantity).toDecimalPlaces(2).minus(total).toFixed(2), percent: base.minus(unitPrice).div(base).mul(100).toDecimalPlaces(1).toNumber() }
    : null;

  return {
    quantity,
    tier: { id: tier.id, name: tier.name, minQuantity: tier.minQuantity, maxQuantity: tier.maxQuantity, label: fmtRange(tier) },
    unitPrice: rule.rateApplication === 'WHOLE_PURCHASE' ? unitPrice.toFixed(2) : unitPrice.toFixed(4),
    subtotal: total.toFixed(2),
    savings,
    total: total.toFixed(2),
    currency: tier.currency,
    pricing: { priceListId: rule.id, metric: rule.pricingMetric, rateApplication: rule.rateApplication, metricText: METRIC_TEXT[rule.pricingMetric], rateText: RATE_TEXT[rule.rateApplication], volumeBefore: line.volumeBefore, breakdown: line.breakdown },
  };
}

export type PriceQuote = Awaited<ReturnType<typeof calculateSmsPurchasePrice>>;

type TierCandidate = {
  id?: string;
  networkId: string | null;
  direction: 'OUTBOUND' | 'INBOUND';
  minQuantity: number;
  maxQuantity: number | null;
  currency: string;
  isActive: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
};

/** Serialise all tier writes; refuse overlapping active ranges within one price list and period. */
async function assertNoOverlap(tx: Tx, candidate: TierCandidate) {
  // Lock the whole table (next-key locks also block concurrent inserts).
  await tx.$queryRaw`SELECT id FROM sms_pricing_tiers FOR UPDATE`;
  if (candidate.maxQuantity !== null && candidate.maxQuantity < candidate.minQuantity) {
    throw AppError.unprocessable('The maximum quantity must be greater than or equal to the minimum', 'INVALID_TIER_RANGE', [{ field: 'maxQuantity', message: 'Must be ≥ minimum' }]);
  }
  if (candidate.effectiveFrom && candidate.effectiveTo && candidate.effectiveTo <= candidate.effectiveFrom) {
    throw AppError.unprocessable('The end of the effective period must be after its start', 'INVALID_EFFECTIVE_PERIOD', [{ field: 'effectiveTo', message: 'Must be after the start' }]);
  }
  if (candidate.networkId) {
    const network = await tx.smsNetwork.findUnique({ where: { id: candidate.networkId } });
    if (!network) throw AppError.unprocessable('Unknown destination network', 'UNKNOWN_NETWORK', [{ field: 'networkId', message: 'Unknown network' }]);
    if (candidate.direction === 'INBOUND' && !network.supportsInbound) {
      throw AppError.unprocessable(`${network.name} does not offer inbound SMS; enable inbound on the network first`, 'INBOUND_NOT_SUPPORTED', [{ field: 'direction', message: 'Network does not offer inbound SMS' }]);
    }
  } else if (candidate.direction === 'INBOUND') {
    throw AppError.unprocessable('Inbound prices must belong to a destination network', 'INBOUND_NEEDS_NETWORK', [{ field: 'networkId', message: 'Required for inbound prices' }]);
  }
  if (!candidate.isActive) return;
  const all = await tx.smsPricingTier.findMany({ where: { isActive: true } });
  const others = all.filter((t) => t.id !== candidate.id);
  const hi = (v: number | null) => v ?? Number.POSITIVE_INFINITY;
  const time = (d: Date | null, open: number) => d?.getTime() ?? open;
  const periodsOverlap = (t: { effectiveFrom: Date | null; effectiveTo: Date | null }) =>
    time(t.effectiveFrom, -Infinity) < time(candidate.effectiveTo, Infinity) && time(candidate.effectiveFrom, -Infinity) < time(t.effectiveTo, Infinity);
  const clash = others.find(
    (t) =>
      t.networkId === candidate.networkId &&
      t.direction === candidate.direction &&
      periodsOverlap(t) &&
      t.minQuantity <= hi(candidate.maxQuantity) &&
      candidate.minQuantity <= hi(t.maxQuantity),
  );
  if (clash) throw AppError.conflict(`This range overlaps the active tier ${fmtRange(clash)} of the same price list and period. Adjust, end-date or deactivate that tier first.`, 'TIER_OVERLAP');
  // One currency for every active price: wallet credits, revenue and invoices are all in it.
  const otherCurrency = others.find((t) => t.currency !== candidate.currency);
  if (otherCurrency) throw AppError.conflict(`Active tiers must share one currency (existing tiers use ${otherCurrency.currency})`, 'TIER_CURRENCY_MISMATCH');
}

export async function createTier(input: z.infer<typeof tierBody>, actor: Actor, meta?: RequestMeta) {
  const currency = input.currency ?? (await getSetting('billing.currency'));
  return prisma.$transaction(async (tx) => {
    const data = {
      name: input.name ?? null,
      networkId: input.networkId ?? null,
      direction: input.direction ?? ('OUTBOUND' as const),
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      minQuantity: input.minQuantity,
      maxQuantity: input.maxQuantity ?? null,
      unitPrice: new Prisma.Decimal(input.unitPrice),
      currency,
      isActive: input.isActive ?? true,
      sortOrder: input.sortOrder ?? 0,
    };
    await assertNoOverlap(tx, data);
    const tier = await tx.smsPricingTier.create({ data: { ...data, createdById: actorUserId(actor), updatedById: actorUserId(actor) } });
    await audit({ actor, action: 'PRICING_TIER_CREATED', resource: 'sms_pricing_tier', resourceId: tier.id, metadata: { tier: serializeTier(tier) }, meta }, tx);
    return tier;
  });
}

export async function updateTier(id: string, input: Partial<z.infer<typeof tierBody>>, actor: Actor, meta?: RequestMeta) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.smsPricingTier.findUnique({ where: { id }, include: { _count: { select: { payments: true, paymentItems: true } } } });
    if (!before) throw AppError.notFound('Pricing tier');
    // A sold tier keeps describing what was sold: its price list cannot be moved to another network.
    const sold = before._count.payments + before._count.paymentItems > 0;
    if (sold && ((input.networkId !== undefined && input.networkId !== before.networkId) || (input.direction !== undefined && input.direction !== before.direction))) {
      throw AppError.conflict('This tier has been used by purchases; its network and direction cannot change. Deactivate it and create a new tier instead.', 'TIER_IN_USE');
    }
    const next = {
      name: input.name !== undefined ? input.name : before.name,
      networkId: input.networkId !== undefined ? input.networkId : before.networkId,
      direction: input.direction ?? before.direction,
      effectiveFrom: input.effectiveFrom !== undefined ? input.effectiveFrom : before.effectiveFrom,
      effectiveTo: input.effectiveTo !== undefined ? input.effectiveTo : before.effectiveTo,
      minQuantity: input.minQuantity ?? before.minQuantity,
      maxQuantity: input.maxQuantity !== undefined ? input.maxQuantity : before.maxQuantity,
      unitPrice: input.unitPrice !== undefined ? new Prisma.Decimal(input.unitPrice) : before.unitPrice,
      currency: input.currency ?? before.currency,
      isActive: input.isActive ?? before.isActive,
      sortOrder: input.sortOrder ?? before.sortOrder,
    };
    await assertNoOverlap(tx, { id, ...next });
    const tier = await tx.smsPricingTier.update({ where: { id }, data: { ...next, updatedById: actorUserId(actor) } });
    const priceChanged = !before.unitPrice.equals(tier.unitPrice);
    await audit(
      {
        actor,
        action: input.isActive === false && before.isActive ? 'PRICING_TIER_DEACTIVATED' : input.isActive === true && !before.isActive ? 'PRICING_TIER_ACTIVATED' : priceChanged ? 'PRICING_CHANGED' : 'PRICING_TIER_UPDATED',
        resource: 'sms_pricing_tier',
        resourceId: id,
        metadata: { before: serializeTier(before), after: serializeTier(tier) },
        meta,
      },
      tx,
    );
    return tier;
  });
}

/** Only tiers never used by a purchase can be deleted; used tiers are deactivated instead. */
// ── Price ladder ───────────────────────────────────────────────────────

export const ladderBody = z
  .object({
    networkId: z.string().uuid().nullable(),
    steps: z
      .array(z.object({ minQuantity: z.coerce.number().int().min(1).max(MAX_PURCHASE_QUANTITY), unitPrice: money, name: z.string().trim().max(80).optional().nullable() }).strict())
      .min(1, 'Add at least one price')
      .max(20, 'At most 20 prices'),
  })
  .strict();

/**
 * Replace a price list's current prices with a simple ladder: "from N SMS → price per SMS". Each step
 * runs until the next one starts, so ranges never overlap or leave gaps. Prices already used by purchases
 * are deactivated (kept for history), unused ones are removed. One audited change.
 */
export async function setPriceLadder(input: z.infer<typeof ladderBody>, actor: Actor, meta?: RequestMeta) {
  const steps = [...input.steps].sort((a, b) => a.minQuantity - b.minQuantity);
  if (new Set(steps.map((s) => s.minQuantity)).size !== steps.length) {
    throw AppError.unprocessable('Two prices start at the same quantity', 'DUPLICATE_STEP', [{ field: 'steps', message: 'Each price needs its own starting quantity' }]);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sms_pricing_tiers FOR UPDATE`;
    if (input.networkId && !(await tx.smsNetwork.findUnique({ where: { id: input.networkId } }))) throw AppError.unprocessable('Unknown destination network', 'UNKNOWN_NETWORK', [{ field: 'networkId', message: 'Unknown network' }]);
    const current = await tx.smsPricingTier.findMany({
      where: { networkId: input.networkId, direction: 'OUTBOUND', service: 'BULK_SMS', isActive: true },
      include: { _count: { select: { payments: true, paymentItems: true } } },
    });
    const anyActive = await tx.smsPricingTier.findFirst({ where: { isActive: true, id: { notIn: current.map((t) => t.id) } }, select: { currency: true } });
    const currency = anyActive?.currency ?? current[0]?.currency ?? (await getSetting('billing.currency'));
    for (const t of current) {
      if (t._count.payments + t._count.paymentItems > 0) await tx.smsPricingTier.update({ where: { id: t.id }, data: { isActive: false, updatedById: actorUserId(actor) } });
      else await tx.smsPricingTier.delete({ where: { id: t.id } });
    }
    const created = [];
    for (const [i, s] of steps.entries()) {
      created.push(
        await tx.smsPricingTier.create({
          data: {
            name: s.name || null,
            networkId: input.networkId,
            minQuantity: s.minQuantity,
            maxQuantity: steps[i + 1] ? steps[i + 1].minQuantity - 1 : null,
            unitPrice: new Prisma.Decimal(s.unitPrice),
            currency,
            sortOrder: i,
            createdById: actorUserId(actor),
            updatedById: actorUserId(actor),
          },
        }),
      );
    }
    await audit(
      {
        actor,
        action: 'PRICE_LADDER_UPDATED',
        resource: 'sms_price_list',
        resourceId: input.networkId ?? 'general',
        metadata: { networkId: input.networkId, before: current.map((t) => ({ from: t.minQuantity, to: t.maxQuantity, unitPrice: t.unitPrice.toFixed(2) })), after: created.map((t) => ({ from: t.minQuantity, to: t.maxQuantity, unitPrice: t.unitPrice.toFixed(2) })) },
        meta,
      },
      tx,
    );
    return created;
  });
}

export async function deleteTier(id: string, actor: Actor, meta?: RequestMeta) {
  const tier = await prisma.smsPricingTier.findUnique({ where: { id }, include: { _count: { select: { payments: true, paymentItems: true } } } });
  if (!tier) throw AppError.notFound('Pricing tier');
  const used = tier._count.payments + tier._count.paymentItems;
  if (used > 0) {
    throw AppError.conflict(`This tier was used by ${used.toLocaleString()} purchase(s) and cannot be deleted. Deactivate it instead.`, 'TIER_IN_USE');
  }
  await prisma.$transaction(async (tx) => {
    await tx.smsPricingTier.delete({ where: { id } });
    await audit({ actor, action: 'PRICING_TIER_DELETED', resource: 'sms_pricing_tier', resourceId: id, metadata: { tier: serializeTier(tier) }, meta }, tx);
  });
}

// ── Profit planning ────────────────────────────────────────────────────

/**
 * How each price range compares with what the SMS actually costs us.
 *
 *   cost per credit   C = provider cost per segment ÷ credits per segment
 *                     expected: average cost of the remaining capacity lots of routable providers
 *                     worst case: the most expensive routable provider (traffic can fall back to it)
 *   payment fee rate  f = actual fees ÷ amounts of successful payments (fallback: configured %)
 *   margin per credit   = P − P·f − C
 *   break-even price    = C ÷ (1 − f)
 *   price for target m  = C ÷ (1 − f − m)
 *
 * All inputs are read from stored data; nothing here changes prices.
 */
export async function pricingEconomics() {
  const [tiers, providers, lots, paid, routed, creditsPerSegment, feeSetting, tierSales, itemSales] = await Promise.all([
    prisma.smsPricingTier.findMany({ orderBy: [{ isActive: 'desc' }, { minQuantity: 'asc' }], include: { network: { select: { name: true, countryCode: true } } } }),
    prisma.smsProvider.findMany({ where: { status: 'ACTIVE', health: { not: 'DOWN' } } }),
    prisma.$queryRaw<{ providerId: string; remaining: unknown; value: unknown; maxCost: unknown }[]>`
      SELECT providerId, SUM(remaining) AS remaining, SUM(remaining * unitCost) AS value, MAX(CASE WHEN remaining > 0 THEN unitCost END) AS maxCost
      FROM provider_capacity_lots GROUP BY providerId`,
    prisma.payment.aggregate({ where: { status: 'SUCCESS' }, _sum: { amount: true, feeAmount: true } }),
    prisma.smsRecipient.aggregate({ where: { capacityReleased: false, refunded: false, providerId: { not: null } }, _sum: { providerCost: true, credits: true } }),
    getSetting('sms.creditsPerSegment'),
    getSetting('billing.paymentFeePercent'),
    prisma.payment.groupBy({ by: ['pricingTierId'], where: { status: 'SUCCESS', pricingTierId: { not: null } }, _sum: { credits: true, amount: true, feeAmount: true }, _count: true }),
    // Network purchases: one line per network, priced by that network's tier.
    prisma.paymentItem.groupBy({ by: ['pricingTierId'], where: { payment: { status: 'SUCCESS' } }, _sum: { quantity: true, subtotal: true }, _count: true }),
  ]);

  const routable = providers.filter((p) => SmsProviderFactory.forProvider(p));
  const lotRows = lots.filter((l) => routable.some((p) => p.id === l.providerId));
  const remaining = lotRows.reduce((s, l) => s + Number(l.remaining ?? 0), 0);
  const value = lotRows.reduce((s, l) => s.plus(String(l.value ?? 0)), new Prisma.Decimal(0));
  const configured = routable.map((p) => new Prisma.Decimal(p.costPerSms));
  const lotMax = lotRows.filter((l) => l.maxCost != null).map((l) => new Prisma.Decimal(String(l.maxCost)));
  const perSegment = (v: Prisma.Decimal) => v.div(creditsPerSegment);

  const expectedSegment = remaining > 0 ? value.div(remaining) : configured.length ? Prisma.Decimal.min(...configured) : null;
  const worstSegment = configured.length || lotMax.length ? Prisma.Decimal.max(...configured, ...lotMax) : null;
  const expected = expectedSegment ? perSegment(expectedSegment) : null;
  const worst = worstSegment ? perSegment(worstSegment) : null;

  const paidAmount = new Prisma.Decimal(paid._sum.amount ?? 0);
  const feeRate = paidAmount.gt(0) ? new Prisma.Decimal(paid._sum.feeAmount ?? 0).div(paidAmount) : new Prisma.Decimal(feeSetting).div(100);
  const realizedCost = (routed._sum.credits ?? 0) > 0 ? new Prisma.Decimal(routed._sum.providerCost ?? 0).div(routed._sum.credits!) : null;

  const keep = new Prisma.Decimal(1).minus(feeRate);
  const priceFor = (cost: Prisma.Decimal | null, margin = 0) => {
    const denom = keep.minus(margin / 100);
    return cost && denom.gt(0) ? cost.div(denom).toDecimalPlaces(2, Prisma.Decimal.ROUND_UP) : null;
  };

  const active = tiers.filter((t) => t.isActive);
  const rows = tiers.map((t) => {
    const price = new Prisma.Decimal(t.unitPrice);
    const fee = price.mul(feeRate);
    const marginAt = (cost: Prisma.Decimal | null) => (cost ? price.minus(fee).minus(cost) : null);
    const m = marginAt(expected);
    const w = marginAt(worst);
    const sale = tierSales.find((x) => x.pricingTierId === t.id);
    const items = itemSales.find((x) => x.pricingTierId === t.id);
    const itemRevenue = new Prisma.Decimal(items?._sum.subtotal ?? 0);
    const soldCredits = (sale?._sum.credits ?? 0) + (items?._sum.quantity ?? 0);
    const revenue = new Prisma.Decimal(sale?._sum.amount ?? 0).plus(itemRevenue);
    // A payment's fee is not split by line: network lines carry their share at the platform fee rate.
    const fees = new Prisma.Decimal(sale?._sum.feeAmount ?? 0).plus(itemRevenue.mul(feeRate).toDecimalPlaces(2));
    const costBasis = realizedCost ?? expected;
    const projectedCost = costBasis ? costBasis.mul(soldCredits) : null;
    const lower = active.filter((x) => x.networkId === t.networkId && x.direction === t.direction && x.minQuantity < t.minQuantity).at(-1);
    return {
      tierId: t.id,
      name: t.name,
      networkId: t.networkId,
      network: t.network ? `${t.network.name} (${t.network.countryCode})` : null,
      direction: t.direction,
      effectiveFrom: t.effectiveFrom,
      effectiveTo: t.effectiveTo,
      minQuantity: t.minQuantity,
      maxQuantity: t.maxQuantity,
      isActive: t.isActive,
      unitPrice: price.toFixed(2),
      feePerCredit: fee.toFixed(4),
      expectedCostPerCredit: expected?.toFixed(4) ?? null,
      marginPerCredit: m?.toFixed(4) ?? null,
      marginPercent: m && price.gt(0) ? m.div(price).mul(100).toDecimalPlaces(1).toNumber() : null,
      worstCaseMarginPerCredit: w?.toFixed(4) ?? null,
      worstCaseMarginPercent: w && price.gt(0) ? w.div(price).mul(100).toDecimalPlaces(1).toNumber() : null,
      breakEvenPrice: priceFor(worst)?.toFixed(2) ?? null,
      sales: {
        purchases: (sale?._count ?? 0) + (items?._count ?? 0),
        credits: soldCredits,
        revenue: revenue.toFixed(2),
        paymentFees: fees.toFixed(2),
        projectedProviderCost: projectedCost?.toFixed(2) ?? null,
        projectedMargin: projectedCost ? revenue.minus(fees).minus(projectedCost).toFixed(2) : null,
      },
      warnings: [
        ...(w && w.lt(0) ? ['Below cost on the most expensive route'] : []),
        ...(m && m.lt(0) ? ['Below the expected cost'] : []),
        ...(t.isActive && lower && price.gt(lower.unitPrice) ? ['Costs more per SMS than a smaller range'] : []),
      ],
    };
  });

  return {
    inputs: {
      creditsPerSegment,
      paymentFeePercent: feeRate.mul(100).toDecimalPlaces(2).toNumber(),
      paymentFeeSource: paidAmount.gt(0) ? 'actual payments' : 'configured fallback',
      expectedCostPerCredit: expected?.toFixed(4) ?? null,
      worstCaseCostPerCredit: worst?.toFixed(4) ?? null,
      realizedCostPerCredit: realizedCost?.toFixed(4) ?? null,
      routableProviders: routable.map((p) => ({ id: p.id, name: p.name, costPerSegment: new Prisma.Decimal(p.costPerSms).toFixed(4) })),
      breakEvenPrice: priceFor(worst)?.toFixed(2) ?? null,
    },
    tiers: rows,
    formulas: {
      costPerCredit: 'provider cost per segment ÷ credits per segment',
      marginPerCredit: 'price − payment fee − cost per credit',
      breakEven: 'cost per credit ÷ (1 − fee %)',
      targetPrice: 'cost per credit ÷ (1 − fee % − target margin %)',
    },
  };
}
