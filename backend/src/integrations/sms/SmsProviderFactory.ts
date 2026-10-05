import type { SmsProvider as SmsProviderRow } from '@prisma/client';
import { env, isTest } from '../../config/env';
import { SimulationSmsProvider } from './SimulationSmsProvider';
import type { SmsProviderAdapter } from './SmsProvider';

/**
 * Registry of upstream adapters, keyed "<provider code>-<mode>" (lowercase):
 *
 *   providers/
 *     simulation/  mtn-simulation, airtel-simulation, generic-simulation   (registered below)
 *     production/  mtn-production, airtel-production, …                    (add when APIs are available)
 *
 * To connect a real network:
 *   1. Implement `SmsProviderAdapter` (e.g. `MtnProductionProvider.ts`) reading credentials from env.
 *   2. Register it here under "mtn-production".
 *   3. Set SMS_PROVIDER_MODE=production and switch the provider's mode to PRODUCTION in the admin UI.
 * Routing, billing, capacity accounting and delivery tracking do not change.
 */
const sim = (key: string, network: string, idPrefix: string, route: string, extra: { minDelayMs?: number; maxDelayMs?: number } = {}) => () =>
  new SimulationSmsProvider({
    key,
    network,
    idPrefix,
    route,
    failureRate: env.SIMULATION_SMS_FAILURE_RATE,
    minDelayMs: extra.minDelayMs ?? env.SIMULATION_SMS_MIN_DELAY_MS,
    maxDelayMs: extra.maxDelayMs ?? env.SIMULATION_SMS_MAX_DELAY_MS,
    callbackSecret: env.SMS_CALLBACK_SECRET,
    callbacksEnabled: !isTest,
    currency: 'RWF',
    senderRegistrationDelayMs: 1,
  });

const registry: Record<string, () => SmsProviderAdapter> = {
  'mtn-simulation': sim('mtn-simulation', 'MTN (simulated)', 'MTN', 'MTN-RW-DIRECT'),
  'airtel-simulation': sim('airtel-simulation', 'Airtel (simulated)', 'ATL', 'AIRTEL-RW-DIRECT'),
  'generic-simulation': sim('generic-simulation', 'Generic aggregator (simulated)', 'AGG', 'AGG-INTL', {
    minDelayMs: env.SIMULATION_SMS_MIN_DELAY_MS * 2,
    maxDelayMs: env.SIMULATION_SMS_MAX_DELAY_MS * 2,
  }),
};

const instances = new Map<string, SmsProviderAdapter>();

export const SmsProviderFactory = {
  available(): string[] {
    return Object.keys(registry);
  },
  has(key: string): boolean {
    return key in registry;
  },
  get(key: string): SmsProviderAdapter {
    const existing = instances.get(key);
    if (existing) return existing;
    const make = registry[key];
    if (!make) throw new Error(`Unknown SMS adapter "${key}". Available: ${Object.keys(registry).join(', ')}`);
    const adapter = make();
    instances.set(key, adapter);
    return adapter;
  },
  /** Global SMS_PROVIDER_MODE=simulation forces every provider onto its simulator (safe default for dev). */
  effectiveMode(p: Pick<SmsProviderRow, 'mode'>): 'SIMULATION' | 'PRODUCTION' {
    return env.SMS_PROVIDER_MODE === 'simulation' ? 'SIMULATION' : p.mode;
  },
  keyFor(p: Pick<SmsProviderRow, 'code' | 'mode'>): string {
    return `${p.code.toLowerCase()}-${this.effectiveMode(p).toLowerCase()}`;
  },
  /** The adapter serving a provider account, or null if none is installed for its mode. */
  forProvider(p: Pick<SmsProviderRow, 'code' | 'mode'>): SmsProviderAdapter | null {
    const key = this.keyFor(p);
    return this.has(key) ? this.get(key) : null;
  },
};
