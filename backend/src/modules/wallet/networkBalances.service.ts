import { prisma } from '../../config/prisma';
import { REALIZED_STATUSES } from '../finance/smsFinancials.service';

/**
 * An organization's credits by destination network. The wallet balance is the single total; each
 * credit lot says where its credits may be spent (networkId null = general credits, any network).
 * Expired lots have remaining 0, so only spendable credits are counted.
 */
export async function networkBalances(organizationId: string) {
  const [wallet, lots] = await Promise.all([
    prisma.wallet.findUnique({ where: { organizationId }, select: { balance: true } }),
    prisma.smsCreditLot.groupBy({ by: ['networkId'], where: { organizationId, remaining: { gt: 0 } }, _sum: { remaining: true }, _min: { expiresAt: true } }),
  ]);
  const ids = lots.map((l) => l.networkId).filter((id): id is string => !!id);
  const networks = ids.length ? await prisma.smsNetwork.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, code: true, countryCode: true, countryName: true, isActive: true, inMaintenance: true } }) : [];
  const general = lots.find((l) => l.networkId === null);
  return {
    total: wallet?.balance ?? 0,
    general: { credits: general?._sum.remaining ?? 0, nextExpiry: general?._min.expiresAt ?? null },
    networks: lots
      .filter((l) => l.networkId)
      .map((l) => {
        const n = networks.find((x) => x.id === l.networkId);
        return {
          networkId: l.networkId!,
          name: n?.name ?? 'Unknown network',
          code: n?.code ?? null,
          countryCode: n?.countryCode ?? null,
          countryName: n?.countryName ?? null,
          credits: l._sum.remaining ?? 0,
          nextExpiry: l._min.expiresAt,
          // Credits are kept while a network is closed; they can be spent again when it reopens.
          sendable: !!n && n.isActive && !n.inMaintenance,
        };
      })
      .sort((a, b) => (a.countryCode ?? '').localeCompare(b.countryCode ?? '') || a.name.localeCompare(b.name)),
    policy: 'Credits bought for a network can only be used for that network. General credits can be used for any network; network credits are used first.',
  };
}

/** Credits used per destination network in a period (accepted by a provider, not refunded). */
export async function networkUsage(organizationId: string, from: Date, to: Date) {
  const rows = await prisma.smsRecipient.groupBy({
    by: ['networkId', 'countryCode'],
    where: { organizationId, createdAt: { gte: from, lte: to }, status: { in: REALIZED_STATUSES }, refunded: false },
    _count: true,
    _sum: { credits: true },
  });
  const ids = rows.map((r) => r.networkId).filter((id): id is string => !!id);
  const networks = ids.length ? await prisma.smsNetwork.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  return rows
    .map((r) => ({
      networkId: r.networkId,
      name: r.networkId ? (networks.find((n) => n.id === r.networkId)?.name ?? 'Unknown network') : 'Other numbers',
      countryCode: r.countryCode,
      messages: r._count,
      credits: r._sum.credits ?? 0,
    }))
    .sort((a, b) => b.credits - a.credits);
}
