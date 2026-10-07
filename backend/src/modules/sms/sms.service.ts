import crypto from 'crypto';
import { Prisma, type SmsRecipient, type SmsSource } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import type { DeliveryStatus } from '../../integrations/sms/SmsProvider';
import { SmsProviderFactory } from '../../integrations/sms/SmsProviderFactory';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError, type FieldError } from '../../utils/errors';
import { normalizePhone } from '../../utils/phone';
import { queue } from '../../workers/queue';
import { audit } from '../audit-logs/audit.service';
import { notifyOrganization } from '../notifications/notification.service';
import { getSetting } from '../settings/settings.service';
import { applyLedgerEntry, scheduleLowBalanceCheck } from '../wallet/wallet.service';
import { checkDestination } from '../providers/destination.service';
import { releaseMessageCapacity, releaseRecipientCapacity, routeAndReserve } from '../providers/provider.service';
import { loadRoutingContext } from '../providers/routing.service';
import { checkAllocationAlert, reserveSenderCredits } from '../senders/allocation.service';
import { emitWebhookEvent } from '../webhooks/webhook.service';
import { analyzeMessage, assertSendable } from './segmentation.service';

export interface RecipientInput {
  phone: string;
  contactId?: string | null;
}

export interface SendSmsInput {
  organizationId: string;
  actor: Actor;
  meta?: RequestMeta;
  senderId?: string;
  senderName?: string;
  recipients: (string | RecipientInput)[];
  message: string;
  source: SmsSource;
  scheduledAt?: Date | null;
  timezone?: string | null;
  idempotencyKey?: string | null;
  clientReference?: string | null;
  campaignId?: string | null;
  apiKeyId?: string | null;
}

// ── Quote (pure, server-side cost calculation) ──────────────────────────

/**
 * Normalise and validate every recipient before anything is priced, reserved or charged: the
 * number must be valid for its country's numbering plan and the country must be configured for
 * sending (destination.service). Invalid/unsupported numbers are returned with the reason.
 */
export async function prepareRecipients(organizationId: string, raw: (string | RecipientInput)[]) {
  const cc = await getSetting('sms.defaultCountryCode');
  const ctx = await loadRoutingContext(prisma);
  const invalid: FieldError[] = [];
  const unique = new Map<string, RecipientInput>();
  raw.forEach((r, i) => {
    const input = typeof r === 'string' ? { phone: r } : r;
    const phone = normalizePhone(input.phone, cc);
    if (!phone) {
      invalid.push({ field: `recipients.${i}`, message: `"${String(input.phone).slice(0, 30)}" is not a valid phone number` });
      return;
    }
    const dest = checkDestination(ctx, phone);
    if (!dest.ok) invalid.push({ field: `recipients.${i}`, message: `${phone}: ${dest.reason}` });
    else if (!unique.has(dest.phone)) unique.set(dest.phone, { phone: dest.phone, contactId: input.contactId ?? null });
  });

  // Honour opt-outs: never send to unsubscribed or blocked contacts.
  const optedOut = unique.size
    ? await prisma.contact.findMany({
        where: { organizationId, phone: { in: [...unique.keys()] }, status: { in: ['UNSUBSCRIBED', 'BLOCKED'] } },
        select: { phone: true },
      })
    : [];
  for (const c of optedOut) unique.delete(c.phone);

  return { recipients: [...unique.values()], invalid, duplicates: raw.length - invalid.length - unique.size - optedOut.length, optedOut: optedOut.length };
}

/** Server-side cost of a message: the active segmentation rules × recipients. Used by every send path. */
export async function quote(message: string, recipientCount: number) {
  const a = await analyzeMessage(message);
  return { ...a, recipientCount, totalCredits: a.creditsPerRecipient * recipientCount };
}

// ── Send ────────────────────────────────────────────────────────────────

async function resolveSender(organizationId: string, senderId?: string, senderName?: string) {
  if (!senderId && !senderName) throw AppError.unprocessable('A sender ID is required', 'SENDER_REQUIRED', [{ field: 'senderId', message: 'Required' }]);
  const sender = await prisma.senderId.findFirst({
    where: { organizationId, ...(senderId ? { id: senderId } : { name: senderName!.trim() }) },
  });
  if (!sender) throw AppError.unprocessable('Sender ID not found for this organization', 'SENDER_NOT_FOUND', [{ field: 'senderId', message: 'Unknown sender ID' }]);
  if (sender.status !== 'APPROVED') {
    throw AppError.unprocessable(`Sender ID "${sender.name}" is not approved (status: ${sender.status})`, 'SENDER_NOT_APPROVED', [
      { field: 'senderId', message: 'Sender ID is not approved' },
    ]);
  }
  return sender;
}

export async function sendSms(input: SendSmsInput) {
  const org = await prisma.organization.findUnique({ where: { id: input.organizationId } });
  if (!org) throw AppError.notFound('Organization');
  if (org.status === 'SUSPENDED') throw AppError.forbidden('This organization is suspended. Messaging is disabled.', 'ORGANIZATION_SUSPENDED');
  if (org.status !== 'ACTIVE') throw AppError.forbidden('Organization is not approved for messaging yet', 'ORGANIZATION_NOT_APPROVED');

  if (input.idempotencyKey) {
    const existing = await prisma.smsMessage.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: org.id, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) return { message: existing, duplicate: true as const, skipped: { invalid: 0, duplicates: 0, optedOut: 0 } };
  }

  const sender = await resolveSender(org.id, input.senderId, input.senderName);

  const body = input.message;
  if (!body || !body.trim()) throw AppError.unprocessable('Message cannot be empty', 'EMPTY_MESSAGE', [{ field: 'message', message: 'Required' }]);

  const prepared = await prepareRecipients(org.id, input.recipients);
  if (prepared.invalid.length && input.source !== 'CAMPAIGN') {
    // Nothing is reserved or charged: the whole request is refused with a reason per number.
    const n = prepared.invalid.length;
    throw AppError.unprocessable(n === 1 ? prepared.invalid[0].message : `${n} recipients have invalid or unsupported numbers`, 'INVALID_RECIPIENTS', prepared.invalid.slice(0, 50));
  }
  if (prepared.recipients.length === 0) throw AppError.unprocessable('No valid recipients', 'NO_RECIPIENTS');
  const maxRecipients = await getSetting('sms.maxRecipientsPerRequest');
  if (prepared.recipients.length > maxRecipients) {
    throw AppError.unprocessable(`A single request can target at most ${maxRecipients.toLocaleString()} recipients`, 'TOO_MANY_RECIPIENTS');
  }

  const q = await quote(body, prepared.recipients.length);
  await assertSendable(q);

  const hourlyLimit = org.smsHourlyLimit ?? (await getSetting('rateLimits.smsRecipientsPerHour'));
  if (hourlyLimit > 0) {
    const lastHour = await prisma.smsRecipient.count({ where: { organizationId: org.id, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    if (lastHour + prepared.recipients.length > hourlyLimit) {
      throw new AppError(429, 'SMS_RATE_LIMITED', `Hourly sending limit reached (${hourlyLimit.toLocaleString()} recipients per hour). Try again later or contact support to raise it.`);
    }
  }

  const scheduled = input.scheduledAt && input.scheduledAt.getTime() > Date.now() + 30_000 ? input.scheduledAt : null;
  const messageId = crypto.randomUUID();

  let message;
  let allocationId: string | null = null;
  try {
    message = await prisma.$transaction(
      async (tx) => {
        const msg = await tx.smsMessage.create({
          data: {
            id: messageId,
            organizationId: org.id,
            senderId: sender.id,
            senderName: sender.name,
            campaignId: input.campaignId ?? null,
            apiKeyId: input.apiKeyId ?? null,
            createdById: actorUserId(input.actor),
            source: input.source,
            body,
            characterCount: q.characterCount,
            encoding: q.encoding,
            segments: q.segments,
            segmentationVersion: q.segmentationVersion,
            recipientCount: prepared.recipients.length,
            creditsPerRecipient: q.creditsPerRecipient,
            totalCredits: q.totalCredits,
            status: scheduled ? 'SCHEDULED' : 'QUEUED',
            scheduledAt: scheduled,
            timezone: input.timezone ?? null,
            idempotencyKey: input.idempotencyKey ?? null,
            clientReference: input.clientReference ?? null,
          },
        });
        // Route each destination to an upstream provider and reserve provider capacity
        // (in segments) atomically with the customer's wallet debit below.
        const routes = await routeAndReserve(tx, { reservationRef: messageId, phones: prepared.recipients.map((r) => r.phone), segmentsPerRecipient: q.segments, actor: input.actor });
        await tx.smsRecipient.createMany({
          data: prepared.recipients.map((r) => {
            const route = routes.get(r.phone)!;
            return {
              messageId,
              organizationId: org.id,
              campaignId: input.campaignId ?? null,
              contactId: r.contactId ?? null,
              phone: r.phone,
              credits: q.creditsPerRecipient,
              providerId: route.providerId,
              provider: route.adapterKey,
              providerCost: route.unitCost.mul(q.segments).toDecimalPlaces(4),
              countryCode: route.countryCode,
              networkId: route.networkId,
              routingRuleId: route.routingRuleId,
              routingNote: route.routingNote,
              status: 'QUEUED' as const,
            };
          }),
        });
        // Sender IDs with a credit allocation draw from it; others may only use unreserved credits.
        ({ allocationId } = await reserveSenderCredits(tx, { organizationId: org.id, senderId: sender.id, senderName: sender.name, credits: q.totalCredits }));
        // Credits are deducted when the message is accepted (reserved for scheduled sends;
        // refunded if cancelled or rejected by the provider).
        await applyLedgerEntry(tx, {
          organizationId: org.id,
          type: 'SMS_DEBIT',
          amount: -q.totalCredits,
          reference: `sms:${messageId}`,
          description: `${input.source === 'CAMPAIGN' ? 'Campaign' : 'SMS'} to ${prepared.recipients.length.toLocaleString()} recipient(s) × ${q.segments} segment(s)`,
          createdById: actorUserId(input.actor),
          metadata: { messageId, recipients: prepared.recipients.length, segments: q.segments, segmentationVersion: q.segmentationVersion, source: input.source, ...(allocationId ? { allocationId } : {}) },
        });
        await audit(
          {
            actor: input.actor,
            action: scheduled ? 'SMS_SCHEDULED' : 'SMS_SENT',
            resource: 'sms_message',
            resourceId: messageId,
            organizationId: org.id,
            metadata: { recipients: prepared.recipients.length, encoding: q.encoding, characters: q.characterCount, segments: q.segments, segmentationVersion: q.segmentationVersion, credits: q.totalCredits, sender: sender.name, source: input.source, scheduledAt: scheduled },
            meta: input.meta,
          },
          tx,
        );
        return msg;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && input.idempotencyKey) {
      const existing = await prisma.smsMessage.findUnique({
        where: { organizationId_idempotencyKey: { organizationId: org.id, idempotencyKey: input.idempotencyKey } },
      });
      if (existing) return { message: existing, duplicate: true as const, skipped: { invalid: 0, duplicates: 0, optedOut: 0 } };
    }
    throw err;
  }

  if (!scheduled) await queue.enqueue('sms.dispatch', { messageId }, { jobId: messageId, attempts: 5 });
  await scheduleLowBalanceCheck(org.id);
  if (allocationId) await checkAllocationAlert(allocationId);
  return {
    message,
    duplicate: false as const,
    skipped: { invalid: prepared.invalid.length, duplicates: prepared.duplicates, optedOut: prepared.optedOut },
  };
}

// ── Dispatch (worker) ───────────────────────────────────────────────────

function callbackUrl(providerName: string) {
  return `${env.API_PUBLIC_URL}/api/v1/callbacks/sms/${providerName}`;
}

/**
 * A message the provider rejected at submission consumed no provider capacity: always
 * release it. Customer credits are refunded when sms.refundOnSubmissionFailure is on.
 */
async function refundRecipient(recipient: SmsRecipient, reason: string, segments: number) {
  const refundEnabled = await getSetting('sms.refundOnSubmissionFailure');
  await prisma.$transaction(async (tx) => {
    await releaseRecipientCapacity(tx, recipient, segments, `${recipient.phone} rejected (${reason})`);
    if (!refundEnabled || recipient.refunded) return;
    const claimed = await tx.smsRecipient.updateMany({ where: { id: recipient.id, refunded: false }, data: { refunded: true } });
    if (claimed.count === 0) return;
    await applyLedgerEntry(tx, {
      organizationId: recipient.organizationId,
      type: 'REFUND',
      amount: recipient.credits,
      reference: `refund:sms:${recipient.id}:${recipient.attempts}`,
      restoreOf: `sms:${recipient.messageId}`,
      description: `Refund: message to ${recipient.phone} rejected (${reason})`,
      metadata: { recipientId: recipient.id, messageId: recipient.messageId },
    });
  });
}

async function submitRecipient(recipient: SmsRecipient, msg: { senderName: string; body: string; encoding: 'GSM7' | 'UCS2'; segments: number }) {
  const adapter = recipient.provider && SmsProviderFactory.has(recipient.provider) ? SmsProviderFactory.get(recipient.provider) : null;
  const provider = adapter ?? { key: recipient.provider ?? 'unassigned' };
  let result;
  try {
    result = adapter
      ? await adapter.sendSms({
          from: msg.senderName,
          to: recipient.phone,
          message: msg.body,
          encoding: msg.encoding,
          segments: msg.segments,
          clientReference: recipient.id,
          callbackUrl: callbackUrl(adapter.key),
        })
      : ({ accepted: false, errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: 'The route for this message is no longer available', retryable: false } as const);
  } catch (err) {
    // Transport error: put it back in the queue; the job retry will pick it up.
    await prisma.smsRecipient.update({ where: { id: recipient.id }, data: { status: 'QUEUED' } });
    throw err;
  }

  const now = new Date();
  if (result.accepted) {
    const updated = await prisma.smsRecipient.update({
      where: { id: recipient.id },
      data: { status: 'SENT', provider: provider.key, providerMessageId: result.providerMessageId, submittedAt: now, sentAt: now, errorCode: null, errorMessage: null },
    });
    await prisma.smsDeliveryReport.create({
      data: { recipientId: recipient.id, providerMessageId: result.providerMessageId, provider: provider.key, status: 'SENT', providerStatus: result.providerStatus, source: 'SUBMISSION', occurredAt: now },
    });
    await emitWebhookEvent(recipient.organizationId, 'sms.sent', serializeRecipientEvent(updated), `sms.sent:${recipient.id}:${recipient.attempts}`);
    return;
  }

  if (result.retryable && recipient.attempts < 3) {
    await prisma.smsRecipient.update({ where: { id: recipient.id }, data: { status: 'QUEUED', errorCode: result.errorCode, errorMessage: result.errorMessage } });
    throw new Error(`Retryable provider error: ${result.errorCode}`);
  }
  // Never accepted by the provider: REJECTED (not FAILED), capacity released and the credits refunded.
  const failed = await prisma.smsRecipient.update({
    where: { id: recipient.id },
    data: { status: 'REJECTED', provider: provider.key, errorCode: result.errorCode, errorMessage: result.errorMessage, failedAt: now, submittedAt: now },
  });
  await prisma.smsDeliveryReport.create({
    data: { recipientId: recipient.id, provider: provider.key, status: 'REJECTED', providerStatus: 'REJECTED', errorCode: result.errorCode, errorMessage: result.errorMessage, source: 'SUBMISSION', occurredAt: now },
  });
  await refundRecipient(failed, result.errorCode, msg.segments);
  await emitWebhookEvent(recipient.organizationId, 'sms.failed', serializeRecipientEvent(failed), `sms.failed:${recipient.id}:${recipient.attempts}`);
}

export async function dispatchMessage(messageId: string) {
  const msg = await prisma.smsMessage.findUnique({ where: { id: messageId } });
  if (!msg || !['QUEUED', 'PROCESSING'].includes(msg.status)) return;

  await prisma.smsMessage.update({ where: { id: messageId }, data: { status: 'PROCESSING', processedAt: msg.processedAt ?? new Date() } });
  if (msg.campaignId) {
    await prisma.campaign.updateMany({ where: { id: msg.campaignId, status: { in: ['QUEUED', 'SCHEDULED'] } }, data: { status: 'PROCESSING' } });
  }

  const CONCURRENCY = 10;
  const deferred = new Set<string>();
  let transientErrors = 0;
  for (;;) {
    const batch = await prisma.smsRecipient.findMany({
      where: { messageId, status: 'QUEUED', id: { notIn: [...deferred] } },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });
    if (batch.length === 0) break;
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const slice = batch.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(async (r) => {
          const claimed = await prisma.smsRecipient.updateMany({ where: { id: r.id, status: 'QUEUED' }, data: { status: 'PROCESSING', attempts: { increment: 1 } } });
          if (claimed.count === 0) return;
          try {
            await submitRecipient({ ...r, status: 'PROCESSING', attempts: r.attempts + 1 }, msg);
          } catch (err) {
            deferred.add(r.id);
            transientErrors += 1;
            logger.warn({ err: (err as Error).message, recipientId: r.id }, 'SMS submission deferred');
          }
        }),
      );
    }
  }

  const remaining = await prisma.smsRecipient.count({ where: { messageId, status: { in: ['QUEUED', 'PROCESSING'] } } });
  if (remaining === 0) {
    await prisma.smsMessage.updateMany({ where: { id: messageId, status: 'PROCESSING' }, data: { status: 'SENT' } });
    await refreshMessageCompletion(messageId);
  }
  if (transientErrors > 0) throw new Error(`${transientErrors} recipient(s) deferred after transient errors`);
}

// ── Delivery reports ────────────────────────────────────────────────────

const FINAL = new Set(['DELIVERED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REJECTED']);

export async function applyDeliveryStatus(status: DeliveryStatus, source: 'CALLBACK' | 'POLL', providerName: string) {
  const recipient = await prisma.smsRecipient.findUnique({ where: { providerMessageId: status.providerMessageId } });
  if (!recipient) {
    logger.warn({ providerMessageId: status.providerMessageId, providerName }, 'Delivery report for unknown message');
    return { applied: false };
  }
  if (status.state === 'SENT') return { applied: false };

  await prisma.smsDeliveryReport.create({
    data: {
      recipientId: recipient.id,
      providerMessageId: status.providerMessageId,
      provider: providerName,
      status: status.state,
      providerStatus: status.providerStatus,
      errorCode: status.errorCode,
      errorMessage: status.errorMessage,
      source,
      payload: (status.raw ?? undefined) as Prisma.InputJsonValue | undefined,
      occurredAt: status.occurredAt,
    },
  });

  if (FINAL.has(recipient.status)) return { applied: false }; // duplicate or out-of-order report

  const data =
    status.state === 'DELIVERED'
      ? { status: 'DELIVERED' as const, deliveredAt: status.occurredAt }
      : { status: status.state, failedAt: status.occurredAt, errorCode: status.errorCode ?? null, errorMessage: status.errorMessage ?? null };
  const res = await prisma.smsRecipient.updateMany({ where: { id: recipient.id, status: { in: ['SENT', 'PROCESSING'] } }, data });
  if (res.count === 0) return { applied: false };

  const updated = await prisma.smsRecipient.findUniqueOrThrow({ where: { id: recipient.id } });
  await emitWebhookEvent(
    recipient.organizationId,
    status.state === 'DELIVERED' ? 'sms.delivered' : 'sms.failed',
    serializeRecipientEvent(updated),
    `sms.${status.state.toLowerCase()}:${recipient.id}`,
  );
  await refreshMessageCompletion(recipient.messageId);
  return { applied: true };
}

/** Marks the batch (and its campaign) complete once every recipient reached a final state. */
export async function refreshMessageCompletion(messageId: string) {
  const pending = await prisma.smsRecipient.count({ where: { messageId, status: { in: ['QUEUED', 'PROCESSING', 'SENT'] } } });
  if (pending > 0) return;
  const done = await prisma.smsMessage.updateMany({ where: { id: messageId, status: { in: ['SENT', 'PROCESSING'] } }, data: { status: 'COMPLETED', completedAt: new Date() } });
  if (done.count === 0) return;

  const msg = await prisma.smsMessage.findUniqueOrThrow({ where: { id: messageId } });
  if (!msg.campaignId) return;
  const grouped = await prisma.smsRecipient.groupBy({ by: ['status'], where: { messageId }, _count: true });
  const count = (s: string) => grouped.find((g) => g.status === s)?._count ?? 0;
  const delivered = count('DELIVERED');
  const total = grouped.reduce((a, g) => a + g._count, 0);
  const status = delivered === total ? 'COMPLETED' : delivered > 0 ? 'PARTIALLY_COMPLETED' : 'FAILED';
  const updated = await prisma.campaign.updateMany({
    where: { id: msg.campaignId, status: { in: ['PROCESSING', 'QUEUED'] } },
    data: { status, completedAt: new Date(), failureReason: status === 'FAILED' ? 'No messages were delivered' : null },
  });
  if (updated.count === 0) return;
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: msg.campaignId } });
  await notifyOrganization(
    campaign.organizationId,
    {
      type: status === 'FAILED' ? 'CAMPAIGN_FAILED' : 'CAMPAIGN_COMPLETED',
      title: status === 'FAILED' ? `Campaign "${campaign.name}" failed` : `Campaign "${campaign.name}" completed`,
      body: `${delivered.toLocaleString()} of ${total.toLocaleString()} messages delivered.`,
      link: `/app/campaigns/${campaign.id}`,
    },
    'campaigns.view',
  );
  await emitWebhookEvent(campaign.organizationId, 'campaign.completed', {
    campaignId: campaign.id,
    name: campaign.name,
    status,
    recipients: total,
    delivered,
    failed: count('FAILED') + count('EXPIRED') + count('REJECTED'),
  }, `campaign.completed:${campaign.id}`);
}

// ── Cancel / retry ──────────────────────────────────────────────────────

export async function cancelScheduledMessage(organizationId: string | null, messageId: string, actor: Actor, meta?: RequestMeta) {
  const msg = await prisma.smsMessage.findFirst({ where: { id: messageId, ...(organizationId ? { organizationId } : {}) } });
  if (!msg) throw AppError.notFound('Message');
  if (msg.status !== 'SCHEDULED') throw AppError.conflict('Only scheduled messages can be cancelled', 'NOT_CANCELLABLE');

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.smsMessage.updateMany({ where: { id: msg.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    if (claimed.count === 0) throw AppError.conflict('Message is already being processed', 'NOT_CANCELLABLE');
    await releaseMessageCapacity(tx, msg.id, msg.segments);
    await tx.smsRecipient.updateMany({ where: { messageId: msg.id }, data: { status: 'CANCELLED', refunded: true } });
    await applyLedgerEntry(tx, {
      organizationId: msg.organizationId,
      type: 'REFUND',
      amount: msg.totalCredits,
      reference: `refund:sms-cancel:${msg.id}`,
      restoreOf: `sms:${msg.id}`,
      description: `Refund: scheduled ${msg.campaignId ? 'campaign' : 'message'} cancelled`,
      createdById: actorUserId(actor),
      metadata: { messageId: msg.id },
    });
    if (msg.campaignId) {
      await tx.campaign.update({ where: { id: msg.campaignId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    }
    await audit(
      { actor, action: msg.campaignId ? 'CAMPAIGN_CANCELLED' : 'SMS_CANCELLED', resource: msg.campaignId ? 'campaign' : 'sms_message', resourceId: msg.campaignId ?? msg.id, organizationId: msg.organizationId, metadata: { refundedCredits: msg.totalCredits }, meta },
      tx,
    );
  });
  await scheduleLowBalanceCheck(msg.organizationId);
}

/** Staff operation: re-submit a failed recipient. Re-charges credits if they were refunded. */
export async function retryRecipient(recipientId: string, actor: Actor, meta?: RequestMeta) {
  const r = await prisma.smsRecipient.findUnique({ where: { id: recipientId }, include: { message: true } });
  if (!r) throw AppError.notFound('Message');
  if (!['FAILED', 'EXPIRED', 'REJECTED'].includes(r.status)) throw AppError.conflict('Only failed, expired or rejected messages can be retried', 'NOT_RETRYABLE');
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: r.organizationId } });
  if (org.status !== 'ACTIVE') throw AppError.conflict('Organization is not active', 'ORGANIZATION_NOT_ACTIVE');

  await prisma.$transaction(async (tx) => {
    if (r.refunded) {
      const { allocationId } = await reserveSenderCredits(tx, { organizationId: r.organizationId, senderId: r.message.senderId, senderName: r.message.senderName, credits: r.credits });
      await applyLedgerEntry(tx, {
        organizationId: r.organizationId,
        type: 'SMS_DEBIT',
        amount: -r.credits,
        reference: `retry:sms:${r.id}:${r.attempts}`,
        description: `Retry of message to ${r.phone}`,
        createdById: actorUserId(actor),
        metadata: { recipientId: r.id, ...(allocationId ? { allocationId } : {}) },
      });
    }
    let reroute = {};
    if (r.capacityReleased || !r.providerId) {
      const routes = await routeAndReserve(tx, { reservationRef: `retry:${r.id}:${r.attempts}`, phones: [r.phone], segmentsPerRecipient: r.message.segments, actor });
      const route = routes.get(r.phone)!;
      reroute = {
        providerId: route.providerId,
        provider: route.adapterKey,
        providerCost: route.unitCost.mul(r.message.segments).toDecimalPlaces(4),
        countryCode: route.countryCode,
        networkId: route.networkId,
        routingRuleId: route.routingRuleId,
        routingNote: route.routingNote,
        capacityReleased: false,
      };
    }
    await tx.smsRecipient.update({
      where: { id: r.id },
      data: { status: 'QUEUED', refunded: false, providerMessageId: null, errorCode: null, errorMessage: null, failedAt: null, ...reroute },
    });
    await tx.smsMessage.update({ where: { id: r.messageId }, data: { status: 'QUEUED', completedAt: null } });
    await audit({ actor, action: 'SMS_RETRIED', resource: 'sms_recipient', resourceId: r.id, organizationId: r.organizationId, metadata: { recharged: r.refunded }, meta }, tx);
  });
  await queue.enqueue('sms.dispatch', { messageId: r.messageId }, { jobId: `${r.messageId}:retry:${r.id}`, attempts: 5 });
}

// ── Sweeps (called by the scheduler) ────────────────────────────────────

export async function releaseDueScheduledMessages() {
  const due = await prisma.smsMessage.findMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } }, select: { id: true, campaignId: true }, take: 100 });
  for (const m of due) {
    const claimed = await prisma.smsMessage.updateMany({ where: { id: m.id, status: 'SCHEDULED' }, data: { status: 'QUEUED' } });
    if (claimed.count === 0) continue;
    if (m.campaignId) await prisma.campaign.updateMany({ where: { id: m.campaignId, status: 'SCHEDULED' }, data: { status: 'QUEUED', launchedAt: new Date() } });
    await queue.enqueue('sms.dispatch', { messageId: m.id }, { jobId: m.id, attempts: 5 });
  }
  return due.length;
}

/** Fallback for lost callbacks: poll the provider for messages stuck in SENT. */
export async function pollPendingDeliveryStatuses(olderThanMs = 20_000, limit = 200) {
  const stale = await prisma.smsRecipient.findMany({
    where: { status: 'SENT', providerMessageId: { not: null }, sentAt: { lte: new Date(Date.now() - olderThanMs) } },
    orderBy: { sentAt: 'asc' },
    take: limit,
  });
  let applied = 0;
  for (const r of stale) {
    if (!r.provider || !SmsProviderFactory.has(r.provider)) continue;
    try {
      const status = await SmsProviderFactory.get(r.provider).getDeliveryStatus(r.providerMessageId!);
      const res = await applyDeliveryStatus(status, 'POLL', r.provider);
      if (res.applied) applied += 1;
    } catch (err) {
      logger.warn({ err: (err as Error).message, recipientId: r.id }, 'Delivery status poll failed');
    }
  }
  return applied;
}

/** Recover work lost by a crash/restart (in-memory queue) or a dead worker. */
/**
 * Messages no provider accepted within sms.submissionTimeoutHours of their send time (e.g. a provider
 * kept timing out) are rejected: capacity released and credits refunded — the customer is never
 * charged for an SMS that was not handed to a provider.
 */
export async function rejectUnacceptedMessages() {
  const hours = await getSetting('sms.submissionTimeoutHours');
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  const stale = await prisma.smsRecipient.findMany({
    where: {
      status: 'QUEUED',
      createdAt: { lt: cutoff },
      message: { status: { in: ['QUEUED', 'PROCESSING'] }, OR: [{ scheduledAt: null }, { scheduledAt: { lt: cutoff } }] },
    },
    include: { message: { select: { segments: true } } },
    take: 500,
  });
  for (const r of stale) {
    const claimed = await prisma.smsRecipient.updateMany({
      where: { id: r.id, status: 'QUEUED' },
      data: { status: 'REJECTED', errorCode: 'NOT_ACCEPTED', errorMessage: `Not accepted by a provider within ${hours} hours`, failedAt: new Date() },
    });
    if (claimed.count === 0) continue;
    const { message, ...recipient } = r;
    await refundRecipient({ ...recipient, status: 'REJECTED' }, 'NOT_ACCEPTED', message.segments);
    await refreshMessageCompletion(r.messageId);
  }
  return stale.length;
}

export async function recoverStalledDispatches() {
  await rejectUnacceptedMessages();
  await prisma.smsRecipient.updateMany({
    where: { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
    data: { status: 'QUEUED' },
  });
  const stalled = await prisma.smsMessage.findMany({
    where: { status: { in: ['QUEUED', 'PROCESSING'] }, updatedAt: { lt: new Date(Date.now() - 60_000) }, recipients: { some: { status: 'QUEUED' } } },
    select: { id: true },
    take: 50,
  });
  for (const m of stalled) await queue.enqueue('sms.dispatch', { messageId: m.id }, { jobId: m.id, attempts: 5 });
  // Batches whose recipients all finished while the worker was down.
  const finished = await prisma.smsMessage.findMany({
    where: { status: { in: ['PROCESSING', 'SENT'] }, recipients: { none: { status: { in: ['QUEUED', 'PROCESSING'] } } } },
    select: { id: true, status: true },
    take: 100,
  });
  for (const m of finished) {
    if (m.status === 'PROCESSING') await prisma.smsMessage.updateMany({ where: { id: m.id, status: 'PROCESSING' }, data: { status: 'SENT' } });
    await refreshMessageCompletion(m.id);
  }
}

// ── Serialization ───────────────────────────────────────────────────────

export function serializeRecipientEvent(r: SmsRecipient) {
  return {
    messageId: r.id,
    batchId: r.messageId,
    to: r.phone,
    status: r.status,
    credits: r.credits,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    sentAt: r.sentAt,
    deliveredAt: r.deliveredAt,
    failedAt: r.failedAt,
  };
}
