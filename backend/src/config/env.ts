import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: int(14),
  API_KEY_PEPPER: z.string().min(8),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters'),

  QUEUE_DRIVER: z.enum(['memory', 'bullmq']).default('memory'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  RUN_WORKERS: bool.default(true),

  // simulation = every provider uses its simulator; production = providers use their configured mode.
  SMS_PROVIDER_MODE: z.enum(['simulation', 'production']).default('simulation'),
  SMS_CALLBACK_SECRET: z.string().min(8),
  SIMULATION_SMS_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.05),
  SIMULATION_SMS_MIN_DELAY_MS: int(2000),
  SIMULATION_SMS_MAX_DELAY_MS: int(8000),

  PAYMENT_PROVIDER_MODE: z.enum(['simulation', 'production']).default('simulation'),
  // Adapter used when PAYMENT_PROVIDER_MODE=production (e.g. "momo").
  PAYMENT_PROVIDER: z.string().default('simulation'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(8),

  MAIL_DRIVER: z.enum(['log']).default('log'),
  MAIL_FROM: z.string().default('SMS Gateway <no-reply@example.com>'),

  UPLOAD_DIR: z.string().default('storage/uploads'),
  UPLOAD_MAX_BYTES: int(5 * 1024 * 1024),

});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const uploadRoot = path.resolve(__dirname, '../..', env.UPLOAD_DIR);

if (isProduction) {
  const weak = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'API_KEY_PEPPER'] as const;
  for (const key of weak) {
    if (env[key].includes('change')) {
      // eslint-disable-next-line no-console
      console.error(`Refusing to start: ${key} still has a placeholder value.`);
      process.exit(1);
    }
  }
}
