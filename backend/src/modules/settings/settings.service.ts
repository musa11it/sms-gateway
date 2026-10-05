import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/errors';

/**
 * Typed, DB-backed system settings with defaults. Values are validated on write
 * and cached briefly in memory.
 */
const documentRequirement = z.object({
  type: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/),
  label: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  required: z.boolean(),
});

export const SETTING_SCHEMAS = {
  'billing.currency': z.string().length(3).toUpperCase(),
  'billing.taxRate': z.number().min(0).max(100),
  'billing.companyName': z.string().min(1).max(200),
  'billing.companyAddress': z.string().max(500),
  'sms.creditsPerSegment': z.number().int().min(1).max(10),
  'sms.maxRecipientsPerRequest': z.number().int().min(1).max(100000),
  'sms.defaultCountryCode': z.string().regex(/^\d{1,4}$/),
  'sms.refundOnSubmissionFailure': z.boolean(),
  'sms.maxMessageSegments': z.number().int().min(1).max(20),
  'wallet.defaultLowBalanceThreshold': z.number().int().min(0),
  'verification.requiredDocuments': z.array(documentRequirement).max(20),
  'verification.businessTypes': z.array(z.string().min(1).max(80)).max(50),
  'billing.paymentFeePercent': z.number().min(0).max(20),
  'rateLimits.publicApiPerMinute': z.number().int().min(1).max(100000),
  'rateLimits.authPer15Minutes': z.number().int().min(1).max(10000),
  'rateLimits.otpPer15Minutes': z.number().int().min(1).max(100),
  'rateLimits.uploadsPer15Minutes': z.number().int().min(1).max(10000),
  'rateLimits.adminPerMinute': z.number().int().min(1).max(100000),
  'rateLimits.smsRecipientsPerHour': z.number().int().min(0).max(10_000_000),
  'rateLimits.webhookTestsPerHour': z.number().int().min(1).max(1000),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;

export const SETTING_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  'billing.currency': 'RWF',
  'billing.taxRate': 0,
  'billing.companyName': 'SMS Gateway Ltd',
  'billing.companyAddress': 'Kigali, Rwanda',
  'sms.creditsPerSegment': 1,
  'sms.maxRecipientsPerRequest': 10000,
  'sms.defaultCountryCode': '250',
  'sms.refundOnSubmissionFailure': true,
  'sms.maxMessageSegments': 10,
  'wallet.defaultLowBalanceThreshold': 500,
  'verification.requiredDocuments': [
    { type: 'BUSINESS_REGISTRATION', label: 'Business registration certificate', required: true },
    { type: 'IDENTIFICATION', label: 'ID of the authorised representative', required: true },
    { type: 'AUTHORIZATION_LETTER', label: 'Authorization letter', required: false },
    { type: 'OTHER', label: 'Other supporting document', required: false },
  ],
  'billing.paymentFeePercent': 0,
  'rateLimits.publicApiPerMinute': 120,
  'rateLimits.authPer15Minutes': 20,
  'rateLimits.otpPer15Minutes': 5,
  'rateLimits.uploadsPer15Minutes': 30,
  'rateLimits.adminPerMinute': 300,
  'rateLimits.smsRecipientsPerHour': 50000,
  'rateLimits.webhookTestsPerHour': 30,
  'verification.businessTypes': [
    'Retail / E-commerce',
    'Restaurant / Hospitality',
    'Education',
    'Healthcare',
    'Financial services',
    'Non-profit / NGO',
    'Government',
    'Technology',
    'Other',
  ],
};

export const SETTING_DESCRIPTIONS: Record<SettingKey, string> = {
  'billing.currency': 'Default currency for packages and invoices',
  'billing.taxRate': 'Tax rate (%) applied to invoices; prices are tax-inclusive when 0',
  'billing.companyName': 'Issuer name printed on invoices',
  'billing.companyAddress': 'Issuer address printed on invoices',
  'sms.creditsPerSegment': 'Credits charged per SMS segment per recipient',
  'sms.maxRecipientsPerRequest': 'Maximum recipients in a single send request',
  'sms.defaultCountryCode': 'Country calling code applied to national-format numbers',
  'sms.refundOnSubmissionFailure': 'Refund credits when the provider rejects a message at submission',
  'sms.maxMessageSegments': 'Maximum segments allowed for one message',
  'wallet.defaultLowBalanceThreshold': 'Default low balance alert threshold for new wallets',
  'verification.requiredDocuments': 'Documents collected during business verification',
  'verification.businessTypes': 'Business types offered during onboarding',
  'billing.paymentFeePercent': 'Fallback payment-processing fee (%) when the payment provider does not report its fee',
  'rateLimits.publicApiPerMinute': 'Default public API requests per minute per API key (a key can override it)',
  'rateLimits.authPer15Minutes': 'Login/registration/password attempts per IP per 15 minutes',
  'rateLimits.otpPer15Minutes': 'Phone verification codes a user can request per 15 minutes',
  'rateLimits.uploadsPer15Minutes': 'Document uploads and CSV imports per IP per 15 minutes',
  'rateLimits.adminPerMinute': 'Admin API requests per staff user per minute',
  'rateLimits.smsRecipientsPerHour': 'Default recipients an organization may send to per hour (0 = unlimited; overridable per organization)',
  'rateLimits.webhookTestsPerHour': 'Test webhook events per organization per hour',
};

const TTL_MS = 15_000;
let cache: { at: number; values: Map<string, unknown> } | null = null;

async function load(): Promise<Map<string, unknown>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const rows = await prisma.systemSetting.findMany();
  const values = new Map(rows.map((r) => [r.key, r.value as unknown]));
  cache = { at: Date.now(), values };
  return values;
}

export function invalidateSettingsCache() {
  cache = null;
}

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const values = await load();
  if (values.has(key)) {
    const parsed = SETTING_SCHEMAS[key].safeParse(values.get(key));
    if (parsed.success) return parsed.data as SettingValue<K>;
  }
  return SETTING_DEFAULTS[key];
}

export async function getAllSettings() {
  const values = await load();
  return (Object.keys(SETTING_SCHEMAS) as SettingKey[]).map((key) => {
    const stored = values.get(key);
    const parsed = stored !== undefined ? SETTING_SCHEMAS[key].safeParse(stored) : null;
    return {
      key,
      value: parsed?.success ? parsed.data : SETTING_DEFAULTS[key],
      isDefault: !parsed?.success,
      description: SETTING_DESCRIPTIONS[key],
    };
  });
}

export async function updateSetting(key: string, value: unknown, updatedById: string) {
  if (!(key in SETTING_SCHEMAS)) throw AppError.badRequest(`Unknown setting "${key}"`, 'UNKNOWN_SETTING');
  const schema = SETTING_SCHEMAS[key as SettingKey];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw AppError.unprocessable(`Invalid value for ${key}`, 'VALIDATION_ERROR', [
      { field: key, message: parsed.error.issues[0]?.message ?? 'Invalid value' },
    ]);
  }
  const previous = await prisma.systemSetting.findUnique({ where: { key } });
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: parsed.data as Prisma.InputJsonValue, description: SETTING_DESCRIPTIONS[key as SettingKey], updatedById },
    update: { value: parsed.data as Prisma.InputJsonValue, updatedById },
  });
  invalidateSettingsCache();
  return { key, previous: previous?.value ?? null, value: parsed.data };
}
