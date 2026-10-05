import type { Prisma, SenderIdAllocation } from '@prisma/client';
import { logger } from '../../config/logger';
import { prisma, type Tx } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { audit } from '../audit-logs/audit.service';
import { notifyOrganization } from '../notifications/notification.service';
import { getSetting } from '../settings/settings.service';

/**
 * Sender ID credit allocations.
 *
 * An allocation reserves part of the organization's wallet for one sender ID; it never creates
 * credits. Sends from an allocated sender ID consume its allocation (and the wallet); sends from
 * other sender IDs may only use the wallet balance that is not reserved. Every check runs with the
 * wallet row locked, so concurrent sends and allocation changes cannot over-commit the wallet.
 */

/** Fallback only for unreadable stored values; new allocations use the senders.defaultAllocationAlertThresholds setting. */
const FALLBACK_ALERT_THRESHOLDS = [50, 25, 10];

async function lockWallet(tx: Tx, organizationId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ balance: number }[]>`SELECT balance FROM wallets WHERE organizationId = ${organizationId} FOR UPDATE`;
  if (!rows.length) throw AppError.notFound('Wallet');
  return Number(rows[0].balance);
}

/** Credits reserved by active allocations (allocated − used), optionally excluding one sender ID. */
async function reservedCredits(tx: Tx, organizationId: string, excludeSenderId?: string): Promise<number> {
  const rows = await tx.$queryRaw<{ reserved: unknown }[]>`
    SELECT COALESCE(SUM(allocated - used), 0) AS reserved FROM sender_id_allocations
    WHERE organizationId = ${organizationId} AND isActive = TRUE AND senderId <> ${excludeSenderId ?? ''}`;
  return Number(rows[0].reserved);
}

/**
 * Called inside the send transaction, before the wallet debit. Returns the allocation consumed
 * (recorded on the ledger entry so refunds can give it back), or null for unallocated senders.
 */
export async function reserveSenderCredits(tx: Tx, input: { organizationId: string; senderId: string; senderName: string; credits: number }) {
  const balance = await lockWallet(tx, input.organizationId);
  const allocation = await tx.senderIdAllocation.findUnique({ where: { senderId: input.senderId } });
  if (allocation?.isActive) {
    const rows = await tx.$executeRaw`
      UPDATE sender_id_allocations SET used = used + ${input.credits}, updatedAt = ${new Date()}
      WHERE id = ${allocation.id} AND isActive = TRUE AND allocated - used >= ${input.credits}`;
    if (rows === 0) {
      const remaining = allocation.allocated - allocation.used;
      throw AppError.paymentRequired(
        `Sender ID "${input.senderName}" has ${remaining.toLocaleString()} allocated credits left; ${input.credits.toLocaleString()} required. Increase its allocation to continue.`,
        'ALLOCATION_EXHAUSTED',
      );
    }
    return { allocationId: allocation.id };
  }
  const reserved = await reservedCredits(tx, input.organizationId);
  if (reserved > 0 && balance - reserved < input.credits) {
    const free = Math.max(0, balance - reserved);
    throw AppError.paymentRequired(
      `Insufficient unallocated credits: ${input.credits.toLocaleString()} required, ${free.toLocaleString()} available (${reserved.toLocaleString()} are reserved for sender ID allocations).`,
      'INSUFFICIENT_CREDITS',
    );
  }
  return { allocationId: null };
}

/** Give credits back to an allocation (refunded or cancelled messages). Never below zero usage. */
export async function releaseSenderCredits(tx: Tx, allocationId: string, credits: number) {
  await tx.$executeRaw`UPDATE sender_id_allocations SET used = GREATEST(used - ${credits}, 0), updatedAt = ${new Date()} WHERE id = ${allocationId}`;
}

export function serializeAllocation(a: SenderIdAllocation) {
  const remaining = a.allocated - a.used;
  return {
    id: a.id,
    senderId: a.senderId,
    allocated: a.allocated,
    used: a.used,
    remaining,
    usagePercent: a.allocated > 0 ? Math.round((a.used / a.allocated) * 1000) / 10 : 0,
    isActive: a.isActive,
    alertThresholds: thresholdsOf(a.alertThresholds),
    lastAlertThreshold: a.lastAlertThreshold,
    updatedAt: a.updatedAt,
  };
}

function thresholdsOf(v: Prisma.JsonValue): number[] {
  return Array.isArray(v) ? v.filter((t): t is number => typeof t === 'number').sort((a, b) => b - a) : FALLBACK_ALERT_THRESHOLDS;
}

export async function allocationOverview(organizationId: string) {
  const [wallet, allocations] = await Promise.all([
    prisma.wallet.findUnique({ where: { organizationId }, select: { balance: true } }),
    prisma.senderIdAllocation.findMany({ where: { organizationId }, include: { sender: { select: { name: true, status: true } } }, orderBy: { createdAt: 'asc' } }),
  ]);
  const balance = wallet?.balance ?? 0;
  const reserved = allocations.filter((a) => a.isActive).reduce((s, a) => s + a.allocated - a.used, 0);
  return {
    balance,
    reserved,
    unallocated: Math.max(0, balance - reserved),
    allocations: allocations.map((a) => ({ ...serializeAllocation(a), senderName: a.sender.name, senderStatus: a.sender.status })),
  };
}

export async function setAllocation(
  organizationId: string,
  senderId: string,
  input: { allocated: number; alertThresholds?: number[] },
  actor: Actor,
  meta?: RequestMeta,
) {
  const result = await prisma.$transaction(async (tx) => {
    const balance = await lockWallet(tx, organizationId);
    const sender = await tx.senderId.findFirst({ where: { id: senderId, organizationId } });
    if (!sender) throw AppError.notFound('Sender ID');
    if (sender.status !== 'APPROVED') throw AppError.conflict('Credits can only be allocated to approved sender IDs', 'SENDER_NOT_APPROVED');
    const before = await tx.senderIdAllocation.findUnique({ where: { senderId } });
    const used = before?.used ?? 0;
    if (input.allocated < used) {
      throw AppError.unprocessable(`The allocation cannot be lower than the ${used.toLocaleString()} credits already used`, 'ALLOCATION_BELOW_USAGE', [
        { field: 'allocated', message: `Minimum ${used.toLocaleString()}` },
      ]);
    }
    const otherReserved = await reservedCredits(tx, organizationId, senderId);
    const maxRemaining = balance - otherReserved;
    if (input.allocated - used > maxRemaining) {
      const max = Math.max(used, used + maxRemaining);
      throw AppError.unprocessable(
        `Not enough unallocated credits: at most ${max.toLocaleString()} can be allocated to "${sender.name}" (wallet balance ${balance.toLocaleString()}, ${otherReserved.toLocaleString()} reserved for other sender IDs).`,
        'ALLOCATION_EXCEEDS_BALANCE',
        [{ field: 'allocated', message: `Maximum ${max.toLocaleString()}` }],
      );
    }
    const alertThresholds = input.alertThresholds ?? (before ? thresholdsOf(before.alertThresholds) : await getSetting('senders.defaultAllocationAlertThresholds'));
    const data = { allocated: input.allocated, alertThresholds, isActive: true, lastAlertThreshold: null, updatedById: actorUserId(actor) };
    const allocation = await tx.senderIdAllocation.upsert({
      where: { senderId },
      create: { organizationId, senderId, ...data, createdById: actorUserId(actor) },
      update: data,
    });
    await audit(
      {
        actor,
        action: 'SENDER_ALLOCATION_SET',
        resource: 'sender_id',
        resourceId: senderId,
        organizationId,
        metadata: { sender: sender.name, allocated: input.allocated, previousAllocated: before?.isActive ? before.allocated : null, used, alertThresholds },
        meta,
      },
      tx,
    );
    return allocation;
  });
  await checkAllocationAlert(result.id);
  return serializeAllocation(await prisma.senderIdAllocation.findUniqueOrThrow({ where: { id: result.id } }));
}

/** Stops reserving credits for the sender ID. Usage history is kept. */
export async function removeAllocation(organizationId: string, senderId: string, actor: Actor, meta?: RequestMeta) {
  const allocation = await prisma.senderIdAllocation.findFirst({ where: { senderId, organizationId, isActive: true }, include: { sender: { select: { name: true } } } });
  if (!allocation) throw AppError.notFound('Allocation');
  await prisma.$transaction(async (tx) => {
    await lockWallet(tx, organizationId);
    await tx.senderIdAllocation.update({ where: { id: allocation.id }, data: { isActive: false, lastAlertThreshold: null, updatedById: actorUserId(actor) } });
    await audit(
      {
        actor,
        action: 'SENDER_ALLOCATION_REMOVED',
        resource: 'sender_id',
        resourceId: senderId,
        organizationId,
        metadata: { sender: allocation.sender.name, allocated: allocation.allocated, used: allocation.used, released: allocation.allocated - allocation.used },
        meta,
      },
      tx,
    );
  });
}

/**
 * Low-allocation reminder. Notifies once per threshold crossed (e.g. at 50%, then 25%, then 10%
 * remaining), and re-arms when the allocation is topped up. A conditional update claims each
 * notification, so concurrent sends cannot notify twice.
 */
export async function checkAllocationAlert(allocationId: string) {
  try {
    const a = await prisma.senderIdAllocation.findUnique({ where: { id: allocationId }, include: { sender: { select: { name: true } } } });
    if (!a || !a.isActive || a.allocated <= 0) return;
    const remaining = a.allocated - a.used;
    const pct = (remaining / a.allocated) * 100;
    const crossed = thresholdsOf(a.alertThresholds).filter((t) => pct <= t);
    const level = crossed.length ? Math.min(...crossed) : null;
    if (level === a.lastAlertThreshold) return;
    if (level === null || (a.lastAlertThreshold !== null && level > a.lastAlertThreshold)) {
      // Back above a threshold after a top-up: re-arm without notifying.
      await prisma.senderIdAllocation.updateMany({ where: { id: a.id, lastAlertThreshold: a.lastAlertThreshold }, data: { lastAlertThreshold: level } });
      return;
    }
    const claimed = await prisma.senderIdAllocation.updateMany({ where: { id: a.id, lastAlertThreshold: a.lastAlertThreshold }, data: { lastAlertThreshold: level } });
    if (claimed.count !== 1) return;
    await notifyOrganization(
      a.organizationId,
      {
        type: 'SENDER_ALLOCATION_LOW',
        title: `${a.sender.name} allocation is running low`,
        body: `Your ${a.sender.name} SMS allocation is running low. You have ${remaining.toLocaleString()} SMS credits remaining (${Math.round(pct)}% of ${a.allocated.toLocaleString()}).`,
        link: '/app/senders',
      },
      'senders.view',
    );
  } catch (err) {
    logger.error({ err, allocationId }, 'Allocation alert check failed');
  }
}
