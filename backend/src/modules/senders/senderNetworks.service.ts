import type { SenderNetworkStatus } from '@prisma/client';
import { prisma, type Db } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { audit } from '../audit-logs/audit.service';
import { notifyOrganization } from '../notifications/notification.service';

/**
 * Sender ID ↔ destination network compatibility.
 *
 * A sender ID is usable on a network only when the sender ID itself is APPROVED, and:
 *  - Network-scoped sender ID (restrictToNetworks: requested for specific telecoms): only
 *    on the networks where its row is APPROVED. An "Airtel" sender ID sends to Airtel numbers only; one
 *    approved for both MTN and Airtel sends to both.
 *  - Unscoped sender ID (created without choosing telecoms): on every
 *    network, except networks that require sender registration, which still need an APPROVED row.
 * Compatibility is never inferred from the sender's name or from approval on another network. It is
 * checked when sending (dashboard, campaigns, API, retries) for every destination network separately.
 */

export type CompatibilityStatus = 'NOT_REQUIRED' | 'APPROVED' | 'PENDING' | 'REJECTED' | 'SUSPENDED' | 'NOT_REGISTERED' | 'SENDER_NOT_APPROVED';

export interface NetworkRef {
  id: string;
  name: string;
  requiresSenderRegistration: boolean;
}

export interface SenderNetworkCheck {
  networkId: string;
  networkName: string;
  status: CompatibilityStatus;
  compatible: boolean;
  reason: string | null;
}

const REASON: Record<Exclude<CompatibilityStatus, 'NOT_REQUIRED' | 'APPROVED'>, string> = {
  PENDING: 'registration on this network is pending approval',
  REJECTED: 'registration on this network was rejected',
  SUSPENDED: 'registration on this network is suspended',
  NOT_REGISTERED: 'not approved for this network',
  SENDER_NOT_APPROVED: 'the sender ID is not approved',
};

/** Per-network compatibility of one sender ID. */
export async function senderCompatibility(db: Db, sender: { id: string; status: string; restrictToNetworks?: boolean }, networks: NetworkRef[]): Promise<SenderNetworkCheck[]> {
  const rows = networks.length ? await db.senderIdNetwork.findMany({ where: { senderId: sender.id } }) : [];
  const scoped = !!sender.restrictToNetworks;
  return networks.map((n) => {
    const row = rows.find((r) => r.networkId === n.id);
    const status: CompatibilityStatus =
      sender.status !== 'APPROVED' ? 'SENDER_NOT_APPROVED' : row ? row.status : scoped || n.requiresSenderRegistration ? 'NOT_REGISTERED' : 'NOT_REQUIRED';
    const compatible = status === 'NOT_REQUIRED' || status === 'APPROVED';
    return { networkId: n.id, networkName: n.name, status, compatible, reason: compatible ? null : REASON[status as keyof typeof REASON] };
  });
}

/** Refuse (before anything is reserved or charged) when the sender cannot be used on one of the networks. */
export async function assertSenderCompatible(db: Db, sender: { id: string; name: string; status: string }, networks: NetworkRef[]) {
  const blocked = (await senderCompatibility(db, sender, networks)).filter((c) => !c.compatible);
  if (!blocked.length) return;
  const list = blocked.map((b) => `${b.networkName} (${b.reason})`).join(', ');
  throw AppError.unprocessable(
    `Sender ID "${sender.name}" cannot be used for ${list}. Choose a sender ID approved for ${blocked.length > 1 ? 'these networks' : 'this network'}, or send to the other networks separately.`,
    'SENDER_NOT_APPROVED_FOR_NETWORK',
    blocked.map((b) => ({ field: `networks.${b.networkId}`, message: `${b.networkName}: ${b.reason}` })),
  );
}

/** The sender's telecoms: those it was requested/approved for, plus networks of its organization's country. */
export async function senderNetworkOverview(db: Db, sender: { id: string; status: string; organizationId?: string; restrictToNetworks?: boolean }) {
  const rows = await db.senderIdNetwork.findMany({ where: { senderId: sender.id } });
  const org = sender.organizationId ? await db.organization.findUnique({ where: { id: sender.organizationId }, select: { country: true } }) : null;
  const home = org?.country ? await db.smsCountry.findFirst({ where: { OR: [{ isoCode: org.country.trim().toUpperCase().slice(0, 2) }, { name: org.country.trim() }] } }) : null;
  const networks = await db.smsNetwork.findMany({
    where: { isActive: true, country: { isActive: true }, OR: [{ id: { in: rows.map((r) => r.networkId) } }, ...(home ? [{ countryCode: home.isoCode }] : [])] },
    orderBy: [{ countryCode: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });
  const checks = await senderCompatibility(db, sender, networks);
  return networks.map((n, i) => {
    const row = rows.find((r) => r.networkId === n.id);
    return { ...checks[i], countryCode: n.countryCode, requested: !!row, requiresRegistration: n.requiresSenderRegistration || !!sender.restrictToNetworks, note: row?.note ?? null, reviewedAt: row?.reviewedAt ?? null, requestedAt: row?.createdAt ?? null };
  });
}

/** Active networks by id (all must exist and be active). */
export async function activeNetworks(db: Db, ids: string[]) {
  const unique = [...new Set(ids)];
  const networks = await db.smsNetwork.findMany({ where: { id: { in: unique }, isActive: true } });
  if (networks.length !== unique.length) throw AppError.unprocessable('One or more networks are not available', 'UNKNOWN_NETWORK', [{ field: 'networkIds', message: 'Unknown or inactive network' }]);
  return networks;
}

/** Customer: ask for the sender ID to be registered on networks (PENDING; re-request after a rejection). */
export async function requestSenderNetworks(organizationId: string, senderId: string, networkIds: string[], actor: Actor, meta?: RequestMeta) {
  const sender = await prisma.senderId.findFirst({ where: { id: senderId, organizationId } });
  if (!sender) throw AppError.notFound('Sender ID');
  if (['REJECTED', 'SUSPENDED'].includes(sender.status)) throw AppError.conflict(`Sender ID "${sender.name}" is ${sender.status.toLowerCase()}`, 'SENDER_NOT_ELIGIBLE');
  const unique = [...new Set(networkIds)];
  const networks = await prisma.smsNetwork.findMany({ where: { id: { in: unique }, isActive: true } });
  if (networks.length !== unique.length) throw AppError.unprocessable('One or more networks are not available', 'UNKNOWN_NETWORK', [{ field: 'networkIds', message: 'Unknown or inactive network' }]);
  const existing = await prisma.senderIdNetwork.findMany({ where: { senderId, networkId: { in: unique } } });
  const requested: string[] = [];
  for (const n of networks) {
    const row = existing.find((r) => r.networkId === n.id);
    if (row && row.status !== 'REJECTED') continue; // pending, approved or suspended: nothing to request
    await prisma.senderIdNetwork.upsert({
      where: { senderId_networkId: { senderId, networkId: n.id } },
      create: { senderId, organizationId, networkId: n.id, status: 'PENDING' },
      update: { status: 'PENDING', note: null, reviewedById: null, reviewedAt: null },
    });
    requested.push(n.name);
  }
  if (requested.length) await audit({ actor, action: 'SENDER_NETWORK_REQUESTED', resource: 'sender_id', resourceId: senderId, organizationId, metadata: { name: sender.name, networks: requested }, meta });
  return senderNetworkOverview(prisma, sender);
}

/** When a sender ID is approved, the networks it was requested for are approved with it. */
export async function approveRequestedNetworks(tx: Db, senderId: string, reviewerId: string | null) {
  await tx.senderIdNetwork.updateMany({ where: { senderId, status: 'PENDING' }, data: { status: 'APPROVED', reviewedById: reviewerId, reviewedAt: new Date() } });
}

export const SENDER_NETWORK_PERMISSION: Record<SenderNetworkStatus, string> = {
  PENDING: 'senders.review',
  APPROVED: 'senders.approve',
  REJECTED: 'senders.reject',
  SUSPENDED: 'senders.suspend',
};

/** Staff: set a sender ID's status on one network (audited; the organization is notified). */
export async function setSenderNetworkStatus(senderId: string, networkId: string, status: SenderNetworkStatus, note: string | undefined, actor: Actor, meta?: RequestMeta) {
  const sender = await prisma.senderId.findUnique({ where: { id: senderId } });
  if (!sender) throw AppError.notFound('Sender ID');
  const network = await prisma.smsNetwork.findUnique({ where: { id: networkId } });
  if (!network) throw AppError.notFound('Network');
  if (status === 'APPROVED' && sender.status !== 'APPROVED') {
    throw AppError.conflict(`Approve the sender ID "${sender.name}" itself before approving it on a network`, 'SENDER_NOT_APPROVED');
  }
  const before = await prisma.senderIdNetwork.findUnique({ where: { senderId_networkId: { senderId, networkId } } });
  const row = await prisma.$transaction(async (tx) => {
    const saved = await tx.senderIdNetwork.upsert({
      where: { senderId_networkId: { senderId, networkId } },
      create: { senderId, organizationId: sender.organizationId, networkId, status, note: note ?? null, reviewedById: actorUserId(actor), reviewedAt: new Date() },
      update: { status, note: note ?? null, reviewedById: actorUserId(actor), reviewedAt: new Date() },
    });
    await audit(
      {
        actor,
        action: `SENDER_NETWORK_${status}`,
        resource: 'sender_id',
        resourceId: senderId,
        organizationId: sender.organizationId,
        metadata: { name: sender.name, networkId, network: network.name, from: before?.status ?? null, to: status, note },
        meta,
      },
      tx,
    );
    return saved;
  });
  if (status !== 'PENDING') {
    await notifyOrganization(
      sender.organizationId,
      {
        type: 'SENDER_NETWORK_UPDATED',
        title: `Sender ID ${sender.name} ${status.toLowerCase()} on ${network.name}`,
        body: note ? `${network.name}: ${note}` : `Sender ID "${sender.name}" is now ${status.toLowerCase()} for ${network.name}.`,
        link: '/app/senders',
      },
      'senders.view',
    );
  }
  return row;
}
