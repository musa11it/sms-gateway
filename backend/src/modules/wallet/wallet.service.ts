import crypto from 'crypto';
import { Prisma, type WalletTransactionType } from '@prisma/client';
import { prisma, type Tx } from '../../config/prisma';
import { logger } from '../../config/logger';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { queue } from '../../workers/queue';
import { audit } from '../audit-logs/audit.service';
import { notifyOrganization } from '../notifications/notification.service';
import { releaseSenderCredits } from '../senders/allocation.service';
import { emitWebhookEvent } from '../webhooks/webhook.service';
import { consumeLots, createLot, latestExpiry, readConsumption, restoreLots } from './creditLots';

export interface LedgerEntry {
  organizationId: string;
  type: WalletTransactionType;
  /** Signed number of credits: > 0 credits the wallet, < 0 debits it. */
  amount: number;
  /** Idempotency key. The same reference can only ever be applied once. */
  reference: string;
  description: string;
  createdById?: string | null;
  metadata?: Record<string, unknown>;
  /** Credits: when the added credits expire (null/omitted = never). */
  expiresAt?: Date | null;
  /** Credits: reference of the debit being reversed. The credits go back to the lots (and sender ID allocation) it consumed. */
  restoreOf?: string;
  /** Debits: consume this credit lot before the FEFO order (expiry, purchase reversal). */
  preferLotId?: string;
}

export function isDuplicateReference(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    String((err.meta as { target?: unknown })?.target ?? '').includes('reference')
  );
}

/**
 * Apply one ledger entry inside the caller's transaction.
 *
 * - Debits use a conditional UPDATE (balance >= amount) so concurrent debits can never
 *   overdraw the wallet; a CHECK constraint (balance >= 0) backs this up in the database.
 * - The wallet row lock taken by the UPDATE serialises concurrent entries, so
 *   balanceBefore/balanceAfter are exact.
 * - `reference` is UNIQUE: re-applying the same payment/refund/debit fails and the whole
 *   transaction rolls back (callers treat that as "already applied").
 * - Credit lots move with the balance (see creditLots.ts): debits consume lots FEFO and record
 *   which lots they used; credits open a lot, or refill the lots of the debit they reverse.
 */
export async function applyLedgerEntry(tx: Tx, entry: LedgerEntry) {
  if (!Number.isInteger(entry.amount) || entry.amount === 0) throw new Error('Ledger amount must be a non-zero integer');

  const existing = await tx.walletTransaction.findUnique({ where: { reference: entry.reference } });
  if (existing) return { transaction: existing, duplicate: true as const };

  const wallet = await tx.wallet.findUnique({ where: { organizationId: entry.organizationId } });
  if (!wallet) throw AppError.notFound('Wallet');

  if (entry.amount < 0) {
    const debit = -entry.amount;
    const res = await tx.wallet.updateMany({
      where: { id: wallet.id, balance: { gte: debit } },
      data: { balance: { decrement: debit } },
    });
    if (res.count === 0) {
      throw AppError.paymentRequired(
        `Insufficient SMS credits: ${debit.toLocaleString()} required, ${wallet.balance.toLocaleString()} available`,
        'INSUFFICIENT_CREDITS',
      );
    }
  } else {
    await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: entry.amount } } });
  }

  const transactionId = crypto.randomUUID();
  let metadata = entry.metadata;
  if (entry.amount < 0) {
    metadata = { ...metadata, lots: await consumeLots(tx, wallet.id, -entry.amount, entry.preferLotId) };
  } else {
    const original = entry.restoreOf ? await tx.walletTransaction.findUnique({ where: { reference: entry.restoreOf } }) : null;
    let leftover = entry.amount;
    if (original) {
      const consumed = readConsumption(original.metadata);
      const r = await restoreLots(tx, consumed, entry.amount);
      leftover = r.leftover;
      metadata = { ...metadata, restoredLots: r.restored };
      const allocationId = (original.metadata as { allocationId?: unknown } | null)?.allocationId;
      if (typeof allocationId === 'string') await releaseSenderCredits(tx, allocationId, entry.amount);
      if (leftover > 0) entry = { ...entry, expiresAt: await latestExpiry(tx, consumed) };
    }
    if (leftover > 0) {
      await createLot(tx, { walletId: wallet.id, organizationId: entry.organizationId, transactionId, type: entry.type, credits: leftover, expiresAt: entry.expiresAt });
    }
  }

  const after = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id }, select: { balance: true } });
  const transaction = await tx.walletTransaction.create({
    data: {
      id: transactionId,
      walletId: wallet.id,
      organizationId: entry.organizationId,
      type: entry.type,
      amount: entry.amount,
      balanceBefore: after.balance - entry.amount,
      balanceAfter: after.balance,
      reference: entry.reference,
      description: entry.description,
      createdById: entry.createdById ?? null,
      metadata: metadata as Prisma.InputJsonValue | undefined,
    },
  });
  return { transaction, duplicate: false as const };
}

export async function getWallet(organizationId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { organizationId } });
  if (!wallet) throw AppError.notFound('Wallet');
  return wallet;
}

export async function scheduleLowBalanceCheck(organizationId: string) {
  await queue.enqueue('wallet.lowBalanceCheck', { organizationId }, { jobId: organizationId, delayMs: 500 });
}

/** Sends one low-balance alert per dip below the threshold; re-arms after a top-up. */
export async function checkLowBalance(organizationId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { organizationId } });
  if (!wallet) return;
  if (wallet.balance < wallet.lowBalanceThreshold && !wallet.lowBalanceNotifiedAt) {
    const claimed = await prisma.wallet.updateMany({
      where: { id: wallet.id, lowBalanceNotifiedAt: null },
      data: { lowBalanceNotifiedAt: new Date() },
    });
    if (claimed.count === 1) {
      await notifyOrganization(
        organizationId,
        {
          type: 'LOW_BALANCE',
          title: 'Low SMS balance',
          body: `Your balance is ${wallet.balance.toLocaleString()} credits, below your alert threshold of ${wallet.lowBalanceThreshold.toLocaleString()}.`,
          link: '/app/wallet/buy',
        },
        'wallet.view',
      );
      await emitWebhookEvent(organizationId, 'wallet.low_balance', { balance: wallet.balance, threshold: wallet.lowBalanceThreshold, unit: 'credits' });
      logger.info({ organizationId, balance: wallet.balance }, 'Low balance notification sent');
    }
  } else if (wallet.balance >= wallet.lowBalanceThreshold && wallet.lowBalanceNotifiedAt) {
    await prisma.wallet.update({ where: { id: wallet.id }, data: { lowBalanceNotifiedAt: null } });
  }
}

export async function updateLowBalanceThreshold(organizationId: string, threshold: number, actor: Actor, meta: RequestMeta) {
  const wallet = await prisma.wallet.update({ where: { organizationId }, data: { lowBalanceThreshold: threshold, lowBalanceNotifiedAt: null } });
  await audit({ actor, action: 'WALLET_THRESHOLD_UPDATED', resource: 'wallet', resourceId: wallet.id, organizationId, metadata: { threshold }, meta });
  await scheduleLowBalanceCheck(organizationId);
  return wallet;
}

const ADJUSTMENT_TYPES = {
  CREDIT: { type: 'ADMIN_CREDIT', sign: 1, action: 'WALLET_CREDITED' },
  DEBIT: { type: 'ADMIN_DEBIT', sign: -1, action: 'WALLET_DEBITED' },
  REFUND: { type: 'REFUND', sign: 1, action: 'REFUND_CREATED' },
} as const;

/** Staff adjustment. Requires amount, reason and an external reference; fully audited. */
export async function adminAdjust(
  input: { organizationId: string; kind: keyof typeof ADJUSTMENT_TYPES; amount: number; reason: string; reference: string },
  actor: Actor,
  meta: RequestMeta,
) {
  const cfg = ADJUSTMENT_TYPES[input.kind];
  const reference = `admin:${input.kind.toLowerCase()}:${input.reference}`;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: input.organizationId } });
      if (!org) throw AppError.notFound('Organization');
      const r = await applyLedgerEntry(tx, {
        organizationId: input.organizationId,
        type: cfg.type,
        amount: cfg.sign * input.amount,
        reference,
        description: input.reason,
        createdById: actorUserId(actor),
        metadata: { externalReference: input.reference, kind: input.kind },
      });
      if (r.duplicate) throw AppError.conflict('An adjustment with this reference already exists', 'DUPLICATE_REFERENCE');
      await audit(
        {
          actor,
          action: cfg.action,
          resource: 'wallet',
          resourceId: r.transaction.walletId,
          organizationId: input.organizationId,
          metadata: { amount: input.amount, kind: input.kind, reason: input.reason, reference: input.reference, balanceAfter: r.transaction.balanceAfter },
          meta,
        },
        tx,
      );
      return r.transaction;
    });
    await notifyOrganization(
      input.organizationId,
      {
        type: cfg.sign > 0 ? 'WALLET_CREDITED' : 'WALLET_DEBITED',
        title: cfg.sign > 0 ? 'Credits added to your wallet' : 'Credits deducted from your wallet',
        body: `${input.amount.toLocaleString()} credits ${cfg.sign > 0 ? 'added' : 'deducted'}: ${input.reason}`,
        link: '/app/wallet/transactions',
      },
      'wallet.view',
    );
    await scheduleLowBalanceCheck(input.organizationId);
    return result;
  } catch (err) {
    if (isDuplicateReference(err)) throw AppError.conflict('An adjustment with this reference already exists', 'DUPLICATE_REFERENCE');
    throw err;
  }
}

/**
 * Sweep: expire credit lots past their expiry. Each lot is written off with an EXPIRATION
 * ledger entry (the lot itself is kept, with expiredAt set).
 */
export async function expireCreditLots() {
  const now = new Date();
  const due = await prisma.smsCreditLot.findMany({ where: { expiresAt: { lte: now }, remaining: { gt: 0 } }, orderBy: { expiresAt: 'asc' }, take: 200 });
  const expired = new Map<string, number>();
  for (const lot of due) {
    try {
      const n = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${lot.walletId} FOR UPDATE`;
        const fresh = await tx.smsCreditLot.findUniqueOrThrow({ where: { id: lot.id } });
        if (fresh.remaining === 0 || !fresh.expiresAt || fresh.expiresAt > now) return 0;
        await applyLedgerEntry(tx, {
          organizationId: lot.organizationId,
          type: 'EXPIRATION',
          amount: -fresh.remaining,
          reference: `expire:lot:${lot.id}:${now.getTime()}`,
          description: `${fresh.remaining.toLocaleString()} credits expired (valid until ${fresh.expiresAt.toISOString().slice(0, 10)})`,
          preferLotId: lot.id,
          metadata: { lotId: lot.id, expiresAt: fresh.expiresAt },
        });
        await tx.smsCreditLot.update({ where: { id: lot.id }, data: { expiredAt: now } });
        return fresh.remaining;
      });
      if (n > 0) expired.set(lot.organizationId, (expired.get(lot.organizationId) ?? 0) + n);
    } catch (err) {
      logger.error({ err, lotId: lot.id }, 'Credit lot expiry failed');
    }
  }
  for (const [organizationId, credits] of expired) {
    await notifyOrganization(
      organizationId,
      { type: 'CREDITS_EXPIRED', title: 'SMS credits expired', body: `${credits.toLocaleString()} unused SMS credits reached their expiry date and were removed from your wallet.`, link: '/app/wallet/transactions' },
      'wallet.view',
    );
    await scheduleLowBalanceCheck(organizationId);
  }
  return { lots: due.length, organizations: expired.size };
}
