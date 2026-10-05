import type { Campaign } from '@prisma/client';
import { prisma } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { normalizePhone } from '../../utils/phone';
import { audit } from '../audit-logs/audit.service';
import { resolveAudience } from '../contacts/contact.service';
import { getSetting } from '../settings/settings.service';
import { analyzeMessage, assertSendable } from '../sms/segmentation.service';
import { cancelScheduledMessage, sendSms } from '../sms/sms.service';

export interface CampaignInput {
  name: string;
  senderId: string;
  message: string;
  groupIds?: string[];
  contactIds?: string[];
  phones?: string[];
  scheduledAt?: Date | null;
  timezone?: string;
}

async function assertOwnedSender(organizationId: string, senderId: string) {
  const sender = await prisma.senderId.findFirst({ where: { id: senderId, organizationId } });
  if (!sender) throw AppError.unprocessable('Sender ID not found', 'SENDER_NOT_FOUND', [{ field: 'senderId', message: 'Unknown sender ID' }]);
  return sender;
}

async function buildAudienceRows(organizationId: string, input: Pick<CampaignInput, 'groupIds' | 'contactIds' | 'phones'>) {
  if (input.groupIds?.length) {
    const count = await prisma.contactGroup.count({ where: { organizationId, id: { in: input.groupIds } } });
    if (count !== new Set(input.groupIds).size) throw AppError.unprocessable('One or more groups were not found', 'GROUP_NOT_FOUND');
  }
  const cc = await getSetting('sms.defaultCountryCode');
  const rows = new Map<string, { phone: string; contactId: string | null }>();
  if (input.contactIds?.length) {
    const contacts = await prisma.contact.findMany({ where: { organizationId, id: { in: input.contactIds } }, select: { id: true, phone: true } });
    for (const c of contacts) rows.set(c.phone, { phone: c.phone, contactId: c.id });
  }
  const invalid: string[] = [];
  for (const p of input.phones ?? []) {
    const phone = normalizePhone(p, cc);
    if (!phone) invalid.push(p);
    else if (!rows.has(phone)) rows.set(phone, { phone, contactId: null });
  }
  if (invalid.length) {
    throw AppError.unprocessable(`${invalid.length} phone number(s) are invalid`, 'INVALID_RECIPIENTS', invalid.slice(0, 20).map((p) => ({ field: 'phones', message: `"${p}" is not a valid phone number` })));
  }
  return [...rows.values()];
}

export async function createCampaign(organizationId: string, input: CampaignInput, actor: Actor, meta?: RequestMeta) {
  await assertOwnedSender(organizationId, input.senderId);
  await assertSendable(await analyzeMessage(input.message));
  const recipients = await buildAudienceRows(organizationId, input);
  const campaign = await prisma.$transaction(async (tx) => {
    const c = await tx.campaign.create({
      data: {
        organizationId,
        name: input.name,
        senderId: input.senderId,
        message: input.message,
        scheduledAt: input.scheduledAt ?? null,
        timezone: input.timezone ?? 'Africa/Kigali',
        createdById: actorUserId(actor)!,
        status: 'DRAFT',
        groups: input.groupIds?.length ? { create: [...new Set(input.groupIds)].map((groupId) => ({ groupId })) } : undefined,
      },
    });
    if (recipients.length) await tx.campaignRecipient.createMany({ data: recipients.map((r) => ({ ...r, campaignId: c.id })) });
    await audit({ actor, action: 'CAMPAIGN_CREATED', resource: 'campaign', resourceId: c.id, organizationId, metadata: { name: c.name }, meta }, tx);
    return c;
  });
  return campaign;
}

async function getOwned(organizationId: string, id: string) {
  const c = await prisma.campaign.findFirst({ where: { id, organizationId } });
  if (!c) throw AppError.notFound('Campaign');
  return c;
}

export async function updateCampaign(organizationId: string, id: string, input: Partial<CampaignInput>, actor: Actor, meta?: RequestMeta) {
  const c = await getOwned(organizationId, id);
  if (c.status !== 'DRAFT') throw AppError.conflict('Only draft campaigns can be edited', 'CAMPAIGN_NOT_EDITABLE');
  if (input.senderId) await assertOwnedSender(organizationId, input.senderId);
  if (input.message !== undefined) await assertSendable(await analyzeMessage(input.message));
  const audienceChanged = input.groupIds !== undefined || input.contactIds !== undefined || input.phones !== undefined;
  const recipients = audienceChanged ? await buildAudienceRows(organizationId, input) : null;
  return prisma.$transaction(async (tx) => {
    if (input.groupIds !== undefined) {
      await tx.campaignGroup.deleteMany({ where: { campaignId: id } });
      if (input.groupIds.length) await tx.campaignGroup.createMany({ data: [...new Set(input.groupIds)].map((groupId) => ({ campaignId: id, groupId })) });
    }
    if (recipients && (input.contactIds !== undefined || input.phones !== undefined)) {
      await tx.campaignRecipient.deleteMany({ where: { campaignId: id } });
      if (recipients.length) await tx.campaignRecipient.createMany({ data: recipients.map((r) => ({ ...r, campaignId: id })) });
    }
    const updated = await tx.campaign.update({
      where: { id },
      data: { name: input.name, senderId: input.senderId, message: input.message, scheduledAt: input.scheduledAt, timezone: input.timezone },
    });
    await audit({ actor, action: 'CAMPAIGN_UPDATED', resource: 'campaign', resourceId: id, organizationId, meta }, tx);
    return updated;
  });
}

export async function deleteCampaign(organizationId: string, id: string, actor: Actor, meta?: RequestMeta) {
  const c = await getOwned(organizationId, id);
  if (!['DRAFT', 'CANCELLED'].includes(c.status)) throw AppError.conflict('Only draft or cancelled campaigns can be deleted', 'CAMPAIGN_NOT_DELETABLE');
  if (c.status === 'CANCELLED') {
    const hasMessage = await prisma.smsMessage.count({ where: { campaignId: id } });
    if (hasMessage) throw AppError.conflict('Cancelled campaigns with billing history are kept for your records', 'CAMPAIGN_NOT_DELETABLE');
  }
  await prisma.campaign.delete({ where: { id } });
  await audit({ actor, action: 'CAMPAIGN_DELETED', resource: 'campaign', resourceId: id, organizationId, metadata: { name: c.name }, meta });
}

/** Resolve the audience, charge credits and queue (or schedule) the campaign. */
export async function launchCampaign(organizationId: string, id: string, scheduledAt: Date | null, actor: Actor, meta?: RequestMeta) {
  const c = await getOwned(organizationId, id);
  if (c.status !== 'DRAFT') throw AppError.conflict(`Campaign is already ${c.status.toLowerCase()}`, 'CAMPAIGN_NOT_LAUNCHABLE');
  if (scheduledAt && scheduledAt.getTime() <= Date.now() + 30_000) {
    throw AppError.unprocessable('Scheduled time must be at least a minute in the future', 'INVALID_SCHEDULE', [{ field: 'scheduledAt', message: 'Must be in the future' }]);
  }

  const [groups, explicit] = await Promise.all([
    prisma.campaignGroup.findMany({ where: { campaignId: id }, select: { groupId: true } }),
    prisma.campaignRecipient.findMany({ where: { campaignId: id }, select: { phone: true, contactId: true } }),
  ]);
  const fromGroups = await resolveAudience(organizationId, { groupIds: groups.map((g) => g.groupId) });
  const audience = [...fromGroups, ...explicit];
  if (audience.length === 0) throw AppError.unprocessable('This campaign has no recipients', 'NO_RECIPIENTS');

  // Claim the draft so two launches can never both charge.
  const claimed = await prisma.campaign.updateMany({ where: { id, status: 'DRAFT' }, data: { status: scheduledAt ? 'SCHEDULED' : 'QUEUED' } });
  if (claimed.count === 0) throw AppError.conflict('Campaign is already being launched', 'CAMPAIGN_NOT_LAUNCHABLE');
  try {
    const result = await sendSms({
      organizationId,
      actor,
      meta,
      senderId: c.senderId,
      recipients: audience,
      message: c.message,
      source: 'CAMPAIGN',
      campaignId: c.id,
      scheduledAt,
      timezone: c.timezone,
    });
    await prisma.campaign.update({
      where: { id },
      data: { scheduledAt, launchedAt: scheduledAt ? null : new Date(), status: result.message.status === 'SCHEDULED' ? 'SCHEDULED' : 'QUEUED' },
    });
    await audit({ actor, action: scheduledAt ? 'CAMPAIGN_SCHEDULED' : 'CAMPAIGN_LAUNCHED', resource: 'campaign', resourceId: id, organizationId, metadata: { recipients: result.message.recipientCount, credits: result.message.totalCredits, scheduledAt }, meta });
    return result;
  } catch (err) {
    await prisma.campaign.update({ where: { id }, data: { status: 'DRAFT' } });
    throw err;
  }
}

export async function cancelCampaign(organizationId: string | null, id: string, actor: Actor, meta?: RequestMeta): Promise<Campaign> {
  const c = await prisma.campaign.findFirst({ where: { id, ...(organizationId ? { organizationId } : {}) }, include: { smsMessage: true } });
  if (!c) throw AppError.notFound('Campaign');
  if (c.status === 'DRAFT') {
    const updated = await prisma.campaign.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await audit({ actor, action: 'CAMPAIGN_CANCELLED', resource: 'campaign', resourceId: id, organizationId: c.organizationId, meta });
    return updated;
  }
  if (c.status === 'SCHEDULED' && c.smsMessage) {
    await cancelScheduledMessage(c.organizationId, c.smsMessage.id, actor, meta);
    return prisma.campaign.findUniqueOrThrow({ where: { id } });
  }
  throw AppError.conflict('Only draft or scheduled campaigns can be cancelled', 'CAMPAIGN_NOT_CANCELLABLE');
}

export async function campaignStats(campaignIds: string[]) {
  if (campaignIds.length === 0) return new Map<string, ReturnType<typeof emptyStats>>();
  const grouped = await prisma.smsRecipient.groupBy({
    by: ['campaignId', 'status', 'refunded'],
    where: { campaignId: { in: campaignIds } },
    _count: true,
    _sum: { credits: true },
  });
  const map = new Map<string, ReturnType<typeof emptyStats>>();
  for (const g of grouped) {
    const s = map.get(g.campaignId!) ?? emptyStats();
    s.recipients += g._count;
    if (['SENT', 'DELIVERED', 'FAILED', 'EXPIRED'].includes(g.status) && !(g.status === 'FAILED' && g.refunded)) s.sent += g._count;
    if (g.status === 'DELIVERED') s.delivered += g._count;
    if (g.status === 'FAILED' || g.status === 'EXPIRED') s.failed += g._count;
    if (['QUEUED', 'PROCESSING', 'SENT'].includes(g.status)) s.pending += g._count;
    if (!g.refunded) s.creditsUsed += g._sum.credits ?? 0;
    map.set(g.campaignId!, s);
  }
  return map;
}

function emptyStats() {
  return { recipients: 0, sent: 0, delivered: 0, failed: 0, pending: 0, creditsUsed: 0 };
}

export { emptyStats };
