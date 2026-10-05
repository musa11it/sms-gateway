import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { Prisma } from '@prisma/client';
import { isProduction } from '../../config/env';
import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { decrypt, signPayload } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { queue } from '../../workers/queue';

export const WEBHOOK_EVENTS = [
  'sms.sent',
  'sms.delivered',
  'sms.failed',
  'campaign.completed',
  'payment.success',
  'payment.failed',
  'wallet.low_balance',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 6;
const BACKOFF_SECONDS = [10, 60, 300, 1800, 7200];

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

/** Rejects non-HTTP(S) URLs and, in production, targets on private networks (SSRF protection). */
export async function assertSafeWebhookUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.unprocessable('Invalid URL', 'INVALID_WEBHOOK_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw AppError.unprocessable('Webhook URL must use http or https', 'INVALID_WEBHOOK_URL');
  if (!isProduction) return url;
  if (url.protocol !== 'https:') throw AppError.unprocessable('Webhook URL must use https', 'INVALID_WEBHOOK_URL');
  const addrs = net.isIP(url.hostname) ? [url.hostname] : (await dns.lookup(url.hostname, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) {
    throw AppError.unprocessable('Webhook URL must resolve to a public address', 'INVALID_WEBHOOK_URL');
  }
  return url;
}

/**
 * Record a platform event for every subscribed, active webhook of the organization and
 * queue delivery. Deliveries are persisted first, so retries survive restarts.
 */
export async function emitWebhookEvent(organizationId: string, event: WebhookEvent, data: Record<string, unknown>, eventId?: string) {
  try {
    const hooks = await prisma.webhook.findMany({ where: { organizationId, isActive: true, events: { path: '$', array_contains: [event] } }, select: { id: true } });
    if (hooks.length === 0) return;
    const id = eventId ?? `evt_${crypto.randomUUID().replace(/-/g, '')}`;
    const payload = { id, type: event, created: new Date().toISOString(), data } as Prisma.InputJsonValue;
    for (const h of hooks) {
      const delivery = await prisma.webhookDelivery
        .create({ data: { webhookId: h.id, organizationId, event, eventId: id, payload, status: 'PENDING', nextAttemptAt: new Date() } })
        .catch((err) => {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null; // already emitted
          throw err;
        });
      if (delivery) await queue.enqueue('webhook.deliver', { deliveryId: delivery.id }, { jobId: delivery.id, attempts: 1 });
    }
  } catch (err) {
    logger.error({ err, organizationId, event }, 'Failed to emit webhook event');
  }
}

/** Performs one delivery attempt and schedules the next retry on failure. */
export async function deliverWebhook(deliveryId: string) {
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { webhook: true } });
  if (!delivery || delivery.status === 'SUCCESS' || delivery.status === 'FAILED') return;
  if (!delivery.webhook.isActive) {
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'FAILED', lastError: 'Webhook disabled', nextAttemptAt: null } });
    return;
  }

  // Claim the attempt (prevents two workers delivering the same attempt).
  const claimed = await prisma.webhookDelivery.updateMany({
    where: { id: deliveryId, attempts: delivery.attempts, status: { in: ['PENDING', 'RETRYING'] } },
    data: { attempts: { increment: 1 }, nextAttemptAt: null },
  });
  if (claimed.count === 0) return;
  const attempt = delivery.attempts + 1;

  const body = JSON.stringify(delivery.payload);
  const started = Date.now();
  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  try {
    await assertSafeWebhookUrl(delivery.webhook.url);
    const secret = decrypt(delivery.webhook.secretEncrypted);
    const res = await fetch(delivery.webhook.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'SmsGateway-Webhooks/1.0',
        'x-smsgateway-event': delivery.event,
        'x-smsgateway-delivery': delivery.id,
        'x-smsgateway-signature': signPayload(secret, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    responseStatus = res.status;
    responseBody = (await res.text().catch(() => '')).slice(0, 1000);
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof AppError ? err.message : (err as Error).message ?? 'Request failed';
  }
  const durationMs = Date.now() - started;

  if (!error) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'SUCCESS', responseStatus, responseBody, durationMs, deliveredAt: new Date(), lastError: null },
    });
    return;
  }
  const exhausted = attempt >= MAX_ATTEMPTS;
  const nextAttemptAt = exhausted ? null : new Date(Date.now() + BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)] * 1000);
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: exhausted ? 'FAILED' : 'RETRYING', responseStatus, responseBody, durationMs, lastError: error, nextAttemptAt },
  });
  logger.warn({ deliveryId, attempt, error }, exhausted ? 'Webhook delivery failed permanently' : 'Webhook delivery failed, will retry');
}

/** Sweep: re-queue deliveries whose retry time has come (durable retry path). */
export async function enqueueDueWebhookDeliveries() {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: new Date() } },
    select: { id: true },
    take: 200,
  });
  for (const d of due) await queue.enqueue('webhook.deliver', { deliveryId: d.id }, { jobId: d.id, attempts: 1 });
}
