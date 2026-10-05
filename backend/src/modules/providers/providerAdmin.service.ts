import { Prisma, type SmsProvider } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { audit } from '../audit-logs/audit.service';
import { getSetting } from '../settings/settings.service';
import { analyzeMessage } from '../sms/segmentation.service';
import { serializeProvider } from './provider.service';
import { loadRoutingContext, planRoute, resolveDestination, type CandidateEvaluation, type Destination } from './routing.service';

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
  servesAllDestinations: z.boolean(),
  networkIds: z.array(z.string().uuid()).max(200),
  notes: z.string().trim().max(1000).nullable(),
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
    servesAllDestinations: z.boolean().default(false),
    networkIds: providerConfig.shape.networkIds.default([]),
    notes: providerConfig.shape.notes.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const providerUpdateBody = providerConfig.partial().extend({ reason: z.string().trim().max(500).optional() }).strict();

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

export async function serializeProviderRow(p: SmsProvider, extra?: { remainingValue: Prisma.Decimal; openLots: number; networks: { id: string; code: string; name: string }[] }) {
  const usagePercent = p.totalPurchased > 0 ? Math.round((p.totalUsed / p.totalPurchased) * 1000) / 10 : 0;
  const value = extra?.remainingValue ?? ZERO;
  return {
    ...serializeProvider(p),
    usagePercent,
    remainingValue: money(value),
    averageRemainingCost: p.capacityBalance > 0 ? value.div(p.capacityBalance).toFixed(4) : null,
    openLots: extra?.openLots ?? 0,
    networks: extra?.networks ?? [],
    routable: p.status === 'ACTIVE' && p.health !== 'DOWN' && serializeProvider(p).adapterInstalled,
  };
}

export async function listProviders() {
  const [providers, totals, links] = await Promise.all([
    prisma.smsProvider.findMany({ orderBy: [{ priority: 'asc' }, { name: 'asc' }] }),
    lotTotals(),
    prisma.smsProviderNetwork.findMany({ include: { network: { select: { id: true, code: true, name: true } } } }),
  ]);
  const last = await prisma.providerPurchase.groupBy({ by: ['providerId'], _max: { createdAt: true } });
  return Promise.all(
    providers.map(async (p) => ({
      ...(await serializeProviderRow(p, {
        remainingValue: totals.get(p.id)?.value ?? ZERO,
        openLots: totals.get(p.id)?.openLots ?? 0,
        networks: links.filter((l) => l.providerId === p.id).map((l) => l.network),
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
    formula: 'Revenue of SMS sent (credits used × average net sale price per credit) − provider cost of the capacity lots consumed = gross SMS margin',
    providers,
  };
}

export async function providerDetail(id: string, from: Date, to: Date) {
  const p = await prisma.smsProvider.findUnique({ where: { id } });
  if (!p) throw AppError.notFound('Provider');
  const [lots, links, rules, recent, costChanges, usage, economics] = await Promise.all([
    prisma.providerCapacityLot.findMany({ where: { providerId: id }, orderBy: { createdAt: 'desc' }, include: { purchase: { select: { reference: true, status: true, providerReference: true, createdById: true } } } }),
    prisma.smsProviderNetwork.findMany({ where: { providerId: id }, include: { network: true } }),
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
    ...(await serializeProviderRow(p, { remainingValue: value, openLots: lots.filter((l) => l.remaining > 0).length, networks: links.map((l) => ({ id: l.network.id, code: l.network.code, name: l.network.name })) })),
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

const AUDITED_FIELDS = ['name', 'status', 'mode', 'currency', 'costPerSms', 'priority', 'health', 'healthNote', 'minimumCapacity', 'lowCapacityThreshold', 'supportsSenderId', 'servesAllDestinations', 'notes'] as const;

function fieldValue(p: SmsProvider, k: (typeof AUDITED_FIELDS)[number]) {
  const v = p[k];
  return v instanceof Prisma.Decimal ? D(v).toFixed(4) : v;
}

export async function createProvider(input: z.infer<typeof providerCreateBody>, actor: Actor, meta?: RequestMeta) {
  const { networkIds, reason, ...data } = input;
  const networks = await assertNetworks(networkIds);
  const p = await prisma.$transaction(async (tx) => {
    const row = await tx.smsProvider.create({
      data: { ...data, routePrefixes: [], healthNote: data.healthNote ?? null, notes: data.notes ?? null, costPerSms: D(data.costPerSms), networks: { create: networks.map((networkId) => ({ networkId })) } },
    });
    await audit(
      {
        actor,
        action: 'PROVIDER_CREATED',
        resource: 'sms_provider',
        resourceId: row.id,
        metadata: { code: row.code, name: row.name, type: row.type, costPerSms: D(row.costPerSms).toFixed(4), status: row.status, priority: row.priority, networkIds: networks, servesAllDestinations: row.servesAllDestinations, reason },
        meta,
      },
      tx,
    );
    return row;
  });
  return p;
}

export async function updateProvider(id: string, input: z.infer<typeof providerUpdateBody>, actor: Actor, meta?: RequestMeta) {
  const { networkIds, reason, ...data } = input;
  const networks = networkIds ? await assertNetworks(networkIds) : null;
  return prisma.$transaction(async (tx) => {
    const before = await tx.smsProvider.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Provider');
    const beforeNetworks = (await tx.smsProviderNetwork.findMany({ where: { providerId: id } })).map((l) => l.networkId).sort();
    const updated = await tx.smsProvider.update({ where: { id }, data: { ...data, costPerSms: data.costPerSms ? D(data.costPerSms) : undefined } });
    if (networks) {
      await tx.smsProviderNetwork.deleteMany({ where: { providerId: id } });
      if (networks.length) await tx.smsProviderNetwork.createMany({ data: networks.map((networkId) => ({ providerId: id, networkId })) });
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of AUDITED_FIELDS) {
      const from = fieldValue(before, k);
      const to = fieldValue(updated, k);
      if (from !== to) changes[k] = { from, to };
    }
    if (networks && networks.slice().sort().join() !== beforeNetworks.join()) changes.networkIds = { from: beforeNetworks, to: networks.slice().sort() };
    if (Object.keys(changes).length) {
      const action = changes.costPerSms ? 'PROVIDER_PRICING_CHANGED' : changes.health ? 'PROVIDER_HEALTH_CHANGED' : changes.status ? 'PROVIDER_STATUS_CHANGED' : 'PROVIDER_UPDATED';
      await audit({ actor, action, resource: 'sms_provider', resourceId: id, metadata: { code: before.code, changes, reason }, meta }, tx);
    }
    return updated;
  });
}

// ── Routing simulator (read-only) ───────────────────────────────────────

export const simulateBody = z
  .object({
    networkId: z.string().uuid().optional().nullable(),
    countryCode: z.string().trim().length(2).toUpperCase().optional().nullable(),
    phone: z.string().trim().max(30).optional().nullable(),
    senderName: z.string().trim().max(11).optional().nullable(),
    recipients: z.coerce.number().int().min(1).max(1_000_000),
    message: z.string().min(1).max(20_000),
  })
  .strict();

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
 * Explains how a send would be routed right now, without reserving anything: the same engine
 * as real sends, applied to `recipients` messages to one destination (spilling over to backups
 * when the first provider runs out, exactly like per-recipient routing does).
 */
export async function simulateRouting(input: z.infer<typeof simulateBody>) {
  const analysis = await analyzeMessage(input.message);
  const ctx = await loadRoutingContext(prisma);
  let dest: Destination;
  if (input.networkId) {
    const network = ctx.networks.find((n) => n.id === input.networkId);
    if (!network) throw AppError.unprocessable('Unknown or inactive network', 'UNKNOWN_NETWORK', [{ field: 'networkId', message: 'Unknown network' }]);
    dest = { network, countryCode: network.countryCode };
  } else if (input.phone) {
    dest = resolveDestination(ctx, input.phone);
  } else {
    dest = { network: null, countryCode: input.countryCode ?? null };
  }
  // Every message carries a sender ID, so providers without sender ID support are excluded; report the sender's state too.
  const senders = input.senderName ? await prisma.senderId.findMany({ where: { name: input.senderName }, select: { status: true } }) : [];
  const senderCheck = input.senderName
    ? { name: input.senderName, known: senders.length > 0, approved: senders.some((x) => x.status === 'APPROVED') }
    : null;

  const perRecipient = analysis.segments;
  const remaining = new Map(ctx.providers.map((p) => [p.id, p.capacityBalance]));
  const first = planRoute(ctx, dest, perRecipient, remaining);

  // Allocate recipients the way per-recipient routing would: fill each eligible candidate in order.
  const allocations: { provider: CandidateEvaluation['provider']; recipients: number; segments: number }[] = [];
  let left = input.recipients;
  while (left > 0 && perRecipient > 0) {
    const plan = planRoute(ctx, dest, perRecipient, remaining);
    if (!plan.selected) break;
    const p = plan.selected.provider;
    const fits = Math.floor(plan.selected.available / perRecipient);
    const take = Math.min(left, fits);
    allocations.push({ provider: p, recipients: take, segments: take * perRecipient });
    remaining.set(p.id, (remaining.get(p.id) ?? 0) - take * perRecipient);
    left -= take;
  }

  const perCredit = await revenuePerCredit();
  const costs = await Promise.all(allocations.map((a) => peekLotCost(a.provider.id, a.segments)));
  const providerCost = costs.reduce((s, c) => s.plus(c), ZERO).toDecimalPlaces(2);
  const routed = input.recipients - left;
  const credits = routed * analysis.creditsPerRecipient;
  const revenue = perCredit ? perCredit.mul(credits).toDecimalPlaces(2) : null;
  const creditsPerSegment = await getSetting('sms.creditsPerSegment');

  return {
    message: {
      encoding: analysis.encoding,
      characterCount: analysis.characterCount,
      segmentsPerRecipient: perRecipient,
      totalSegments: perRecipient * input.recipients,
      creditsPerRecipient: analysis.creditsPerRecipient,
      totalCredits: analysis.creditsPerRecipient * input.recipients,
      creditsPerSegment,
      tooLong: analysis.tooLong,
      segmentationVersion: analysis.segmentationVersion,
    },
    sender: senderCheck,
    destination: { countryCode: dest.countryCode, network: dest.network ? { id: dest.network.id, name: dest.network.name, code: dest.network.code } : null },
    rule: first.rule ? { id: first.rule.id, name: first.rule.name, priority: first.rule.priority, strategy: first.rule.strategy } : null,
    strategy: first.strategy,
    candidates: first.candidates.map((c) => ({
      providerId: c.provider.id,
      name: c.provider.name,
      code: c.provider.code,
      role: c.role,
      eligible: c.eligible,
      reasons: c.reasons,
      costPerSegment: c.cost.toFixed(2),
      capacity: c.provider.capacityBalance,
      reserve: c.reserve,
      available: c.available,
      priority: c.provider.priority,
      health: c.provider.health,
    })),
    selected: first.selected ? { providerId: first.selected.provider.id, name: first.selected.provider.name } : null,
    backup: first.backup ? { providerId: first.backup.provider.id, name: first.backup.provider.name } : null,
    reason: first.reason,
    allocations: allocations.map((a, i) => ({ providerId: a.provider.id, name: a.provider.name, recipients: a.recipients, segments: a.segments, estimatedCost: money(costs[i]) })),
    unroutedRecipients: left,
    estimate: {
      providerCost: money(providerCost),
      revenue: revenue ? money(revenue) : null,
      revenuePerCredit: perCredit ? perCredit.toFixed(4) : null,
      grossMargin: revenue ? money(revenue.minus(providerCost)) : null,
    },
  };
}
