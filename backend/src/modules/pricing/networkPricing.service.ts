import { Prisma, type MessageDirection, type SmsPricingTier } from '@prisma/client';
import { z } from 'zod';
import { prisma, type Db } from '../../config/prisma';
import { AppError } from '../../utils/errors';
import { getSetting } from '../settings/settings.service';
import { callingCodeFor } from '../providers/destination.service';
import { loadRoutingContext, planRoute, type RoutingContext, type RoutingNetwork } from '../providers/routing.service';
import { effectiveAt, quantitySchema } from './pricing.service';
import { METRIC_TEXT, RATE_TEXT, monthlyVolume, priceQuantity, rulesByKey, serializeRule, type BreakdownRow, type PriceRule } from './priceList.service';

/**
 * Country/network SMS commerce: what a customer can buy for which destination network, at what
 * price, and whether the platform can actually deliver it.
 *
 *  - Price: the network's own price list (SmsPricingTier with networkId), active and effective now.
 *    The tier containing the quantity prices the whole line (same rule as general credits).
 *  - Availability: decided by the routing engine itself (planRoute), so "purchasable" and "sendable"
 *    can never disagree: the network must be active, not in maintenance, offer outbound SMS, and have
 *    at least one provider that is eligible for it under the routing rules (active, healthy, adapter
 *    installed, explicitly serving the network or its whole country, with usable capacity).
 *  - Everything is computed here, on the server. Clients only ever send network ids and quantities.
 *
 * Upstream provider costs and stock levels are internal: customers see an availability state, never
 * the provider, its cost or its remaining capacity.
 */

export type NetworkAvailability = 'AVAILABLE' | 'OUT_OF_STOCK' | 'NO_ROUTE' | 'NO_PRICE' | 'MAINTENANCE' | 'OUTBOUND_UNAVAILABLE';

const AVAILABILITY_TEXT: Record<NetworkAvailability, string> = {
  AVAILABLE: 'Available',
  OUT_OF_STOCK: 'Temporarily out of stock — purchasing is paused for this network',
  NO_ROUTE: 'Not available for purchase: no delivery route is currently offered for this network',
  NO_PRICE: 'Not available for purchase: no selling price is configured for this network',
  MAINTENANCE: 'Temporarily unavailable (maintenance)',
  OUTBOUND_UNAVAILABLE: 'Outbound SMS is not offered on this network',
};

const PURCHASE_ERROR: Record<Exclude<NetworkAvailability, 'AVAILABLE'>, string> = {
  OUT_OF_STOCK: 'NETWORK_OUT_OF_STOCK',
  NO_ROUTE: 'NETWORK_NO_ROUTE',
  NO_PRICE: 'NETWORK_NOT_PRICED',
  MAINTENANCE: 'NETWORK_MAINTENANCE',
  OUTBOUND_UNAVAILABLE: 'NETWORK_OUTBOUND_UNAVAILABLE',
};

/** Active, currently effective tiers of one price list (networkId null = general credits). */
export async function currentTiers(db: Db, networkId: string | null, direction: MessageDirection = 'OUTBOUND', at = new Date()) {
  return db.smsPricingTier.findMany({ where: { isActive: true, networkId, direction, ...effectiveAt(at) }, orderBy: { minQuantity: 'asc' } });
}

const fmtRange = (t: Pick<SmsPricingTier, 'minQuantity' | 'maxQuantity'>) =>
  t.maxQuantity === null ? `${t.minQuantity.toLocaleString()}+` : `${t.minQuantity.toLocaleString()}–${t.maxQuantity.toLocaleString()}`;

export function publicTier(t: SmsPricingTier) {
  return { id: t.id, name: t.name, minQuantity: t.minQuantity, maxQuantity: t.maxQuantity, label: fmtRange(t), unitPrice: t.unitPrice.toFixed(2), currency: t.currency };
}

interface NetworkState {
  network: RoutingNetwork;
  tiers: SmsPricingTier[];
  rule: PriceRule;
  availability: NetworkAvailability;
  /** Provider segments usable for this network right now (internal: never sent to customers). */
  stock: number;
}

/** Availability of one network, from its price list and the routing engine. */
function evaluateNetwork(ctx: RoutingContext, network: RoutingNetwork, tiers: SmsPricingTier[], rule: PriceRule): NetworkState {
  const plan = planRoute(ctx, { network, countryCode: network.countryCode }, 1, new Map(ctx.providers.map((p) => [p.id, p.capacityBalance])));
  const capacityOnly = plan.candidates.filter((c) => c.reasonCodes.every((r) => r === 'INSUFFICIENT_CAPACITY' || r === 'BELOW_RESERVE'));
  const stock = capacityOnly.reduce((s, c) => s + c.available, 0);
  const availability: NetworkAvailability = network.inMaintenance
    ? 'MAINTENANCE'
    : !network.supportsOutbound
      ? 'OUTBOUND_UNAVAILABLE'
      : tiers.length === 0 || !rule.isActive
        ? 'NO_PRICE'
        : plan.selected
          ? 'AVAILABLE'
          : capacityOnly.length
            ? 'OUT_OF_STOCK'
            : 'NO_ROUTE';
  return { network, tiers, rule, availability, stock };
}

async function loadStates(db: Db, at = new Date()) {
  const ctx = await loadRoutingContext(db);
  const tiers = await db.smsPricingTier.findMany({ where: { isActive: true, direction: 'OUTBOUND', service: 'BULK_SMS', networkId: { not: null }, ...effectiveAt(at) }, orderBy: [{ sortOrder: 'asc' }, { minQuantity: 'asc' }] });
  const rule = await rulesByKey(db);
  const states = new Map(ctx.networks.map((n) => [n.id, evaluateNetwork(ctx, n, tiers.filter((t) => t.networkId === n.id), rule(n.id))]));
  return { ctx, states };
}

function customerNetwork(s: NetworkState) {
  const n = s.network;
  const t = s.tiers;
  const r = s.rule;
  const tierMin = t.length ? Math.min(...t.map((x) => x.minQuantity)) : null;
  const tierMax = t.length && t.every((x) => x.maxQuantity !== null) ? Math.max(...t.map((x) => x.maxQuantity!)) : null;
  const pick = (a: number | null, b: number | null, f: (x: number, y: number) => number) => (a === null ? b : b === null ? a : f(a, b));
  return {
    id: n.id,
    code: n.code,
    name: n.name,
    countryCode: n.countryCode,
    availability: s.availability,
    available: s.availability === 'AVAILABLE',
    availabilityText: s.availability === 'MAINTENANCE' && n.maintenanceNote ? `${AVAILABILITY_TEXT.MAINTENANCE}: ${n.maintenanceNote}` : AVAILABILITY_TEXT[s.availability],
    requiresSenderRegistration: n.requiresSenderRegistration,
    directions: { outbound: n.supportsOutbound, inbound: false },
    currency: t[0]?.currency ?? null,
    fromPrice: t.length ? t.reduce((m, x) => (x.unitPrice.lt(m) ? x.unitPrice : m), t[0].unitPrice).toFixed(2) : null,
    // Per purchase line. Under the monthly metric the tier minimum counts this month's purchases too.
    minQuantity: r.pricingMetric === 'MONTHLY_PURCHASE_QUANTITY' ? r.minPurchaseQuantity : pick(tierMin, r.minPurchaseQuantity, Math.max),
    maxQuantity: r.pricingMetric === 'MONTHLY_PURCHASE_QUANTITY' ? r.maxPurchaseQuantity : pick(tierMax, r.maxPurchaseQuantity, Math.min),
    tiers: t.map(publicTier),
    // The pricing rule, stated explicitly: customer selling prices per SMS segment.
    pricing: {
      service: 'BULK_SMS' as const,
      direction: 'OUTBOUND' as const,
      priceType: 'CUSTOMER_SELLING_PRICE' as const,
      unit: 'SMS segment',
      metric: r.pricingMetric,
      metricText: METRIC_TEXT[r.pricingMetric],
      rateApplication: r.rateApplication,
      rateText: RATE_TEXT[r.rateApplication],
      notes: r.customerNotes,
    },
  };
}

export type CatalogNetwork = ReturnType<typeof customerNetwork>;

/**
 * Countries and networks a customer can buy SMS for. A country is listed when at least one of its
 * networks is purchasable; its other active networks are listed too, with the reason they cannot be
 * bought (maintenance, out of stock…), so customers are never shown a price for something unavailable.
 */
export async function destinationCatalog(db: Db = prisma, opts: { includeUnavailableCountries?: boolean } = {}) {
  const { ctx, states } = await loadStates(db);
  const countries = ctx.countries
    .filter((c) => c.isActive)
    .map((c) => {
      const networks = ctx.networks
        .filter((n) => n.countryCode === c.isoCode)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .map((n) => customerNetwork(states.get(n.id)!));
      const available = networks.some((n) => n.available);
      return {
        isoCode: c.isoCode,
        name: c.name,
        callingCode: callingCodeFor(c.isoCode),
        available,
        // Only services the platform actually provides. Incoming/two-way SMS and shortcodes are not
        // implemented, so they are never listed (an inbound price in the database does not make them available).
        services: [{ key: 'BULK_SMS' as const, name: 'Bulk SMS', direction: 'OUTBOUND' as const, available }],
        networks,
      };
    })
    .filter((c) => c.available || (opts.includeUnavailableCountries && c.networks.length > 0));
  return { countries, currency: await getSetting('billing.currency') };
}

/**
 * Light, searchable country list (no tiers): clients load it page by page and fetch one country's
 * telecoms and prices only when it is opened, so hundreds of countries never load at once.
 * `defaultIsoCode` is the customer's home country: `prefer` (an ISO code or a country name, e.g. the
 * organization's country), else the country of the platform's default calling code, else the first on sale.
 */
export async function countryDirectory(opts: { search?: string; limit?: number; prefer?: string | null } = {}, db: Db = prisma) {
  const { countries, currency } = await destinationCatalog(db, { includeUnavailableCountries: true });
  const rows = countries.map((c) => {
    const onSale = c.networks.filter((n) => n.available);
    const prices = onSale.map((n) => n.fromPrice).filter((p): p is string => !!p);
    return {
      isoCode: c.isoCode,
      name: c.name,
      callingCode: c.callingCode,
      available: c.available,
      networkCount: c.networks.length,
      networksOnSale: onSale.length,
      fromPrice: prices.length ? prices.reduce((m, p) => (new Prisma.Decimal(p).lt(m) ? p : m)) : null,
    };
  });
  const prefer = opts.prefer?.trim().toLowerCase();
  const callingCode = await getSetting('sms.defaultCountryCode');
  const home =
    (prefer ? rows.find((c) => c.isoCode.toLowerCase() === prefer || c.name.toLowerCase() === prefer) : undefined) ??
    rows.find((c) => c.available && c.callingCode === callingCode) ??
    rows.find((c) => c.available) ??
    rows[0];
  const q = opts.search?.trim().toLowerCase();
  const matches = rows
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.isoCode.toLowerCase() === q || (!!c.callingCode && `+${c.callingCode}`.startsWith(q.startsWith('+') ? q : `+${q}`)))
    .sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  return { countries: matches.slice(0, limit), total: matches.length, defaultIsoCode: home?.isoCode ?? null, currency };
}

/** One country's networks (active ones), for the purchase page's second step. */
export async function countryNetworks(isoCode: string, db: Db = prisma) {
  const { countries } = await destinationCatalog(db, { includeUnavailableCountries: true });
  const country = countries.find((c) => c.isoCode === isoCode.toUpperCase());
  if (!country) throw AppError.notFound('Destination country');
  return country;
}

// ── Purchase quote ───────────────────────────────────────────────────────

export const MAX_PURCHASE_LINES = 20;

export const purchaseItemsSchema = z
  .array(z.object({ networkId: z.string().uuid('Choose a destination network'), quantity: z.unknown() }).strict())
  .min(1, 'Choose at least one destination network')
  .max(MAX_PURCHASE_LINES, `At most ${MAX_PURCHASE_LINES} networks per purchase`)
  .refine((items) => new Set(items.map((i) => i.networkId)).size === items.length, { message: 'Each network can appear only once; adjust its quantity instead' });

export interface QuoteLine {
  networkId: string;
  networkName: string;
  networkCode: string;
  countryCode: string;
  countryName: string;
  direction: MessageDirection;
  quantity: number;
  tier: { id: string; name: string | null; minQuantity: number; maxQuantity: number | null; label: string };
  /** Exact tier price (whole purchase) or average price per SMS segment (graduated). */
  unitPrice: string;
  subtotal: string;
  /** Equal to subtotal: there are no fees. Kept for clients that read `total`. */
  total: string;
  savings: { comparedToUnitPrice: string; amount: string; percent: number } | null;
  currency: string;
  pricing: { priceListId: string | null; metric: PriceRule['pricingMetric']; rateApplication: PriceRule['rateApplication']; volumeBefore: number; breakdown: BreakdownRow[] };
}

/**
 * Authoritative price of a multi-network purchase. Every line is priced from its own network's price
 * list; lines are never merged into one price. Any unavailable network, unpriced quantity or
 * insufficient deliverable capacity refuses the whole quote with a reason per line.
 */
export async function quoteNetworkPurchase(itemsInput: unknown, db: Db = prisma, opts: { organizationId?: string } = {}) {
  const parsed = purchaseItemsSchema.safeParse(itemsInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw AppError.unprocessable(issue.message, 'INVALID_PURCHASE_ITEMS', [{ field: ['items', ...issue.path].join('.'), message: issue.message }]);
  }
  const { ctx, states } = await loadStates(db);
  const [requireStock, creditsPerSegment, taxRateSetting] = await Promise.all([getSetting('billing.requireProviderStockForPurchase'), getSetting('sms.creditsPerSegment'), getSetting('billing.taxRate')]);

  const lines: QuoteLine[] = [];
  for (const [i, item] of parsed.data.entries()) {
    const field = `items.${i}`;
    const q = quantitySchema.safeParse(item.quantity);
    if (!q.success) throw AppError.unprocessable(q.error.issues[0].message, 'INVALID_QUANTITY', [{ field: `${field}.quantity`, message: q.error.issues[0].message }]);
    const quantity = q.data;
    const state = states.get(item.networkId);
    if (!state) {
      // Unknown, deactivated or in an inactive country: never purchasable (ids are validated, not trusted).
      throw AppError.unprocessable('This destination network is not available for purchase', 'NETWORK_NOT_AVAILABLE', [{ field: `${field}.networkId`, message: 'Not available' }]);
    }
    const n = state.network;
    if (state.availability !== 'AVAILABLE') {
      throw AppError.unprocessable(`${n.name}: ${AVAILABILITY_TEXT[state.availability]}`, PURCHASE_ERROR[state.availability], [{ field: `${field}.networkId`, message: AVAILABILITY_TEXT[state.availability] }]);
    }
    const before = state.rule.pricingMetric === 'MONTHLY_PURCHASE_QUANTITY' && opts.organizationId ? await monthlyVolume(db, opts.organizationId, n.id) : 0;
    const priced = priceQuantity(state.tiers, state.rule, quantity, before, n.name);
    if (!priced.ok) throw AppError.unprocessable(priced.message, priced.code, [{ field: `${field}.${priced.field}`, message: priced.message }]);
    const tier = priced.tier;
    if (requireStock && state.stock < Math.ceil(quantity / creditsPerSegment)) {
      const message = `${n.name}: this quantity cannot be supplied right now. Try a smaller quantity or contact support.`;
      throw AppError.unprocessable(message, 'NETWORK_INSUFFICIENT_STOCK', [{ field: `${field}.quantity`, message: 'More than can be supplied right now' }]);
    }
    const unitPrice = priced.unitPrice;
    const subtotal = priced.subtotal;
    const base = state.tiers.reduce((m, t) => (t.unitPrice.gt(m) ? new Prisma.Decimal(t.unitPrice) : m), unitPrice);
    lines.push({
      networkId: n.id,
      networkName: n.name,
      networkCode: n.code,
      countryCode: n.countryCode,
      countryName: ctx.countries.find((c) => c.isoCode === n.countryCode)?.name ?? n.countryName,
      direction: 'OUTBOUND',
      quantity,
      tier: { id: tier.id, name: tier.name, minQuantity: tier.minQuantity, maxQuantity: tier.maxQuantity, label: fmtRange(tier) },
      unitPrice: state.rule.rateApplication === 'WHOLE_PURCHASE' ? unitPrice.toFixed(2) : unitPrice.toFixed(4),
      subtotal: subtotal.toFixed(2),
      total: subtotal.toFixed(2),
      pricing: { priceListId: state.rule.id, metric: state.rule.pricingMetric, rateApplication: state.rule.rateApplication, volumeBefore: priced.volumeBefore, breakdown: priced.breakdown },
      savings: base.gt(unitPrice)
        ? { comparedToUnitPrice: base.toFixed(2), amount: base.mul(quantity).toDecimalPlaces(2).minus(subtotal).toFixed(2), percent: base.minus(unitPrice).div(base).mul(100).toDecimalPlaces(1).toNumber() }
        : null,
      currency: tier.currency,
    });
  }

  const currencies = new Set(lines.map((l) => l.currency));
  if (currencies.size > 1) throw AppError.conflict('The selected networks are priced in different currencies and must be bought separately', 'MIXED_CURRENCIES');
  const subtotal = lines.reduce((s, l) => s.plus(l.subtotal), new Prisma.Decimal(0));
  const total = subtotal;
  // Prices are tax-inclusive (same rule as invoices): the tax share is shown, never added on top.
  const taxRate = new Prisma.Decimal(taxRateSetting);
  const taxIncluded = total.minus(total.div(taxRate.div(100).plus(1)).toDecimalPlaces(2));
  const discount = lines.reduce((s, l) => s.plus(l.savings?.amount ?? 0), new Prisma.Decimal(0));
  return {
    items: lines,
    totalQuantity: lines.reduce((s, l) => s + l.quantity, 0),
    subtotal: subtotal.toFixed(2),
    discount: discount.toFixed(2),
    taxRate: taxRate.toFixed(2),
    taxIncluded: taxIncluded.toFixed(2),
    total: total.toFixed(2),
    currency: lines[0].currency,
  };
}

export type NetworkQuote = Awaited<ReturnType<typeof quoteNetworkPurchase>>;

// ── Staff views ──────────────────────────────────────────────────────────

/**
 * Provider stock and consumption by destination network (staff only). A provider's capacity counts for
 * a network only when the provider explicitly serves that network (or its whole country) — capacity that
 * cannot reach a network is never shown as stock for it. Lot values use each lot's own historical unit
 * cost; consumption uses the costs frozen on each recipient at routing time.
 */
export async function networkInventory(from: Date, to: Date, db: Db = prisma) {
  const ctx = await loadRoutingContext(db);
  const [lots, used] = await Promise.all([
    db.providerCapacityLot.groupBy({ by: ['providerId'], where: { remaining: { gt: 0 } }, _sum: { remaining: true } }),
    db.smsRecipient.groupBy({
      by: ['networkId', 'providerId'],
      where: { createdAt: { gte: from, lte: to }, providerId: { not: null }, capacityReleased: false },
      _count: true,
      _sum: { providerCost: true, credits: true },
    }),
  ]);
  const lotValues = await db.$queryRaw<{ providerId: string; value: unknown }[]>`
    SELECT providerId, SUM(remaining * unitCost) AS value FROM provider_capacity_lots WHERE remaining > 0 GROUP BY providerId`;
  return ctx.networks.map((n) => {
    const country = ctx.countries.find((c) => c.isoCode === n.countryCode);
    const providers = ctx.providers
      .filter((p) => p.networkIds.includes(n.id) || (!!country && p.countryIds.includes(country.id)))
      .map((p) => {
        const remaining = lots.find((l) => l.providerId === p.id)?._sum.remaining ?? 0;
        const value = new Prisma.Decimal(String(lotValues.find((l) => l.providerId === p.id)?.value ?? 0));
        const u = used.find((x) => x.networkId === n.id && x.providerId === p.id);
        return {
          providerId: p.id,
          name: p.name,
          type: p.type,
          status: p.status,
          health: p.health,
          capability: p.networkIds.includes(n.id) ? ('NETWORK' as const) : ('COUNTRY' as const),
          // Shared across every destination the provider serves.
          capacityBalance: p.capacityBalance,
          remainingLotCapacity: remaining,
          averageRemainingCost: remaining > 0 ? value.div(remaining).toFixed(4) : null,
          currentQuotedCost: new Prisma.Decimal(p.costPerSms).toFixed(4),
          consumed: { messages: u?._count ?? 0, credits: u?._sum.credits ?? 0, providerCost: new Prisma.Decimal(u?._sum.providerCost ?? 0).toFixed(2) },
        };
      });
    return { networkId: n.id, name: n.name, code: n.code, countryCode: n.countryCode, status: n.inMaintenance ? 'MAINTENANCE' : 'ACTIVE', providers };
  });
}

/** Every network with its customer availability and internal stock, for the admin pages. */
export async function networkCommerceOverview(db: Db = prisma) {
  const { ctx, states } = await loadStates(db);
  return ctx.networks.map((n) => {
    const s = states.get(n.id)!;
    return { ...customerNetwork(s), countryName: n.countryName, usableProviderCapacity: s.stock };
  });
}
