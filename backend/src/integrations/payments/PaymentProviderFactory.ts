import { env, isTest } from '../../config/env';
import type { PaymentProvider } from './PaymentProvider';
import { SimulationPaymentProvider } from './SimulationPaymentProvider';

/**
 * Registry of payment provider adapters. Add a real gateway by implementing
 * `PaymentProvider`, registering it here and setting PAYMENT_PROVIDER=<name>.
 */
const registry: Record<string, () => PaymentProvider> = {
  simulation: () => new SimulationPaymentProvider({ webhookSecret: env.PAYMENT_WEBHOOK_SECRET, webhooksEnabled: !isTest }),
};

const instances = new Map<string, PaymentProvider>();

export const PaymentProviderFactory = {
  available: () => Object.keys(registry),
  getActive(): PaymentProvider {
    return this.get(env.PAYMENT_PROVIDER_MODE === 'simulation' ? 'simulation' : env.PAYMENT_PROVIDER);
  },
  get(name: string): PaymentProvider {
    const existing = instances.get(name);
    if (existing) return existing;
    const make = registry[name];
    if (!make) throw new Error(`Unknown payment provider "${name}"`);
    const p = make();
    instances.set(name, p);
    return p;
  },
  has: (name: string) => name in registry,
};
