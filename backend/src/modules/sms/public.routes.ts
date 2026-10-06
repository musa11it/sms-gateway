import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { idempotency } from '../../middlewares/idempotency';
import { publicApiLimiter } from '../../middlewares/rateLimit';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, parse } from '../../utils/http';
import { authenticateApiKey } from '../api-keys/apiKey.service';
import { MESSAGE_INPUT_HARD_LIMIT, analyzeMessage, serializeEstimate } from './segmentation.service';
import * as sms from './sms.service';

/**
 * Public REST API authenticated with API keys. Every request goes through the exact same
 * service layer (sendSms) as the dashboard: org status, sender approval, validation,
 * server-side pricing and transactional wallet debits all apply.
 */
export const publicRouter = Router();

const apiKeyAuth: RequestHandler = async (req, res, next) => {
  const started = Date.now();
  try {
    const header = req.get('authorization');
    const raw = header?.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key');
    const key = await authenticateApiKey(raw, req.ip);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: key.organizationId } });
    req.apiKey = { id: key.id, prefix: key.prefix, scopes: key.scopes, rateLimitPerMinute: key.rateLimitPerMinute };
    req.org = { id: org.id, name: org.name, status: org.status, memberId: null, roleCode: null, isOwner: false, permissions: new Set(key.scopes) };

    res.on('finish', () => {
      let errorCode: string | null = null;
      const locals = res.locals as { errorCode?: string };
      if (res.statusCode >= 400) errorCode = locals.errorCode ?? null;
      prisma.apiRequestLog
        .create({
          data: {
            organizationId: org.id,
            apiKeyId: key.id,
            method: req.method,
            path: req.originalUrl.split('?')[0].slice(0, 200),
            statusCode: res.statusCode,
            durationMs: Date.now() - started,
            ipAddress: req.ip,
            userAgent: req.get('user-agent')?.slice(0, 300),
            errorCode,
            requestId: String(req.id),
          },
        })
        .catch((err) => logger.error({ err }, 'Failed to write API request log'));
    });
    next();
  } catch (err) {
    next(err);
  }
};

const requireScope =
  (scope: string): RequestHandler =>
  (req, _res, next) =>
    req.apiKey?.scopes.includes(scope) ? next() : next(AppError.forbidden(`This API key lacks the "${scope}" scope`, 'SCOPE_MISSING'));

// Capture error codes for the request log.
const captureErrors: RequestHandler = (_req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (body && typeof body === 'object' && 'code' in body) (res.locals as { errorCode?: string }).errorCode = String((body as { code: unknown }).code);
    return json(body);
  };
  next();
};

// IP limiter first (blunts key guessing), then the per-key quota.
publicRouter.use(captureErrors, publicApiLimiter(undefined, 5), apiKeyAuth, publicApiLimiter());

/**
 * Accepted request shapes (all equivalent):
 *   { "senderId": "ABCFOOD", "to": ["+250788123456"], "message": "…" }
 *   { "sender": "ABCFOOD", "recipient": "+250788123456", "message": "…" }
 *   { "sender": "ABCFOOD", "recipients": ["+250…", "+250…"], "message": "…" }
 * `senderId`/`sender` is the sender NAME; ownership is always resolved from the API key.
 */
const phone = z.string().trim().min(3).max(30);
const sendSchema = z
  .object({
    senderId: z.string().trim().min(1).max(11).optional(),
    sender: z.string().trim().min(1).max(11).optional(),
    to: z.union([phone, z.array(phone).min(1).max(1000)]).optional(),
    recipient: phone.optional(),
    recipients: z.array(phone).min(1).max(1000).optional(),
    message: z.string().min(1).max(MESSAGE_INPUT_HARD_LIMIT),
    reference: z.string().trim().max(100).optional(),
    scheduledAt: z.coerce.date().optional(),
  })
  .refine((b) => !!(b.senderId ?? b.sender), { message: 'Provide "senderId" (your approved sender name)', path: ['senderId'] })
  .refine((b) => [b.to, b.recipient, b.recipients].filter((x) => x !== undefined).length === 1, { message: 'Provide exactly one of "to", "recipient" or "recipients"', path: ['to'] });

function toPublic(r: { id: string; phone: string; status: string; credits: number; errorCode: string | null; errorMessage: string | null; sentAt: Date | null; deliveredAt: Date | null; failedAt: Date | null; createdAt: Date }) {
  return {
    messageId: r.id,
    to: r.phone,
    status: r.status,
    credits: r.credits,
    error: r.errorCode ? { code: r.errorCode, message: r.errorMessage } : null,
    createdAt: r.createdAt,
    sentAt: r.sentAt,
    deliveredAt: r.deliveredAt,
    failedAt: r.failedAt,
  };
}

/** Preview the encoding, segments and credits of a message without sending it. */
publicRouter.post(
  '/sms/estimate',
  requireScope('sms.send'),
  asyncHandler(async (req, res) => {
    const { message } = parse(z.object({ message: z.string().max(MESSAGE_INPUT_HARD_LIMIT) }), req.body);
    res.json({ success: true, data: serializeEstimate(await analyzeMessage(message)) });
  }),
);

publicRouter.post(
  '/sms/send',
  requireScope('sms.send'),
  idempotency,
  asyncHandler(async (req, res) => {
    const body = parse(sendSchema, req.body);
    const idem = req.get('idempotency-key');
    if (idem && !/^[\w-]{8,100}$/.test(idem)) throw AppError.badRequest('Idempotency-Key must be 8-100 characters [A-Za-z0-9_-]', 'INVALID_IDEMPOTENCY_KEY');
    const result = await sms.sendSms({
      organizationId: req.org!.id,
      actor: actorFromRequest(req),
      meta: metaFromRequest(req),
      senderName: (body.senderId ?? body.sender)!,
      recipients: body.to !== undefined ? (Array.isArray(body.to) ? body.to : [body.to]) : body.recipients ?? [body.recipient!],
      message: body.message,
      source: 'API',
      apiKeyId: req.apiKey!.id,
      idempotencyKey: idem ?? null,
      clientReference: body.reference ?? null,
      scheduledAt: body.scheduledAt ?? null,
    });
    const recipients = await prisma.smsRecipient.findMany({ where: { messageId: result.message.id }, orderBy: { createdAt: 'asc' } });
    const m = result.message;
    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      messageId: recipients.length === 1 ? recipients[0].id : undefined,
      data: {
        batchId: m.id,
        status: m.status,
        segments: m.segments,
        encoding: m.encoding,
        recipientCount: m.recipientCount,
        totalCredits: m.totalCredits,
        reference: m.clientReference,
        scheduledAt: m.scheduledAt,
        messages: recipients.map(toPublic),
      },
      ...(result.duplicate ? { message: 'Duplicate request (Idempotency-Key) — returning the original result' } : {}),
    });
  }),
);

publicRouter.get(
  '/sms/:messageId',
  requireScope('sms.read'),
  asyncHandler(async (req, res) => {
    const { messageId } = parse(z.object({ messageId: z.string().uuid('Invalid message id') }), req.params);
    const r = await prisma.smsRecipient.findFirst({
      where: { id: messageId, organizationId: req.org!.id },
      include: { message: { select: { senderName: true, segments: true, encoding: true, clientReference: true } } },
    });
    if (!r) throw AppError.notFound('Message');
    res.json({ success: true, data: { ...toPublic(r), sender: r.message.senderName, segments: r.message.segments, encoding: r.message.encoding, reference: r.message.clientReference } });
  }),
);

publicRouter.get(
  '/balance',
  requireScope('balance.read'),
  asyncHandler(async (req, res) => {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: req.org!.id } });
    res.json({ success: true, data: { balance: wallet.balance, unit: 'credits' } });
  }),
);
