import { Prisma, type SmsProvider } from '@prisma/client';
import { z } from 'zod';
import { isProduction } from '../../config/env';
import { prisma } from '../../config/prisma';
import { assertSafeUrl, httpJsonConfigSchema, type HttpJsonSecrets } from '../../integrations/sms/HttpJsonSmsProvider';
import { SmsProviderFactory } from '../../integrations/sms/SmsProviderFactory';
import { encrypt } from '../../utils/crypto';
import type { Actor, RequestMeta } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { audit } from '../audit-logs/audit.service';
import { getSetting } from '../settings/settings.service';
import { analyzeMessage } from '../sms/segmentation.service';
import { serializeProvider } from './provider.service';
import { normalizePhone } from '../../utils/phone';
import { checkDestination, countryName, destinationFor } from './destination.service';
import { loadRoutingContext, planRoute, type CandidateEvaluation, type Destination } from './routing.service';

/**
 * Super Admin views of the supply side: provider overview, detail, configuration changes
 * (audited field by field) and the routing simulator. All money figures come from stored rows.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);
const money = (v: Prisma.Decimal) => v.toFixed(2);

const decimal = z.string().trim().regex(/^\d{1,8}(\.\d{1,4})?$/, 'Decimal with up to 4 places');

export const providerConfig = z.object({
  name: z.string().trim().min(2).max(80),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
  mode: z.enum(['SIMULATION', 'PRODUCTION']),
  currency: z.string().trim().length(3).toUpperCase(),
  costPerSms: decimal,
  priority: z.coerce.number().int().min(0).max(1000),
  health: z.enum(['HEALTHY', 'DEGRADED', 'DOWN']),
  healthNote: z.string().trim().max(500).nullable(),
  minimumCapacity: z.coerce.number().int().min(0).max(100_000_000),
  lowCapacityThreshold: z.coerce.number().int().min(0).max(100_000_000),
  supportsSenderId: z.boolean(),
  // Explicit destination capability: whole countries and/or specific networks.
  countryIds: z.array(z.string().uuid()).max(300),
  networkIds: z.array(z.string().uuid()).max(500),
  notes: z.string().trim().max(1000).nullable(),
  // How this provider is reached in production. HTTP_JSON is configured entirely here (no code change).
  adapterType: z.enum(['NONE', 'HTTP_JSON']),
  adapterConfig: httpJsonConfigSchema
    .extend({ apiKey: z.string().min(1).max(500).optional(), callbackSecret: z.string().min(8).max(300).optional() })
    .nullable(),
});

export const providerCreateBody = providerConfig
  .extend({
    code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,29}$/, 'Letters, digits and _ (e.g. MTN, AIRTEL, TIGO_2)'),
    type: z.enum(['MNO', 'AGGREGATOR']),
    status: providerConfig.shape.status.default('INACTIVE'),
    mode: providerConfig.shape.mode.default('SIMULATION'),
    priority: providerConfig.shape.priority.default(100),
    health: providerConfig.shape.health.default('HEALTHY'),
    healthNote: providerConfig.shape.healthNote.optional(),
    minimumCapacity: providerConfig.shape.minimumCapacity.default(0),
    lowCapacityThreshold: providerConfig.shape.lowCapacityThreshold.default(10_000),
    supportsSenderId: z.boolean().default(true),
    countryIds: providerConfig.shape.countryIds.default([]),
    networkIds: providerConfig.shape.networkIds.default([]),
    notes: providerConfig.shape.notes.optional(),
    adapterType: providerConfig.shape.adapterType.default('NONE'),
    adapterConfig: providerConfig.shape.adapterConfig.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const providerUpdateBody = providerConfig.partial().extend({ reason: z.string().trim().max(500).optional() }).strict();

async function assertCountries(ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const found = await prisma.smsCountry.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw AppError.unprocessable('One or more selected countries do not exist', 'UNKNOWN_COUNTRY', [{ field: 'countryIds', message: 'Unknown country' }]);
  return unique;
}

async function assertNetworks(ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const found = await prisma.smsNetwork.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw AppError.unprocessable('One or more selected networks do not exist', 'UNKNOWN_NETWORK', [{ field: 'networkIds', message: 'Unknown network' }]);
  return unique;
}

/** Remaining capacity and its value per provider, from the capacity lots. */
async function lotTotals() {
  const rows = await prisma.$queryRaw<{ providerId: string; remaining: unknown; value: unknown; lots: bigint }[]>`
    SELECT providerId, SUM(remaining) AS remaining, SUM(remaining * unitCost) AS value, COUNT(CASE WHEN remaining > 0 THEN 1 END) AS lots
    FROM provider_capacity_lots GROUP BY providerId`;
  return new Map(rows.map((r) => [r.providerId, { remaining: Number(r.remaining ?? 0), value: D(String(r.value ?? 0)), openLots: Number(r.lots) }]));
}

type CapabilityRefs = { networks: { id: string; code: string; name: string }[]; countries: { id: string; isoCode: string; name: string }[] };

export async function serializeProviderRow(p: SmsProvider, extra?: { remainingValue: Prisma.Decimal; openLots: number } & CapabilityRefs) {
  const usagePercent = p.totalPurchased > 0 ? Math.round((p.totalUsed / p.totalPurchased) * 1000) / 10 : 0;
  const value = extra?.remainingValue ?? ZERO;
  return {
    ...serializeProvider(p),
    usagePercent,
    remainingValue: money(value),
    averageRemainingCost: p.capacityBalance > 0 ? value.div(p.capacityBalance).toFixed(4) : null,
    openLots: extra?.openLots ?? 0,
    networks: extra?.networks ?? [],
    countries: extra?.countries ?? [],
    routable: p.status === 'ACTIVE' && p.health !== 'DOWN' && serializeProvider(p).adapterInstalled,
  };
}

export async function listProviders() {
  const [providers, totals, links, countryLinks] = await Promise.all([
    prisma.smsProvider.findMany({ orderBy: [{ priority: 'asc' }, { name: 'asc' }] }),
    lotTotals(),
    prisma.smsProviderNetwork.findMany({ include: { network: { select: { id: true, code: true, name: true } } } }),
    prisma.smsProviderCountry.findMany({ include: { country: { select: { id: true, isoCode: true, name: true } } } }),
  ]);
  const last = await prisma.providerPurchase.groupBy({ by: ['providerId'], _max: { createdAt: true } });
  return Promise.all(
    providers.map(async (p) => ({
      ...(await serializeProviderRow(p, {
        remainingValue: totals.get(p.id)?.value ?? ZERO,
        openLots: totals.get(p.id)?.openLots ?? 0,
        networks: links.filter((l) => l.providerId === p.id).map((l) => l.network),
        countries: countryLinks.filter((l) => l.providerId === p.id).map((l) => l.country),
      })),
      lastPurchaseAt: last.find((l) => l.providerId === p.id)?._max.createdAt ?? null,
    })),
  );
}

/** Average net revenue per customer credit sold (all time). Null until something has been sold. */
export async function revenuePerCredit(): Promise<Prisma.Decimal | null> {
  const [sales, refunds] = await Promise.all([
    prisma.customerPurchase.aggregate({ _sum: { revenue: true, credits: true } }),
    prisma.refund.aggregate({ _sum: { amount: true, creditsReversed: true } }),
  ]);
  const credits = (sales._sum.credits ?? 0) - (refunds._sum.creditsReversed ?? 0);
  if (credits <= 0) return null;
  return D(sales._sum.revenue ?? 0).minus(refunds._sum.amount ?? 0).div(credits);
}

/** Cost and (estimated) revenue of the SMS actually routed, optionally for one provider. */
async function routedEconomics(from: Date, to: Date, providerId?: string) {
  const where: Prisma.SmsRecipientWhereInput = { createdAt: { gte: from, lte: to }, capacityReleased: false, providerId: providerId ?? { not: null } };
  const [agg, credits, segs, perCredit] = await Promise.all([
    prisma.smsRecipient.aggregate({ where, _sum: { providerCost: true }, _count: true }),
    prisma.smsRecipient.aggregate({ where: { ...where, refunded: false }, _sum: { credits: true } }),
    prisma.$queryRaw<{ segments: unknown }[]>`
      SELECT COALESCE(SUM(m.segments), 0) AS segments FROM sms_recipients r JOIN sms_messages m ON m.id = r.messageId
      WHERE r.createdAt >= ${from} AND r.createdAt <= ${to} AND r.capacityReleased = FALSE AND r.providerId IS NOT NULL
      ${providerId ? Prisma.sql`AND r.providerId = ${providerId}` : Prisma.empty}`,
    revenuePerCredit(),
  ]);
  const providerCost = D(agg._sum.providerCost ?? 0).toDecimalPlaces(2);
  const creditsUsed = credits._sum.credits ?? 0;
  const revenue = perCredit ? perCredit.mul(creditsUsed).toDecimalPlaces(2) : null;
  return {
    messages: agg._count,
    segments: Number(segs[0]?.segments ?? 0),
    creditsUsed,
    revenuePerCredit: perCredit ? perCredit.toFixed(4) : null,
    revenue: revenue ? money(revenue) : null,
    providerCost: money(providerCost),
    grossMargin: revenue ? money(revenue.minus(providerCost)) : null,
    marginPercent: revenue && revenue.gt(0) ? revenue.minus(providerCost).div(revenue).mul(100).toDecimalPlaces(1).toNumber() : null,
  };
}

/**
 * Customer credits delivered through each provider in the period: how much of what was sold each
 * provider carried, what it earned (credits × average net price per credit) and what it cost.
 */
async function creditsByProvider(from: Date, to: Date, providers: { id: string; name: string; code: string }[]) {
  const where: Prisma.SmsRecipientWhereInput = { createdAt: { gte: from, lte: to }, capacityReleased: false, providerId: { not: null } };
  const [rows, billed, perCredit] = await Promise.all([
    prisma.smsRecipient.groupBy({ by: ['providerId'], where, _sum: { providerCost: true }, _count: true }),
    prisma.smsRecipient.groupBy({ by: ['providerId'], where: { ...where, refunded: false }, _sum: { credits: true } }),
    revenuePerCredit(),
  ]);
  const totalCredits = billed.reduce((s, r) => s + (r._sum.credits ?? 0), 0);
  return providers
    .map((p) => {
      const r = rows.find((x) => x.providerId === p.id);
      const credits = billed.find((x) => x.providerId === p.id)?._sum.credits ?? 0;
      const cost = D(r?._sum.providerCost ?? 0).toDecimalPlaces(2);
      const revenue = perCredit ? perCredit.mul(credits).toDecimalPlaces(2) : null;
      return {
        providerId: p.id,
        name: p.name,
        code: p.code,
        messages: r?._count ?? 0,
        credits,
        sharePercent: totalCredits ? Math.round((credits / totalCredits) * 1000) / 10 : 0,
        revenue: revenue ? money(revenue) : null,
        providerCost: money(cost),
        costPerCredit: credits ? cost.div(credits).toFixed(4) : null,
        grossMargin: revenue ? money(revenue.minus(cost)) : null,
        marginPercent: revenue && revenue.gt(0) ? revenue.minus(cost).div(revenue).mul(100).toDecimalPlaces(1).toNumber() : null,
      };
    })
    .sort((a, b) => b.credits - a.credits);
}

export async function providersOverview(from: Date, to: Date) {
  const providers = await listProviders();
  const remaining = providers.reduce((s, p) => s + p.capacityBalance, 0);
  const remainingValue = providers.reduce((s, p) => s.plus(p.remainingValue), ZERO);
  return {
    range: { from, to },
    counts: { providers: providers.length, active: providers.filter((p) => p.status === 'ACTIVE').length, routable: providers.filter((p) => p.routable).length },
    capacity: {
      purchased: providers.reduce((s, p) => s + p.totalPurchased, 0),
      used: providers.reduce((s, p) => s + p.totalUsed, 0),
      remaining,
      remainingValue: money(remainingValue),
      averageRemainingCost: remaining > 0 ? remainingValue.div(remaining).toFixed(4) : null,
    },
    economics: await routedEconomics(from, to),
    byProvider: await creditsByProvider(from, to, providers),
    formula: 'Revenue of SMS sent (credits used × average net sale price per credit) − provider cost of the capacity lots consumed = gross SMS margin',
    providers,
  };
}

export async function providerDetail(id: string, from: Date, to: Date) {
  const p = await prisma.smsProvider.findUnique({ where: { id } });
  if (!p) throw AppError.notFound('Provider');
  const [lots, links, countryLinks, rules, recent, costChanges, usage, economics] = await Promise.all([
    prisma.providerCapacityLot.findMany({ where: { providerId: id }, orderBy: { createdAt: 'desc' }, include: { purchase: { select: { reference: true, status: true, providerReference: true, createdById: true } } } }),
    prisma.smsProviderNetwork.findMany({ where: { providerId: id }, include: { network: true } }),
    prisma.smsProviderCountry.findMany({ where: { providerId: id }, include: { country: { select: { id: true, isoCode: true, name: true } } } }),
    prisma.smsRoutingRule.findMany({ orderBy: { priority: 'asc' }, include: { network: { select: { name: true } } } }),
    prisma.providerCapacityLedger.findMany({ where: { providerId: id }, orderBy: { createdAt: 'desc' }, take: 15 }),
    prisma.auditLog.findMany({
      where: { resource: 'sms_provider', resourceId: id, action: { in: ['PROVIDER_CREATED', 'PROVIDER_PRICING_CHANGED'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { createdAt: true, action: true, actorEmail: true, metadata: true },
    }),
    prisma.$queryRaw<{ day: Date; used: unknown }[]>`
      SELECT DATE(createdAt) AS day, -SUM(amount) AS used FROM provider_capacity_ledger
      WHERE providerId = ${id} AND type IN ('USAGE', 'RELEASE') AND createdAt >= ${from} AND createdAt <= ${to}
      GROUP BY day ORDER BY day`,
    routedEconomics(from, to, id),
  ]);
  const value = lots.reduce((s, l) => s.plus(D(l.unitCost).mul(l.remaining)), ZERO);
  const referencing = rules
    .map((r) => {
      const backups = (r.backupProviderIds as string[]) ?? [];
      const allowed = (r.allowedProviderIds as string[]) ?? [];
      const role = r.primaryProviderId === id ? 'primary' : backups.includes(id) ? `backup #${backups.indexOf(id) + 1}` : allowed.includes(id) ? 'allowed' : null;
      return role ? { id: r.id, name: r.name, priority: r.priority, isActive: r.isActive, strategy: r.strategy, destination: r.network?.name ?? r.countryCode ?? 'Any destination', role } : null;
    })
    .filter(Boolean);
  return {
    ...(await serializeProviderRow(p, { remainingValue: value, openLots: lots.filter((l) => l.remaining > 0).length, networks: links.map((l) => ({ id: l.network.id, code: l.network.code, name: l.network.name })), countries: countryLinks.map((l) => l.country) })),
    lots: lots.map((l) => ({
      id: l.id,
      source: l.source,
      reference: l.purchase?.reference ?? l.reference,
      providerReference: l.purchase?.providerReference ?? null,
      status: l.purchase?.status ?? 'SUCCESS',
      quantity: l.quantity,
      used: l.quantity - l.remaining,
      remaining: l.remaining,
      unitCost: D(l.unitCost).toFixed(4),
      totalCost: money(D(l.unitCost).mul(l.quantity)),
      remainingValue: money(D(l.unitCost).mul(l.remaining)),
      createdAt: l.createdAt,
    })),
    costHistory: costChanges.map((c) => {
      const m = (c.metadata ?? {}) as { changes?: { costPerSms?: { from: string; to: string } }; costPerSms?: string; reason?: string };
      return { at: c.createdAt, by: c.actorEmail, from: m.changes?.costPerSms?.from ?? null, to: m.changes?.costPerSms?.to ?? m.costPerSms ?? null, reason: m.reason ?? null };
    }),
    rules: referencing,
    usage: usage.map((u) => ({ date: u.day.toISOString().slice(0, 10), segments: Number(u.used ?? 0) })),
    economics,
    recentActivity: recent.map((e) => ({ ...e, unitCost: e.unitCost?.toFixed(4) ?? null })),
  };
}

const AUDITED_FIELDS = ['name', 'status', 'mode', 'currency', 'costPerSms', 'priority', 'health', 'healthNote', 'minimumCapacity', 'lowCapacityThreshold', 'supportsSenderId', 'notes'] as const;

function fieldValue(p: SmsProvider, k: (typeof AUDITED_FIELDS)[number]) {
  const v = p[k];
  return v instanceof Prisma.Decimal ? D(v).toFixed(4) : v;
}


type StoredConfig = Record<string, unknown> & { secrets?: HttpJsonSecrets };

/**
 * Turns the submitted integration into what is stored: the validated config plus encrypted secrets.
 * A secret left out keeps its stored value, so editing the URLs never forces re-entering the key.
 */
async function buildAdapterData(
  type: 'NONE' | 'HTTP_JSON',
  submitted: z.infer<typeof providerConfig>['adapterConfig'] | undefined,
  existing?: Pick<SmsProvider, 'adapterType' | 'adapterConfig'>,
): Promise<{ adapterType: 'NONE' | 'HTTP_JSON'; adapterConfig: Prisma.InputJsonValue | typeof Prisma.DbNull }> {
  if (type === 'NONE') return { adapterType: 'NONE', adapterConfig: Prisma.DbNull };
  const previous = existing?.adapterType === 'HTTP_JSON' ? ((existing.adapterConfig ?? {}) as StoredConfig) : null;
  if (!submitted && !previous) throw AppError.unprocessable('Fill in the integration settings', 'ADAPTER_CONFIG_REQUIRED', [{ field: 'adapterConfig', message: 'Required' }]);
  const { apiKey, callbackSecret, ...config }: z.infer<typeof httpJsonConfigSchema> & { apiKey?: string; callbackSecret?: string } =
    submitted ?? (({ secrets: _s, ...rest }) => rest)(previous!) as unknown as z.infer<typeof httpJsonConfigSchema>;
  for (const [field, url] of [['sendUrl', config.sendUrl], ['statusUrl', config.statusUrl], ['balanceUrl', config.balanceUrl]] as const) {
    if (!url) continue;
    try {
      await assertSafeUrl(url.replace(/\{\{providerMessageId\}\}/g, 'x'), !isProduction);
    } catch (err) {
      throw AppError.unprocessable(`${field}: ${(err as Error).message}`, 'ADAPTER_URL_REFUSED', [{ field: `adapterConfig.${field}`, message: (err as Error).message }]);
    }
  }
  if (config.callback && !(callbackSecret ?? previous?.secrets?.callbackSecretEncrypted)) {
    throw AppError.unprocessable('Set a callback secret to accept delivery reports', 'CALLBACK_SECRET_REQUIRED', [{ field: 'adapterConfig.callbackSecret', message: 'Required' }]);
  }
  const secrets: HttpJsonSecrets = {
    apiKeyEncrypted: apiKey ? encrypt(apiKey) : previous?.secrets?.apiKeyEncrypted ?? null,
    callbackSecretEncrypted: config.callback ? (callbackSecret ? encrypt(callbackSecret) : previous?.secrets?.callbackSecretEncrypted ?? null) : null,
  };
  if (config.auth.type !== 'NONE' && !secrets.apiKeyEncrypted) {
    throw AppError.unprocessable('Enter the API key for this provider', 'API_KEY_REQUIRED', [{ field: 'adapterConfig.apiKey', message: 'Required' }]);
  }
  return { adapterType: 'HTTP_JSON', adapterConfig: { ...config, secrets } as unknown as Prisma.InputJsonValue };
}

export async function createProvider(input: z.infer<typeof providerCreateBody>, actor: Actor, meta?: RequestMeta) {
  const { networkIds, countryIds, reason, adapterType, adapterConfig, ...data } = input;
  const networks = await assertNetworks(networkIds);
  const countries = await assertCountries(countryIds);
  const adapter = await buildAdapterData(adapterType, adapterConfig);
  const p = await prisma.$transaction(async (tx) => {
    const row = await tx.smsProvider.create({
      data: {
        ...data,
        ...adapter,
        routePrefixes: [],
        healthNote: data.healthNote ?? null,
        notes: data.notes ?? null,
        costPerSms: D(data.costPerSms),
        networks: { create: networks.map((networkId) => ({ networkId })) },
        countries: { create: countries.map((countryId) => ({ countryId })) },
      },
    });
    await audit(
      {
        actor,
        action: 'PROVIDER_CREATED',
        resource: 'sms_provider',
        resourceId: row.id,
        metadata: { code: row.code, name: row.name, type: row.type, costPerSms: D(row.costPerSms).toFixed(4), status: row.status, priority: row.priority, networkIds: networks, countryIds: countries, reason },
        meta,
      },
      tx,
    );
    return row;
  });
  await SmsProviderFactory.refresh();
  return p;
}

export async function updateProvider(id: string, input: z.infer<typeof providerUpdateBody>, actor: Actor, meta?: RequestMeta) {
  const { networkIds, countryIds, reason, adapterType, adapterConfig, ...data } = input;
  const networks = networkIds ? await assertNetworks(networkIds) : null;
  const countries = countryIds ? await assertCountries(countryIds) : null;
  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.smsProvider.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Provider');
    const adapter = adapterType !== undefined || adapterConfig !== undefined ? await buildAdapterData(adapterType ?? (before.adapterType as 'NONE' | 'HTTP_JSON'), adapterConfig, before) : null;
    const beforeNetworks = (await tx.smsProviderNetwork.findMany({ where: { providerId: id } })).map((l) => l.networkId).sort();
    const beforeCountries = (await tx.smsProviderCountry.findMany({ where: { providerId: id } })).map((l) => l.countryId).sort();
    const updated = await tx.smsProvider.update({ where: { id }, data: { ...data, ...(adapter ?? {}), costPerSms: data.costPerSms ? D(data.costPerSms) : undefined } });
    if (networks) {
      await tx.smsProviderNetwork.deleteMany({ where: { providerId: id } });
      if (networks.length) await tx.smsProviderNetwork.createMany({ data: networks.map((networkId) => ({ providerId: id, networkId })) });
    }
    if (countries) {
      await tx.smsProviderCountry.deleteMany({ where: { providerId: id } });
      if (countries.length) await tx.smsProviderCountry.createMany({ data: countries.map((countryId) => ({ providerId: id, countryId })) });
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of AUDITED_FIELDS) {
      const from = fieldValue(before, k);
      const to = fieldValue(updated, k);
      if (from !== to) changes[k] = { from, to };
    }
    if (adapter) {
      // Never log URLs' secrets: only the type, the endpoints and whether keys changed.
      const view = (a: Pick<SmsProvider, 'adapterType' | 'adapterConfig'>) => {
        const c = (a.adapterConfig ?? {}) as StoredConfig & { sendUrl?: string };
        return { type: a.adapterType, sendUrl: c.sendUrl ?? null, apiKey: c.secrets?.apiKeyEncrypted ?? null, callbackSecret: c.secrets?.callbackSecretEncrypted ?? null };
      };
      const b = view(before);
      const a = view(updated);
      if (JSON.stringify(b) !== JSON.stringify(a)) changes.integration = { from: { type: b.type, sendUrl: b.sendUrl }, to: { type: a.type, sendUrl: a.sendUrl, apiKeyChanged: b.apiKey !== a.apiKey, callbackSecretChanged: b.callbackSecret !== a.callbackSecret } };
    }
    if (networks && networks.slice().sort().join() !== beforeNetworks.join()) changes.networkIds = { from: beforeNetworks, to: networks.slice().sort() };
    if (countries && countries.slice().sort().join() !== beforeCountries.join()) changes.countryIds = { from: beforeCountries, to: countries.slice().sort() };
    if (Object.keys(changes).length) {
      const action = changes.costPerSms ? 'PROVIDER_PRICING_CHANGED' : changes.health ? 'PROVIDER_HEALTH_CHANGED' : changes.status ? 'PROVIDER_STATUS_CHANGED' : 'PROVIDER_UPDATED';
      await audit({ actor, action, resource: 'sms_provider', resourceId: id, metadata: { code: before.code, changes, reason }, meta }, tx);
    }
    return updated;
  });
  await SmsProviderFactory.refresh();
  return result;
}

// ── Routing simulator (read-only) ───────────────────────────────────────

export const simulateBody = z
  .object({
    phone: z.string().trim().max(30).optional().nullable(),
    networkId: z.string().uuid().optional().nullable(),
    countryCode: z.string().trim().length(2).toUpperCase().optional().nullable(),
    senderName: z.string().trim().max(11).optional().nullable(),
    organizationId: z.string().uuid().optional().nullable(),
    recipients: z.coerce.number().int().min(1).max(1_000_000),
    message: z.string().min(1).max(20_000),
  })
  .strict();

/** Overall result of a simulation, in the order a real send makes its decisions. */
export type SimulationOutcome = 'ROUTED' | 'REJECTED_BEFORE_ROUTING' | 'NO_ELIGIBLE_PROVIDER' | 'NO_CAPACITY' | 'INSUFFICIENT_CREDITS';

const OUTCOME_TEXT: Record<SimulationOutcome, string> = {
  ROUTED: 'Would be sent',
  REJECTED_BEFORE_ROUTING: 'Rejected before routing',
  NO_ELIGIBLE_PROVIDER: 'No eligible provider',
  NO_CAPACITY: 'No provider has enough usable capacity',
  INSUFFICIENT_CREDITS: 'Insufficient credits',
};

/** Peek the oldest-first lot cost of taking `quantity` segments (no writes). */
async function peekLotCost(providerId: string, quantity: number) {
  const lots = await prisma.providerCapacityLot.findMany({ where: { providerId, remaining: { gt: 0 } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  let left = quantity;
  let cost = ZERO;
  for (const l of lots) {
    if (left === 0) break;
    const n = Math.min(left, l.remaining);
    cost = cost.plus(D(l.unitCost).mul(n));
    left -= n;
  }
  return cost;
}

/**
 * Explains how a send would be handled right now, using the same steps and services as a real
 * send (number validation → destination → routing engine → customer balance), without writing
 * anything: no credits, capacity, wallet or provider calls. `recipients` messages to one
 * destination are allocated like per-recipient routing (spilling over to the backup).
 */
export async function simulateRouting(input: z.infer<typeof simulateBody>) {
  const analysis = await analyzeMessage(input.message);
  const ctx = await loadRoutingContext(prisma);
  const perRecipient = analysis.segments;
  const message = {
    encoding: analysis.encoding,
    characterCount: analysis.characterCount,
    segmentsPerRecipient: perRecipient,
    totalSegments: perRecipient * input.recipients,
    creditsPerRecipient: analysis.creditsPerRecipient,
    totalCredits: analysis.creditsPerRecipient * input.recipients,
    creditsPerSegment: await getSetting('sms.creditsPerSegment'),
    tooLong: analysis.tooLong,
    segmentationVersion: analysis.segmentationVersion,
  };
  const senders = input.senderName ? await prisma.senderId.findMany({ where: { name: input.senderName }, select: { status: true } }) : [];
  const sender = input.senderName ? { name: input.senderName, known: senders.length > 0, approved: senders.some((x) => x.status === 'APPROVED') } : null;

  // 1–2. Validate the number and identify the destination (exactly like a real send).
  let dest: Destination;
  let validation: { checked: boolean; ok: boolean; phone: string | null; code: string | null; reason: string | null; country: { code: string; name: string } | null };
  if (input.phone) {
    const normalized = normalizePhone(input.phone, await getSetting('sms.defaultCountryCode'));
    const check = normalized ? checkDestination(ctx, normalized) : null;
    if (!check || !check.ok) {
      const reason = check && !check.ok ? check.reason : 'Invalid destination number: not a valid phone number';
      return {
        outcome: 'REJECTED_BEFORE_ROUTING' as SimulationOutcome,
        outcomeText: OUTCOME_TEXT.REJECTED_BEFORE_ROUTING,
        message,
        sender,
        validation: { checked: true, ok: false, phone: check?.phone ?? input.phone, code: check && !check.ok ? check.code : 'INVALID_NUMBER', reason, country: check?.countryCode ? { code: check.countryCode, name: countryName(check.countryCode) } : null },
        destination: null,
        rule: null,
        strategy: null,
        candidates: [],
        selected: null,
        backup: null,
        rejected: [],
        reason,
        allocations: [],
        unroutedRecipients: input.recipients,
        customer: null,
        estimate: { providerCost: money(ZERO), revenue: null, revenuePerCredit: null, grossMargin: null },
      };
    }
    dest = check;
    validation = { checked: true, ok: true, phone: check.phone, code: null, reason: null, country: { code: check.countryCode!, name: check.countryName } };
  } else {
    dest = destinationFor(ctx, input);
    const c = dest.countryCode ? ctx.countries.find((x) => x.isoCode === dest.countryCode) : undefined;
    validation = { checked: false, ok: true, phone: null, code: null, reason: null, country: dest.countryCode ? { code: dest.countryCode, name: c?.name ?? countryName(dest.countryCode) } : null };
    if (input.networkId && !dest.network) throw AppError.unprocessable('Unknown or inactive network', 'UNKNOWN_NETWORK', [{ field: 'networkId', message: 'Unknown network' }]);
    if (!c || !c.isActive) {
      const reason = dest.countryCode ? `Destination not supported: ${countryName(dest.countryCode)} (${dest.countryCode}) is not configured for sending` : 'Choose a destination country or enter a number';
      return {
        outcome: 'REJECTED_BEFORE_ROUTING' as SimulationOutcome,
        outcomeText: OUTCOME_TEXT.REJECTED_BEFORE_ROUTING,
        message,
        sender,
        validation: { ...validation, ok: false, code: 'UNSUPPORTED_COUNTRY', reason },
        destination: null,
        rule: null,
        strategy: null,
        candidates: [],
        selected: null,
        backup: null,
        rejected: [],
        reason,
        allocations: [],
        unroutedRecipients: input.recipients,
        customer: null,
        estimate: { providerCost: money(ZERO), revenue: null, revenuePerCredit: null, grossMargin: null },
      };
    }
  }

  // 3. Routing engine (same as real sends).
  const remaining = new Map(ctx.providers.map((p) => [p.id, p.capacityBalance]));
  const first = planRoute(ctx, dest, perRecipient, remaining);
  const allocations: { provider: CandidateEvaluation['provider']; recipients: number; segments: number }[] = [];
  let left = input.recipients;
  while (left > 0 && perRecipient > 0) {
    const plan = planRoute(ctx, dest, perRecipient, remaining);
    if (!plan.selected) break;
    const p = plan.selected.provider;
    const take = Math.min(left, Math.floor(plan.selected.available / perRecipient));
    allocations.push({ provider: p, recipients: take, segments: take * perRecipient });
    remaining.set(p.id, (remaining.get(p.id) ?? 0) - take * perRecipient);
    left -= take;
  }

  // 4. Customer balance (only after a route exists, like a real send).
  let customer: { organizationId: string; name: string; balance: number; required: number; sufficient: boolean } | null = null;
  if (input.organizationId) {
    const org = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true, name: true, wallet: { select: { balance: true } } } });
    if (!org) throw AppError.unprocessable('Unknown organization', 'UNKNOWN_ORGANIZATION', [{ field: 'organizationId', message: 'Unknown organization' }]);
    const balance = org.wallet?.balance ?? 0;
    customer = { organizationId: org.id, name: org.name, balance, required: message.totalCredits, sufficient: balance >= message.totalCredits };
  }

  const serving = first.candidates.filter((c) => !c.reasonCodes.includes('UNSUPPORTED_DESTINATION'));
  const outcome: SimulationOutcome = !first.selected
    ? serving.length && serving.every((c) => c.reasonCodes.some((r) => r === 'INSUFFICIENT_CAPACITY' || r === 'BELOW_RESERVE'))
      ? 'NO_CAPACITY'
      : 'NO_ELIGIBLE_PROVIDER'
    : left > 0
      ? 'NO_CAPACITY'
      : customer && !customer.sufficient
        ? 'INSUFFICIENT_CREDITS'
        : 'ROUTED';

  const perCredit = await revenuePerCredit();
  const costs = await Promise.all(allocations.map((a) => peekLotCost(a.provider.id, a.segments)));
  const providerCost = costs.reduce((s, c) => s.plus(c), ZERO).toDecimalPlaces(2);
  const credits = (input.recipients - left) * analysis.creditsPerRecipient;
  const revenue = perCredit ? perCredit.mul(credits).toDecimalPlaces(2) : null;
  const country = dest.countryCode ? ctx.countries.find((c) => c.isoCode === dest.countryCode) : undefined;

  return {
    outcome,
    outcomeText: OUTCOME_TEXT[outcome],
    message,
    sender,
    validation,
    destination: {
      countryCode: dest.countryCode,
      countryName: country?.name ?? (dest.countryCode ? countryName(dest.countryCode) : null),
      network: dest.network ? { id: dest.network.id, name: dest.network.name, code: dest.network.code } : null,
    },
    rule: first.rule ? { id: first.rule.id, name: first.rule.name, priority: first.rule.priority, strategy: first.rule.strategy } : null,
    strategy: first.strategy,
    candidates: first.candidates.map((c) => ({
      providerId: c.provider.id,
      name: c.provider.name,
      code: c.provider.code,
      role: c.role,
      eligible: c.eligible,
      reasons: c.reasons,
      reasonCodes: c.reasonCodes,
      costPerSegment: c.cost.toFixed(2),
      capacity: c.provider.capacityBalance,
      reserve: c.reserve,
      available: c.available,
      priority: c.provider.priority,
      health: c.provider.health,
    })),
    selected: first.selected ? { providerId: first.selected.provider.id, name: first.selected.provider.name, costPerSegment: first.selected.cost.toFixed(2), available: first.selected.available } : null,
    backup: first.backup ? { providerId: first.backup.provider.id, name: first.backup.provider.name, costPerSegment: first.backup.cost.toFixed(2), available: first.backup.available } : null,
    rejected: first.candidates.filter((c) => !c.eligible).map((c) => ({ providerId: c.provider.id, name: c.provider.name, reason: c.reasons[0], code: c.reasonCodes[0] })),
    reason: first.reason,
    allocations: allocations.map((a, i) => ({ providerId: a.provider.id, name: a.provider.name, recipients: a.recipients, segments: a.segments, estimatedCost: money(costs[i]) })),
    unroutedRecipients: left,
    customer,
    estimate: {
      providerCost: money(providerCost),
      revenue: revenue ? money(revenue) : null,
      revenuePerCredit: perCredit ? perCredit.toFixed(4) : null,
      grossMargin: revenue ? money(revenue.minus(providerCost)) : null,
    },
  };
}
