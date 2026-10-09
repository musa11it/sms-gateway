import type { Prisma, WalletTransactionType } from '@prisma/client';
import type { Tx } from '../../config/prisma';
import { AppError } from '../../utils/errors';

/**
 * Credit lots: every credit added to a wallet lands in a lot with its own (optional) expiry,
 * and every debit consumes lots First-Expiring-First-Out. Invariant, maintained inside the
 * wallet's ledger transaction: wallet.balance = Σ lot.remaining.
 *
 * These helpers run inside applyLedgerEntry, after the wallet row has been updated (and so
 * locked) in the same transaction, which serialises all lot changes of one wallet.
 *
 * Network credits: a lot bought for a destination network (networkId set) is only ever spent on
 * recipients of that network. General lots (networkId null — every purchase before network pricing,
 * admin credits, general-tier purchases) are usable on any network. A debit for network N uses
 * N's own lots first, then general lots; it never touches another network's lots.
 */

export interface LotConsumption {
  lotId: string;
  credits: number;
  /** Selling price of one credit of the lot (null = free credits). Recorded on debits so revenue never depends on today's prices. */
  unitPrice?: string | null;
  /** Network the lot is restricted to (null/absent = general credits). */
  networkId?: string | null;
}

/** Part of a debit that must be paid from credits valid for one destination (null = no known network: general credits only). */
export interface NetworkScope {
  networkId: string | null;
  credits: number;
  /** Shown in the error when the credits are insufficient. */
  label?: string;
}

type Lot = { id: string; credits: number; remaining: number; expiresAt: Date | null; createdAt: Date; unitPrice?: Prisma.Decimal | null; networkId?: string | null };

/** FEFO order: soonest expiry first, non-expiring lots last, oldest first within a tie. */
function fefo(a: Lot, b: Lot) {
  const ea = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const eb = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return ea - eb || a.createdAt.getTime() - b.createdAt.getTime();
}

export async function createLot(
  tx: Tx,
  input: { walletId: string; organizationId: string; transactionId: string; type: WalletTransactionType; credits: number; expiresAt?: Date | null; unitPrice?: Prisma.Decimal | string | null; networkId?: string | null },
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
      unitPrice: input.unitPrice ?? null,
      networkId: input.networkId ?? null,
    },
  });
}

const slice = (lot: Lot, n: number): LotConsumption => ({ lotId: lot.id, credits: n, unitPrice: lot.unitPrice?.toFixed(4) ?? null, networkId: lot.networkId ?? null });

/**
 * Take `amount` credits from the wallet's lots.
 *  - Without scopes (staff debits, expiry, purchase reversal): a preferred lot first, then FEFO over all lots.
 *  - With scopes (SMS charges): each scope, in order, from its network's lots then general lots (FEFO
 *    within each). Throws INSUFFICIENT_NETWORK_CREDITS — rolling back the whole transaction — when a
 *    destination lacks credits valid for it, even if the wallet total would cover the charge.
 */
export async function consumeLots(tx: Tx, walletId: string, amount: number, preferLotId?: string, scopes?: NetworkScope[]): Promise<LotConsumption[]> {
  const lots: Lot[] = await tx.smsCreditLot.findMany({ where: { walletId, remaining: { gt: 0 } } });
  const taken: LotConsumption[] = [];
  const take = async (lot: Lot, want: number) => {
    const n = Math.min(lot.remaining, want);
    if (n <= 0) return 0;
    await tx.smsCreditLot.update({ where: { id: lot.id }, data: { remaining: { decrement: n } } });
    lot.remaining -= n;
    taken.push(slice(lot, n));
    return n;
  };

  if (scopes?.length) {
    if (scopes.reduce((s, x) => s + x.credits, 0) !== amount) throw new Error('Network scopes must add up to the debit amount');
    for (const scope of scopes) {
      const own = scope.networkId ? lots.filter((l) => l.networkId === scope.networkId).sort((a, b) => (a.id === preferLotId ? -1 : b.id === preferLotId ? 1 : fefo(a, b))) : [];
      const general = lots.filter((l) => !l.networkId).sort(fefo);
      const usable = [...own, ...general];
      const available = usable.reduce((s, l) => s + l.remaining, 0);
      if (available < scope.credits) {
        const where = scope.label ?? (scope.networkId ? 'this network' : 'numbers outside a configured network');
        throw AppError.paymentRequired(
          `Insufficient SMS credits for ${where}: ${scope.credits.toLocaleString()} required, ${available.toLocaleString()} available (credits bought for another network cannot be used)`,
          'INSUFFICIENT_NETWORK_CREDITS',
        );
      }
      let left = scope.credits;
      for (const lot of usable) {
        if (left === 0) break;
        left -= await take(lot, left);
      }
    }
    return taken;
  }

  lots.sort((a, b) => (a.id === preferLotId ? -1 : b.id === preferLotId ? 1 : fefo(a, b)));
  let left = amount;
  for (const lot of lots) {
    if (left === 0) break;
    left -= await take(lot, left);
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
    restored.push({ lotId: lot.id, credits: n, networkId: lot.networkId ?? null });
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

/** Network of credits that must go back into a new lot: the consumed lots' network when they agree, else general. */
export async function consumedNetwork(tx: Tx, consumed: LotConsumption[]): Promise<string | null> {
  const lots = await tx.smsCreditLot.findMany({ where: { id: { in: consumed.map((c) => c.lotId) } }, select: { networkId: true } });
  const ids = new Set(lots.map((l) => l.networkId ?? null));
  return ids.size === 1 ? [...ids][0] : null;
}

export function readConsumption(metadata: unknown): LotConsumption[] {
  const lots = (metadata as { lots?: unknown } | null)?.lots;
  return Array.isArray(lots) ? lots.filter((l): l is LotConsumption => typeof l?.lotId === 'string' && Number.isInteger(l?.credits)) : [];
}

/** Selling price of the first priced lot in a consumption (used when restored credits must open a new lot). */
export function consumedPrice(consumed: LotConsumption[]): string | null {
  return consumed.find((c) => c.unitPrice != null)?.unitPrice ?? null;
}
