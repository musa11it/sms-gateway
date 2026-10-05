import { Prisma, type CapacityEntryType, type SmsProvider } from '@prisma/client';
import { logger } from '../../config/logger';
import { prisma, type Tx } from '../../config/prisma';
import { SmsProviderFactory } from '../../integrations/sms/SmsProviderFactory';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { nextCounterValue } from '../../utils/counter';
import { AppError } from '../../utils/errors';
import { stringList } from '../../utils/json';
import { audit } from '../audit-logs/audit.service';
import { notifyStaff } from '../notifications/notification.service';

/**
 * Supply side of the business: SMS capacity we buy from upstream providers.
 *
 * Units: provider capacity is counted in SMS *segments* (what networks bill us for).
 * Customer wallets are counted in *credits* (segments × sms.creditsPerSegment).
 *
 * Cost basis: weighted-average cost (WAC) of all capacity purchased from a provider
 * = totalSpent / totalPurchased. The cost of each message is snapshotted on the recipient
 * row at reservation time, so later price changes never rewrite history.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export function weightedAverageCost(p: Pick<SmsProvider, 'totalSpent' | 'totalPurchased' | 'costPerSms'>): Prisma.Decimal {
  return p.totalPurchased > 0 ? D(p.totalSpent).div(p.totalPurchased) : D(p.costPerSms);
}

export function serializeProvider(p: SmsProvider) {
  const adapterKey = SmsProviderFactory.keyFor(p);
  const available = SmsProviderFactory.has(adapterKey);
  return {
    ...p,
    costPerSms: D(p.costPerSms).toFixed(4),
    totalSpent: D(p.totalSpent).toFixed(2),
    averageCost: weightedAverageCost(p).toFixed(4),
    effectiveMode: SmsProviderFactory.effectiveMode(p),
    adapterKey,
    adapterInstalled: available,
    apiConfigured: available,
    capacityState: p.capacityBalance <= 0 ? 'EMPTY' : p.capacityBalance < p.lowCapacityThreshold ? 'LOW' : 'OK',
  };
}

// ── Capacity ledger primitive ───────────────────────────────────────────

interface CapacityEntry {
  providerId: string;
  type: CapacityEntryType;
  /** Signed segments: + adds capacity, - consumes it. */
  amount: number;
  reference: string;
  description: string;
  unitCost?: Prisma.Decimal | null;
  createdById?: string | null;
}

/**
 * Apply one capacity movement inside the caller's transaction. Consumption uses a
 * conditional UPDATE so capacity can never go below zero (or below the configured overdraft);
 * the unique `reference` makes every movement idempotent.
 */
export async function applyCapacityEntry(tx: Tx, e: CapacityEntry) {
  if (!Number.isInteger(e.amount) || e.amount === 0) throw new Error('Capacity amount must be a non-zero integer');
  const existing = await tx.providerCapacityLedger.findUnique({ where: { reference: e.reference } });
  if (existing) return { entry: existing, duplicate: true as const };

  if (e.amount < 0) {
    const need = -e.amount;
    const now = new Date();
    const rows = await tx.$executeRaw`
      UPDATE sms_providers
      SET capacityBalance = capacityBalance - ${need},
          totalUsed = totalUsed + ${e.type === 'USAGE' ? need : 0},
          lastTransactionAt = ${now}, updatedAt = ${now}
      WHERE id = ${e.providerId}
        AND capacityBalance - ${need} >= CASE WHEN allowOverdraft THEN -overdraftLimit ELSE 0 END`;
    if (rows === 0) {
      throw new AppError(503, 'PROVIDER_CAPACITY_UNAVAILABLE', 'SMS capacity is temporarily unavailable for this route. Please try again later or contact support.');
    }
  } else {
    const now = new Date();
    await tx.$executeRaw`
      UPDATE sms_providers
      SET capacityBalance = capacityBalance + ${e.amount},
          totalUsed = GREATEST(0, totalUsed - ${e.type === 'RELEASE' ? e.amount : 0}),
          lastTransactionAt = ${now}, updatedAt = ${now}
      WHERE id = ${e.providerId}`;
  }
  const after = await tx.smsProvider.findUniqueOrThrow({ where: { id: e.providerId }, select: { capacityBalance: true } });
  const entry = await tx.providerCapacityLedger.create({
    data: {
      providerId: e.providerId,
      type: e.type,
      amount: e.amount,
      balanceBefore: after.capacityBalance - e.amount,
      balanceAfter: after.capacityBalance,
      reference: e.reference,
      description: e.description,
      unitCost: e.unitCost ?? null,
      createdById: e.createdById ?? null,
    },
  });
  return { entry, duplicate: false as const };
}

// ── Purchasing capacity from a provider ────────────────────────────────

async function nextPurchaseReference(tx: Tx) {
  return `PUR-${String(await nextCounterValue(tx, 'provider-purchase')).padStart(5, '0')}`;
}

export async function purchaseCapacity(
  providerId: string,
  input: { quantity: number; unitCost?: string; notes?: string },
  actor: Actor,
  meta?: RequestMeta,
) {
  const provider = await prisma.smsProvider.findUnique({ where: { id: providerId } });
  if (!provider) throw AppError.notFound('Provider');
  if (provider.status !== 'ACTIVE') throw AppError.conflict('Only active providers can be purchased from', 'PROVIDER_INACTIVE');
  const adapter = SmsProviderFactory.forProvider(provider);
  if (!adapter) throw AppError.conflict(`No ${SmsProviderFactory.effectiveMode(provider).toLowerCase()} adapter is installed for ${provider.name}`, 'ADAPTER_NOT_INSTALLED');

  const unitCost = D(input.unitCost ?? provider.costPerSms);
  const totalCost = unitCost.mul(input.quantity).toDecimalPlaces(2);
  const purchase = await prisma.$transaction(async (tx) =>
    tx.providerPurchase.create({
      data: {
        reference: await nextPurchaseReference(tx),
        providerId,
        quantity: input.quantity,
        unitCost,
        totalCost,
        currency: provider.currency,
        status: 'PENDING',
        notes: input.notes,
        createdById: actorUserId(actor),
      },
    }),
  );

  let result;
  try {
    result = await adapter.purchaseCapacity({ quantity: input.quantity, reference: purchase.reference, unitCost: unitCost.toFixed(4) });
  } catch (err) {
    result = { accepted: false as const, errorCode: 'PROVIDER_ERROR', errorMessage: (err as Error).message };
  }

  if (!result.accepted) {
    const failed = await prisma.providerPurchase.update({ where: { id: purchase.id }, data: { status: 'FAILED', failureReason: `${result.errorCode}: ${result.errorMessage}`, completedAt: new Date() } });
    await audit({ actor, action: 'PROVIDER_PURCHASE_FAILED', resource: 'provider_purchase', resourceId: purchase.id, metadata: { provider: provider.code, quantity: input.quantity, error: result.errorCode }, meta });
    return failed;
  }

  const confirmedUnit = D(result.unitCost);
  const confirmedTotal = confirmedUnit.mul(input.quantity).toDecimalPlaces(2);
  return prisma.$transaction(async (tx) => {
    const done = await tx.providerPurchase.update({
      where: { id: purchase.id },
      data: { status: 'SUCCESS', providerReference: result.providerReference, unitCost: confirmedUnit, totalCost: confirmedTotal, completedAt: new Date() },
    });
    await applyCapacityEntry(tx, {
      providerId,
      type: 'PURCHASE',
      amount: input.quantity,
      reference: `purchase:${purchase.id}`,
      description: `Purchase ${purchase.reference} (${result.providerReference})`,
      unitCost: confirmedUnit,
      createdById: actorUserId(actor),
    });
    await tx.smsProvider.update({ where: { id: providerId }, data: { totalPurchased: { increment: input.quantity }, totalSpent: { increment: confirmedTotal } } });
    await audit(
      { actor, action: 'PROVIDER_SMS_PURCHASED', resource: 'provider_purchase', resourceId: purchase.id, metadata: { provider: provider.code, reference: purchase.reference, quantity: input.quantity, unitCost: confirmedUnit.toFixed(4), totalCost: confirmedTotal.toFixed(2) }, meta },
      tx,
    );
    return done;
  });
}

/** Manual reconciliation (e.g. after comparing with the provider-reported balance). */
export async function adjustCapacity(providerId: string, input: { amount: number; reason: string; reference: string }, actor: Actor, meta?: RequestMeta) {
  return prisma.$transaction(async (tx) => {
    const r = await applyCapacityEntry(tx, {
      providerId,
      type: 'ADJUSTMENT',
      amount: input.amount,
      reference: `adjust:${input.reference}`,
      description: input.reason,
      createdById: actorUserId(actor),
    });
    if (r.duplicate) throw AppError.conflict('An adjustment with this reference already exists', 'DUPLICATE_REFERENCE');
    await audit({ actor, action: 'PROVIDER_CAPACITY_ADJUSTED', resource: 'sms_provider', resourceId: providerId, metadata: input, meta }, tx);
    return r.entry;
  });
}

// ── Routing & reservation (used by the SMS service) ────────────────────

export interface RouteAssignment {
  providerId: string;
  adapterKey: string;
  /** Provider cost of ONE segment for this route (WAC). */
  unitCost: Prisma.Decimal;
}

function prefixScore(phone: string, prefixes: string[]) {
  return prefixes.reduce((best, p) => (phone.startsWith(p) && p.length > best ? p.length : best), 0);
}

/**
 * Route every destination to a provider with enough capacity, then reserve (debit) the
 * capacity per provider inside the caller's transaction.
 *
 * Preference: providers whose route prefixes match the number (longest prefix, then priority),
 * then catch-all providers (no prefixes) by priority. Only ACTIVE providers with an installed
 * adapter are eligible. If no eligible provider has capacity the whole send is refused — the
 * platform never silently oversells capacity (unless a provider has an explicit overdraft).
 */
export async function routeAndReserve(tx: Tx, input: { reservationRef: string; phones: string[]; segmentsPerRecipient: number; actor?: Actor }) {
  const providers = (await tx.smsProvider.findMany({ where: { status: 'ACTIVE' }, orderBy: { priority: 'asc' } })).filter((p) => SmsProviderFactory.forProvider(p));
  if (providers.length === 0) {
    throw new AppError(503, 'PROVIDER_CAPACITY_UNAVAILABLE', 'SMS sending is temporarily unavailable. Please try again later or contact support.');
  }
  const remaining = new Map(providers.map((p) => [p.id, p.capacityBalance + (p.allowOverdraft ? p.overdraftLimit : 0)]));
  const assignment = new Map<string, RouteAssignment>();
  const perProvider = new Map<string, number>();
  const need = input.segmentsPerRecipient;

  for (const phone of input.phones) {
    const candidates = providers
      .map((p) => {
        const prefixes = stringList(p.routePrefixes);
        return { p, prefixes, score: prefixes.length === 0 ? 0 : prefixScore(phone, prefixes) };
      })
      .filter((c) => c.prefixes.length === 0 || c.score > 0)
      .sort((a, b) => b.score - a.score || a.p.priority - b.p.priority);
    const chosen = candidates.find((c) => (remaining.get(c.p.id) ?? 0) >= need);
    if (!chosen) {
      void notifyStaff('providers.manage', {
        type: 'LOW_BALANCE',
        title: 'Provider capacity exhausted',
        body: `A customer send was refused: no provider has capacity for ${phone.slice(0, 6)}… Buy capacity under SMS Providers.`,
        link: '/admin/providers',
      });
      throw new AppError(503, 'PROVIDER_CAPACITY_UNAVAILABLE', 'SMS capacity is temporarily unavailable for some destinations. Please try again later or contact support.');
    }
    remaining.set(chosen.p.id, (remaining.get(chosen.p.id) ?? 0) - need);
    perProvider.set(chosen.p.id, (perProvider.get(chosen.p.id) ?? 0) + need);
    assignment.set(phone, { providerId: chosen.p.id, adapterKey: SmsProviderFactory.keyFor(chosen.p), unitCost: weightedAverageCost(chosen.p) });
  }

  for (const [providerId, segments] of perProvider) {
    const p = providers.find((x) => x.id === providerId)!;
    await applyCapacityEntry(tx, {
      providerId,
      type: 'USAGE',
      amount: -segments,
      reference: `usage:${input.reservationRef}:${providerId}`,
      description: `SMS usage (${segments.toLocaleString()} segments)`,
      unitCost: weightedAverageCost(p),
      createdById: input.actor ? actorUserId(input.actor) : null,
    });
    const after = p.capacityBalance - segments;
    if (p.capacityBalance >= p.lowCapacityThreshold && after < p.lowCapacityThreshold) {
      void notifyStaff('providers.manage', {
        type: 'LOW_BALANCE',
        title: `${p.name} capacity is low`,
        body: `${after.toLocaleString()} SMS left (threshold ${p.lowCapacityThreshold.toLocaleString()}).`,
        link: '/admin/providers',
      });
    }
  }
  return assignment;
}

/** Return unused capacity for one recipient (rejected at submission / cancelled). Idempotent. */
export async function releaseRecipientCapacity(tx: Tx, r: { id: string; providerId: string | null; capacityReleased: boolean; attempts: number }, segments: number, reason: string) {
  if (!r.providerId || r.capacityReleased) return;
  const claimed = await tx.smsRecipient.updateMany({ where: { id: r.id, capacityReleased: false }, data: { capacityReleased: true } });
  if (claimed.count === 0) return;
  await applyCapacityEntry(tx, {
    providerId: r.providerId,
    type: 'RELEASE',
    amount: segments,
    reference: `release:${r.id}:${r.attempts}`,
    description: `Released: ${reason}`,
  });
}

/** Release capacity for every unreleased recipient of a batch (scheduled send cancelled). */
export async function releaseMessageCapacity(tx: Tx, messageId: string, segments: number) {
  const rows = await tx.smsRecipient.groupBy({ by: ['providerId'], where: { messageId, capacityReleased: false, providerId: { not: null } }, _count: true });
  await tx.smsRecipient.updateMany({ where: { messageId, capacityReleased: false }, data: { capacityReleased: true } });
  for (const r of rows) {
    await applyCapacityEntry(tx, {
      providerId: r.providerId!,
      type: 'RELEASE',
      amount: r._count * segments,
      reference: `release-batch:${messageId}:${r.providerId}`,
      description: `Released: scheduled send cancelled`,
    });
  }
}

// ── Sender ID registration with upstream networks ──────────────────────

export async function registerSenderWithProviders(senderId: string) {
  const sender = await prisma.senderId.findUnique({ where: { id: senderId }, include: { organization: true } });
  if (!sender) return;
  const providers = await prisma.smsProvider.findMany({ where: { status: 'ACTIVE' } });
  for (const p of providers) {
    const adapter = SmsProviderFactory.forProvider(p);
    if (!adapter) continue;
    try {
      const r = await adapter.registerSenderId({ senderId: sender.name, organizationName: sender.organization.name, purpose: sender.purpose });
      await prisma.senderIdRegistration.upsert({
        where: { senderId_providerId: { senderId, providerId: p.id } },
        create: { senderId, providerId: p.id, status: r.status, providerReference: r.providerReference, message: r.message },
        update: { status: r.status, providerReference: r.providerReference, message: r.message },
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, provider: p.code, senderId }, 'Sender ID registration failed');
      await prisma.senderIdRegistration.upsert({
        where: { senderId_providerId: { senderId, providerId: p.id } },
        create: { senderId, providerId: p.id, status: 'FAILED', message: (err as Error).message },
        update: { status: 'FAILED', message: (err as Error).message },
      });
    }
  }
}

/** Average cost per segment across all providers (used to estimate the cost of credits sold). */
export async function platformAverageCost(): Promise<Prisma.Decimal> {
  const agg = await prisma.smsProvider.aggregate({ _sum: { totalSpent: true, totalPurchased: true } });
  const purchased = agg._sum.totalPurchased ?? 0;
  if (purchased > 0) return D(agg._sum.totalSpent ?? 0).div(purchased);
  const cheapest = await prisma.smsProvider.findFirst({ where: { status: 'ACTIVE' }, orderBy: { costPerSms: 'asc' } });
  return cheapest ? D(cheapest.costPerSms) : D(0);
}
