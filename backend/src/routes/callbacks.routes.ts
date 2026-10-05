import express, { Router } from 'express';
import { logger } from '../config/logger';
import { InvalidCallbackSignatureError } from '../integrations/sms/SmsProvider';
import { SmsProviderFactory } from '../integrations/sms/SmsProviderFactory';
import { handleProviderWebhook } from '../modules/payments/payment.service';
import { applyDeliveryStatus } from '../modules/sms/sms.service';
import { AppError } from '../utils/errors';
import { asyncHandler } from '../utils/http';

/**
 * Inbound provider callbacks (SMS delivery reports, payment webhooks).
 * Bodies are read raw so signatures can be verified over the exact bytes received.
 */
export const callbacksRouter = Router();
callbacksRouter.use(express.text({ type: '*/*', limit: '256kb' }));

callbacksRouter.post(
  '/sms/:provider',
  asyncHandler(async (req, res) => {
    const name = String(req.params.provider);
    if (!SmsProviderFactory.has(name)) throw AppError.notFound('Provider');
    const provider = SmsProviderFactory.get(name);
    let statuses;
    try {
      statuses = await provider.parseDeliveryCallback({ headers: req.headers, rawBody: typeof req.body === 'string' ? req.body : '' });
    } catch (err) {
      if (err instanceof InvalidCallbackSignatureError) throw AppError.unauthorized('Invalid signature', 'INVALID_SIGNATURE');
      throw AppError.badRequest('Malformed callback', 'INVALID_CALLBACK');
    }
    for (const s of statuses) await applyDeliveryStatus(s, 'CALLBACK', name);
    res.json({ success: true });
  }),
);

callbacksRouter.post(
  '/payments/:provider',
  asyncHandler(async (req, res) => {
    try {
      const result = await handleProviderWebhook(String(req.params.provider), req.headers, typeof req.body === 'string' ? req.body : '');
      res.json({ success: true, duplicate: result.duplicate });
    } catch (err) {
      if (err instanceof InvalidCallbackSignatureError) {
        logger.warn({ provider: req.params.provider, ip: req.ip }, 'Rejected payment webhook with invalid signature');
        throw AppError.unauthorized('Invalid signature', 'INVALID_SIGNATURE');
      }
      if (err instanceof SyntaxError) throw AppError.badRequest('Malformed webhook', 'INVALID_WEBHOOK');
      throw err;
    }
  }),
);
