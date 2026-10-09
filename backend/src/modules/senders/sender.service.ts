import type { SenderStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { audit } from '../audit-logs/audit.service';
import { notifyOrganization, notifyStaff } from '../notifications/notification.service';
import { registerSenderWithProviders } from '../providers/provider.service';
import { logger } from '../../config/logger';
import { activeNetworks, approveRequestedNetworks } from './senderNetworks.service';

/** Alphanumeric sender IDs: 3–11 chars, letters/digits/space/.-&, at least one letter (GSM rules). */
export const senderNameSchema = z
  .string()
  .trim()
  .min(3, 'Sender ID must be at least 3 characters')
  .max(11, 'Sender ID can be at most 11 characters')
  .regex(/^[A-Za-z0-9 .\-&]+$/, 'Only letters, digits, spaces, "." "-" and "&" are allowed')
  .regex(/[A-Za-z]/, 'Sender ID must contain at least one letter');

async function assertNameAvailable(organizationId: string, name: string, excludeId?: string) {
  const taken = await prisma.senderId.findFirst({
    where: { name: { equals: name }, status: { in: ['APPROVED', 'SUSPENDED'] }, organizationId: { not: organizationId } },
  });
  if (taken) throw AppError.conflict(`"${name}" is already registered to another organization`, 'SENDER_TAKEN');
  const own = await prisma.senderId.findFirst({
    where: { organizationId, name: { equals: name }, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  if (own) throw AppError.conflict(`You already have a sender ID named "${own.name}"`, 'SENDER_EXISTS');
}

export async function requestSender(
  organizationId: string,
  input: { name: string; purpose: string; sampleMessage?: string | null; useCase?: string | null; networkIds?: string[] },
  actor: Actor,
  meta?: RequestMeta,
) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  // The telecoms the sender ID will send to (empty = any network, the original behaviour).
  const networks = input.networkIds?.length ? await activeNetworks(prisma, input.networkIds) : [];
  if (org.status === 'SUSPENDED') throw AppError.forbidden('Organization is suspended', 'ORGANIZATION_SUSPENDED');
  if (org.status !== 'ACTIVE') throw AppError.forbidden('Your organization must be approved before requesting sender IDs', 'ORGANIZATION_NOT_APPROVED');
  await assertNameAvailable(organizationId, input.name);
  const sender = await prisma.senderId.create({
    data: {
      organizationId,
      name: input.name,
      purpose: input.purpose,
      sampleMessage: input.sampleMessage,
      useCase: input.useCase,
      requestedById: actorUserId(actor)!,
      status: 'PENDING',
      restrictToNetworks: networks.length > 0,
      networks: networks.length ? { create: networks.map((n) => ({ organizationId, networkId: n.id, status: 'PENDING' as const })) } : undefined,
    },
  });
  await audit({ actor, action: 'SENDER_REQUESTED', resource: 'sender_id', resourceId: sender.id, organizationId, metadata: { name: sender.name, networks: networks.map((n) => n.name) }, meta });
  await notifyStaff('senders.review', { type: 'SENDER_REQUESTED', title: 'New sender ID request', body: `${org.name} requested "${sender.name}"`, link: '/admin/senders' });
  return sender;
}

export async function updateSenderRequest(
  organizationId: string,
  id: string,
  input: { name?: string; purpose?: string; sampleMessage?: string | null; useCase?: string | null; networkIds?: string[] },
  actor: Actor,
  meta?: RequestMeta,
) {
  const s = await prisma.senderId.findFirst({ where: { id, organizationId } });
  if (!s) throw AppError.notFound('Sender ID');
  if (!['PENDING', 'NEEDS_INFORMATION', 'REJECTED'].includes(s.status)) throw AppError.conflict('This sender ID can no longer be edited', 'SENDER_NOT_EDITABLE');
  if (input.name && input.name !== s.name) await assertNameAvailable(organizationId, input.name, id);
  const { networkIds, ...data } = input;
  const networks = networkIds?.length ? await activeNetworks(prisma, networkIds) : [];
  const updated = await prisma.$transaction(async (tx) => {
    if (networkIds !== undefined) {
      // Replace the requested telecoms (still under review, so nothing approved is lost).
      await tx.senderIdNetwork.deleteMany({ where: { senderId: id, networkId: { notIn: networks.map((n) => n.id) } } });
      for (const n of networks) {
        await tx.senderIdNetwork.upsert({ where: { senderId_networkId: { senderId: id, networkId: n.id } }, create: { senderId: id, organizationId, networkId: n.id, status: 'PENDING' }, update: {} });
      }
    }
    return tx.senderId.update({ where: { id }, data: { ...data, ...(networkIds !== undefined ? { restrictToNetworks: networks.length > 0 } : {}) } });
  });
  await audit({ actor, action: 'SENDER_UPDATED', resource: 'sender_id', resourceId: id, organizationId, meta });
  return updated;
}

/** Resubmit after NEEDS_INFORMATION / REJECTED. */
export async function resubmitSender(organizationId: string, id: string, actor: Actor, meta?: RequestMeta) {
  const s = await prisma.senderId.findFirst({ where: { id, organizationId } });
  if (!s) throw AppError.notFound('Sender ID');
  if (!['NEEDS_INFORMATION', 'REJECTED'].includes(s.status)) throw AppError.conflict('Only sender IDs needing information or rejected can be resubmitted', 'SENDER_NOT_RESUBMITTABLE');
  await assertNameAvailable(organizationId, s.name, id);
  const updated = await prisma.senderId.update({ where: { id }, data: { status: 'PENDING' } });
  await audit({ actor, action: 'SENDER_RESUBMITTED', resource: 'sender_id', resourceId: id, organizationId, meta });
  await notifyStaff('senders.review', { type: 'SENDER_REQUESTED', title: 'Sender ID resubmitted', body: `"${s.name}" was resubmitted for review`, link: '/admin/senders' });
  return updated;
}

export async function deleteSenderRequest(organizationId: string, id: string, actor: Actor, meta?: RequestMeta) {
  const s = await prisma.senderId.findFirst({ where: { id, organizationId }, include: { _count: { select: { smsMessages: true, campaigns: true } } } });
  if (!s) throw AppError.notFound('Sender ID');
  if (s._count.smsMessages > 0 || s._count.campaigns > 0 || ['APPROVED', 'SUSPENDED', 'UNDER_REVIEW'].includes(s.status)) {
    throw AppError.conflict('This sender ID cannot be withdrawn', 'SENDER_IN_USE');
  }
  await prisma.senderId.delete({ where: { id } });
  await audit({ actor, action: 'SENDER_WITHDRAWN', resource: 'sender_id', resourceId: id, organizationId, metadata: { name: s.name }, meta });
}

// ── Staff review ───────────────────────────────────────────────────────

const TRANSITIONS: Record<string, { from: SenderStatus[]; to: SenderStatus; action: string }> = {
  review: { from: ['PENDING'], to: 'UNDER_REVIEW', action: 'SENDER_REVIEW_STARTED' },
  approve: { from: ['PENDING', 'UNDER_REVIEW', 'NEEDS_INFORMATION'], to: 'APPROVED', action: 'SENDER_APPROVED' },
  reject: { from: ['PENDING', 'UNDER_REVIEW', 'NEEDS_INFORMATION'], to: 'REJECTED', action: 'SENDER_REJECTED' },
  request_info: { from: ['PENDING', 'UNDER_REVIEW'], to: 'NEEDS_INFORMATION', action: 'SENDER_INFO_REQUESTED' },
  suspend: { from: ['APPROVED'], to: 'SUSPENDED', action: 'SENDER_SUSPENDED' },
  reactivate: { from: ['SUSPENDED'], to: 'APPROVED', action: 'SENDER_REACTIVATED' },
};
export type SenderReviewAction = keyof typeof TRANSITIONS;

export async function reviewSender(id: string, action: SenderReviewAction, note: string | undefined, actor: Actor, meta?: RequestMeta) {
  const t = TRANSITIONS[action];
  const s = await prisma.senderId.findUnique({ where: { id } });
  if (!s) throw AppError.notFound('Sender ID');
  if (!t.from.includes(s.status)) throw AppError.conflict(`Cannot ${action.replace('_', ' ')} a sender ID that is ${s.status}`, 'INVALID_TRANSITION');
  if (['reject', 'request_info', 'suspend'].includes(action) && !note?.trim()) {
    throw AppError.unprocessable('A note explaining the decision is required', 'NOTE_REQUIRED', [{ field: 'note', message: 'Required' }]);
  }
  if (t.to === 'APPROVED') {
    const conflict = await prisma.senderId.findFirst({
      where: { id: { not: id }, organizationId: { not: s.organizationId }, name: { equals: s.name }, status: { in: ['APPROVED', 'SUSPENDED'] } },
    });
    if (conflict) throw AppError.conflict('This sender name is already approved for another organization', 'SENDER_TAKEN');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.senderId.updateMany({
      where: { id, status: s.status },
      data: {
        status: t.to,
        reviewNote: note ?? (t.to === 'APPROVED' ? null : s.reviewNote),
        reviewedById: actorUserId(actor),
        reviewedAt: new Date(),
        ...(t.to === 'APPROVED' ? { approvedAt: new Date() } : {}),
      },
    });
    if (claimed.count === 0) throw AppError.conflict('Sender ID was modified concurrently, reload and try again', 'CONCURRENT_UPDATE');
    await tx.senderIdReview.create({ data: { senderId: id, organizationId: s.organizationId, reviewerId: actorUserId(actor), action, fromStatus: s.status, toStatus: t.to, note: note ?? null } });
    if (action === 'approve') await approveRequestedNetworks(tx, id, actorUserId(actor));
    await audit({ actor, action: t.action, resource: 'sender_id', resourceId: id, organizationId: s.organizationId, metadata: { name: s.name, from: s.status, to: t.to, note }, meta }, tx);
    return tx.senderId.findUniqueOrThrow({ where: { id } });
  });

  // Register with every active upstream network (networks handle sender IDs differently).
  if (t.to === 'APPROVED') void registerSenderWithProviders(id).catch((err) => logger.warn({ err, senderId: id }, 'Sender registration failed'));

  const notify: Partial<Record<SenderStatus, { type: 'SENDER_APPROVED' | 'SENDER_REJECTED' | 'SENDER_NEEDS_INFORMATION' | 'SENDER_SUSPENDED'; title: string }>> = {
    APPROVED: { type: 'SENDER_APPROVED', title: `Sender ID "${s.name}" approved` },
    REJECTED: { type: 'SENDER_REJECTED', title: `Sender ID "${s.name}" rejected` },
    NEEDS_INFORMATION: { type: 'SENDER_NEEDS_INFORMATION', title: `More information needed for "${s.name}"` },
    SUSPENDED: { type: 'SENDER_SUSPENDED', title: `Sender ID "${s.name}" suspended` },
  };
  const n = notify[t.to];
  if (n && action !== 'reactivate') {
    await notifyOrganization(s.organizationId, { ...n, body: note || (t.to === 'APPROVED' ? 'You can now send SMS with this sender ID.' : ''), link: '/app/senders' }, 'senders.view');
  } else if (action === 'reactivate') {
    await notifyOrganization(s.organizationId, { type: 'SENDER_APPROVED', title: `Sender ID "${s.name}" reactivated`, body: 'You can send with this sender ID again.', link: '/app/senders' }, 'senders.view');
  }
  return updated;
}
