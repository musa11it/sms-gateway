import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { PaymentProviderFactory } from '../../integrations/payments/PaymentProviderFactory';
import { SmsProviderFactory } from '../../integrations/sms/SmsProviderFactory';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { asyncHandler, ok, parse } from '../../utils/http';
import { audit } from '../audit-logs/audit.service';
import { getAllSettings, updateSetting } from './settings.service';

export const adminSettingsRouter = Router();

adminSettingsRouter.get('/', requirePlatformPermission('settings.view'), asyncHandler(async (_req, res) => ok(res, await getAllSettings())));

adminSettingsRouter.put(
  '/:key',
  requirePlatformPermission('settings.update'),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    const { value } = parse(z.object({ value: z.unknown() }), req.body);
    const result = await updateSetting(key, value, req.user!.id);
    await audit({ actor: actorFromRequest(req), action: key.startsWith('billing.') ? 'PRICING_SETTING_CHANGED' : 'SETTING_UPDATED', resource: 'system_setting', resourceId: null, metadata: { key, previous: result.previous, value: result.value }, meta: metaFromRequest(req) });
    return ok(res, result, 'Setting saved');
  }),
);

/**
 * Provider configuration is environment/DB driven (credentials never live in the DB or UI).
 * Reports what is active so simulated traffic is always clearly labelled.
 */
export const providerInfo = () => {
  const pay = PaymentProviderFactory.getActive();
  return {
    sms: {
      mode: env.SMS_PROVIDER_MODE,
      isSimulation: env.SMS_PROVIDER_MODE === 'simulation',
      adapters: SmsProviderFactory.available(),
    },
    payments: { mode: env.PAYMENT_PROVIDER_MODE, active: pay.name, isSimulation: pay.isSimulation, available: PaymentProviderFactory.available() },
    queue: env.QUEUE_DRIVER,
    environment: env.NODE_ENV,
  };
};

adminSettingsRouter.get(
  '/providers/status',
  requirePlatformPermission('providers.view'),
  asyncHandler(async (_req, res) => {
    return ok(res, {
      ...providerInfo(),
      simulation:
        env.SMS_PROVIDER_MODE === 'simulation'
          ? {
              failureRate: env.SIMULATION_SMS_FAILURE_RATE,
              deliveryDelayMs: [env.SIMULATION_SMS_MIN_DELAY_MS, env.SIMULATION_SMS_MAX_DELAY_MS],
              rules: [
                'Numbers ending in 0000 are rejected at submission (credits refunded, capacity released)',
                'Numbers ending in 9999 fail delivery (ABSENT_SUBSCRIBER)',
                'Numbers ending in 8888 stay pending ~2 minutes then expire',
                `Otherwise delivered after ${env.SIMULATION_SMS_MIN_DELAY_MS / 1000}-${env.SIMULATION_SMS_MAX_DELAY_MS / 1000}s; ${(env.SIMULATION_SMS_FAILURE_RATE * 100).toFixed(0)}% fail deterministically`,
                'Mobile money fee 1.5%, card fee 2.9% (reported by the simulated gateway)',
              ],
            }
          : null,
    });
  }),
);
