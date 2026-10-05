import { Prisma, type SmsPricingTier } from '@prisma/client';
import { z } from 'zod';
import { prisma, type Db, type Tx } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { audit } from '../audit-logs/audit.service';
import { getSetting } from '../settings/settings.service';

/**
 * Volume pricing for any-quantity SMS purchases.
 *
 * Simple tier price: the tier whose [minQuantity, maxQuantity] range contains the purchased
 * quantity sets the unit price for the whole purchase (2,000 SMS in the 1,001–5,000 tier at
 * RWF 11 = RWF 22,000; not 1,000 × 13 + 1,000 × 11). Active tiers never overlap, so at most one
 * tier applies. Prices always come from the database; clients never submit a price.
 */

export const MAX_PURCHASE_QUANTITY = 100_000_000;

const money = z.string().trim().regex(/^\d{1,10}(\.\d{1,4})?$/, 'Enter an amount such as 9 or 8.50');

export const tierBody = z
  .object({
    name: z.string().trim().max(80).optional().nullable(),
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

export function serializeTier(t: SmsPricingTier) {
  return {
    id: t.id,
    name: t.name,
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

export async function activeTiers(db: Db = prisma) {
  return db.smsPricingTier.findMany({ where: { isActive: true }, orderBy: { minQuantity: 'asc' } });
}

const fmtRange = (t: Pick<SmsPricingTier, 'minQuantity' | 'maxQuantity'>) =>
  t.maxQuantity === null ? `${t.minQuantity.toLocaleString()}+` : `${t.minQuantity.toLocaleString()}–${t.maxQuantity.toLocaleString()}`;

/** Server-side price of a purchase of `quantity` SMS credits. */
export async function calculateSmsPurchasePrice(quantityInput: unknown, db: Db = prisma) {
  const parsed = quantitySchema.safeParse(quantityInput);
  if (!parsed.success) throw AppError.unprocessable(parsed.error.issues[0].message, 'INVALID_QUANTITY', [{ field: 'quantity', message: parsed.error.issues[0].message }]);
  const quantity = parsed.data;

  const tiers = await activeTiers(db);
  const tier = tiers.find((t) => quantity >= t.minQuantity && (t.maxQuantity === null || quantity <= t.maxQuantity));
  if (!tier) throw AppError.unprocessable(`No price is configured for ${quantity.toLocaleString()} SMS. Please contact support.`, 'NO_PRICING_TIER');

  const unitPrice = new Prisma.Decimal(tier.unitPrice);
  const total = unitPrice.mul(quantity).toDecimalPlaces(2);
  // Savings against the highest active unit price in the same currency (the base rate).
  const base = tiers.filter((t) => t.currency === tier.currency).reduce((m, t) => (t.unitPrice.gt(m) ? new Prisma.Decimal(t.unitPrice) : m), unitPrice);
  const savings = base.gt(unitPrice)
    ? { comparedToUnitPrice: base.toFixed(2), amount: base.mul(quantity).toDecimalPlaces(2).minus(total).toFixed(2), percent: base.minus(unitPrice).div(base).mul(100).toDecimalPlaces(1).toNumber() }
    : null;

  return {
    quantity,
    tier: { id: tier.id, name: tier.name, minQuantity: tier.minQuantity, maxQuantity: tier.maxQuantity, label: fmtRange(tier) },
    unitPrice: unitPrice.toFixed(2),
    subtotal: total.toFixed(2),
    savings,
    total: total.toFixed(2),
    currency: tier.currency,
  };
}

export type PriceQuote = Awaited<ReturnType<typeof calculateSmsPurchasePrice>>;

/** Serialise all tier writes and refuse overlapping active ranges. */
async function assertNoOverlap(tx: Tx, candidate: { id?: string; minQuantity: number; maxQuantity: number | null; currency: string; isActive: boolean }) {
  // Lock the whole table (next-key locks also block concurrent inserts).
  await tx.$queryRaw`SELECT id FROM sms_pricing_tiers FOR UPDATE`;
  if (candidate.maxQuantity !== null && candidate.maxQuantity < candidate.minQuantity) {
    throw AppError.unprocessable('The maximum quantity must be greater than or equal to the minimum', 'INVALID_TIER_RANGE', [{ field: 'maxQuantity', message: 'Must be ≥ minimum' }]);
  }
  if (!candidate.isActive) return;
  const others = (await activeTiers(tx)).filter((t) => t.id !== candidate.id);
  const hi = (v: number | null) => v ?? Number.POSITIVE_INFINITY;
  const clash = others.find((t) => t.minQuantity <= hi(candidate.maxQuantity) && candidate.minQuantity <= hi(t.maxQuantity));
  if (clash) throw AppError.conflict(`This range overlaps the active tier ${fmtRange(clash)}. Adjust or deactivate that tier first.`, 'TIER_OVERLAP');
  const otherCurrency = others.find((t) => t.currency !== candidate.currency);
  if (otherCurrency) throw AppError.conflict(`Active tiers must share one currency (existing tiers use ${otherCurrency.currency})`, 'TIER_CURRENCY_MISMATCH');
}

export async function createTier(input: z.infer<typeof tierBody>, actor: Actor, meta?: RequestMeta) {
  const currency = input.currency ?? (await getSetting('billing.currency'));
  return prisma.$transaction(async (tx) => {
    const data = {
      name: input.name ?? null,
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
    const before = await tx.smsPricingTier.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Pricing tier');
    const next = {
      name: input.name !== undefined ? input.name : before.name,
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
export async function deleteTier(id: string, actor: Actor, meta?: RequestMeta) {
  const tier = await prisma.smsPricingTier.findUnique({ where: { id }, include: { _count: { select: { payments: true } } } });
  if (!tier) throw AppError.notFound('Pricing tier');
  if (tier._count.payments > 0) {
    throw AppError.conflict(`This tier was used by ${tier._count.payments.toLocaleString()} purchase(s) and cannot be deleted. Deactivate it instead.`, 'TIER_IN_USE');
  }
  await prisma.$transaction(async (tx) => {
    await tx.smsPricingTier.delete({ where: { id } });
    await audit({ actor, action: 'PRICING_TIER_DELETED', resource: 'sms_pricing_tier', resourceId: id, metadata: { tier: serializeTier(tier) }, meta }, tx);
  });
}
