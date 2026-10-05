import type { WalletTransactionType } from '@prisma/client';
import type { Tx } from '../../config/prisma';

/**
 * Credit lots: every credit added to a wallet lands in a lot with its own (optional) expiry,
 * and every debit consumes lots First-Expiring-First-Out. Invariant, maintained inside the
 * wallet's ledger transaction: wallet.balance = Σ lot.remaining.
 *
 * These helpers run inside applyLedgerEntry, after the wallet row has been updated (and so
 * locked) in the same transaction, which serialises all lot changes of one wallet.
 */

export interface LotConsumption {
  lotId: string;
  credits: number;
}

type Lot = { id: string; credits: number; remaining: number; expiresAt: Date | null; createdAt: Date };

/** FEFO order: soonest expiry first, non-expiring lots last, oldest first within a tie. */
function fefo(a: Lot, b: Lot) {
  const ea = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const eb = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return ea - eb || a.createdAt.getTime() - b.createdAt.getTime();
}

export async function createLot(
  tx: Tx,
  input: { walletId: string; organizationId: string; transactionId: string; type: WalletTransactionType; credits: number; expiresAt?: Date | null },
) {
  return tx.smsCreditLot.create({
    data: {
      walletId: input.walletId,
      organizationId: input.organizationId,
      sourceTransactionId: input.transactionId,
      sourceType: input.type,
      credits: input.credits,
      remaining: input.credits,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

/** Take `amount` credits from the wallet's lots (a preferred lot first, then FEFO). */
export async function consumeLots(tx: Tx, walletId: string, amount: number, preferLotId?: string): Promise<LotConsumption[]> {
  const lots = await tx.smsCreditLot.findMany({ where: { walletId, remaining: { gt: 0 } } });
  lots.sort((a, b) => (a.id === preferLotId ? -1 : b.id === preferLotId ? 1 : fefo(a, b)));
  const taken: LotConsumption[] = [];
  let left = amount;
  for (const lot of lots) {
    if (left === 0) break;
    const n = Math.min(lot.remaining, left);
    await tx.smsCreditLot.update({ where: { id: lot.id }, data: { remaining: { decrement: n } } });
    taken.push({ lotId: lot.id, credits: n });
    left -= n;
  }
  if (left > 0) throw new Error(`Credit lots out of sync with wallet ${walletId}: ${left} credits missing`);
  return taken;
}

/**
 * Give credits back to the lots an earlier debit consumed (latest-expiring first), so a refund
 * keeps the original expiry. Returns how many credits could not be placed (lot already full).
 */
export async function restoreLots(tx: Tx, consumed: LotConsumption[], amount: number): Promise<{ restored: LotConsumption[]; leftover: number }> {
  const lots = await tx.smsCreditLot.findMany({ where: { id: { in: consumed.map((c) => c.lotId) } } });
  lots.sort((a, b) => fefo(b, a));
  const restored: LotConsumption[] = [];
  let left = amount;
  for (const lot of lots) {
    if (left === 0) break;
    const taken = consumed.filter((c) => c.lotId === lot.id).reduce((s, c) => s + c.credits, 0);
    const n = Math.min(left, taken, lot.credits - lot.remaining);
    if (n <= 0) continue;
    await tx.smsCreditLot.update({ where: { id: lot.id }, data: { remaining: { increment: n } } });
    restored.push({ lotId: lot.id, credits: n });
    left -= n;
  }
  return { restored, leftover: left };
}

/** Latest expiry among consumed lots (null if any of them never expires). */
export async function latestExpiry(tx: Tx, consumed: LotConsumption[]): Promise<Date | null> {
  const lots = await tx.smsCreditLot.findMany({ where: { id: { in: consumed.map((c) => c.lotId) } }, select: { expiresAt: true } });
  if (!lots.length || lots.some((l) => !l.expiresAt)) return null;
  return new Date(Math.max(...lots.map((l) => l.expiresAt!.getTime())));
}

export function readConsumption(metadata: unknown): LotConsumption[] {
  const lots = (metadata as { lots?: unknown } | null)?.lots;
  return Array.isArray(lots) ? lots.filter((l): l is LotConsumption => typeof l?.lotId === 'string' && Number.isInteger(l?.credits)) : [];
}
