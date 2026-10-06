import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { env, isTest } from '../config/env';
import { getSetting, type SettingKey } from '../modules/settings/settings.service';

/**
 * Rate limiters. Limits are read from System Settings (editable by Super Admin) on every
 * request, so changes apply without a restart. The default store is in-memory; for
 * multi-instance deployments plug a Redis store (rate-limit-redis) into `base.store`.
 */
const base: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== 'true',
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      success: false,
      message: 'Too many requests. Please slow down and try again shortly.',
      code: 'RATE_LIMITED',
    });
  },
};

const fromSetting = (key: SettingKey) => async () => Number(await getSetting(key));

export const authLimiter = rateLimit({ ...base, windowMs: 15 * 60_000, limit: fromSetting('rateLimits.authPer15Minutes') });

export const otpLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: fromSetting('rateLimits.otpPer15Minutes'),
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anon',
});

export const uploadLimiter = rateLimit({ ...base, windowMs: 15 * 60_000, limit: fromSetting('rateLimits.uploadsPer15Minutes') });

export const adminLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: fromSetting('rateLimits.adminPerMinute'),
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anon',
});

export const generalLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 600 });

export const webhookTestLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60_000,
  limit: fromSetting('rateLimits.webhookTestsPerHour'),
  keyGenerator: (req) => req.org?.id ?? req.ip ?? 'anon',
});

/**
 * Public API: limited per API key. A key may carry its own per-minute override; otherwise the
 * platform default applies. Before authentication the IP is used (blunts key guessing).
 */
export function publicApiLimiter(fixedLimit?: number, multiplier = 1) {
  return rateLimit({
    ...base,
    windowMs: 60_000,
    limit: async (req: Request) => {
      if (fixedLimit) return fixedLimit;
      const perKey = req.apiKey?.rateLimitPerMinute;
      return (perKey ?? Number(await getSetting('rateLimits.publicApiPerMinute'))) * multiplier;
    },
    keyGenerator: (req) => (req.apiKey ? `key:${req.apiKey.id}` : `ip:${req.ip}`),
  });
}

/** Before authentication: per source IP, so guessing API keys from one address is throttled. */
export const credentialIpLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: env.API_IP_RATE_LIMIT,
  keyGenerator: (req) => `ip:${req.ip}`,
});

/** After authentication: per platform credential, so systems sharing an IP do not starve each other. */
export const integrationLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: env.API_RATE_LIMIT,
  keyGenerator: (req) => (req.integration ? `integration:${req.integration.id}` : `ip:${req.ip}`),
});
