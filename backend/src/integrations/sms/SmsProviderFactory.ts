import type { SmsProvider as SmsProviderRow } from '@prisma/client';
import { env, isProduction, isTest } from '../../config/env';
import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { HttpJsonSmsProvider, httpJsonConfigSchema, type HttpJsonSecrets } from './HttpJsonSmsProvider';
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

/**
 * Adapters built from provider rows (created in the admin UI), keyed like the static registry.
 * Every provider without a code adapter gets a simulator, so a new provider works in simulation
 * mode straight away; providers configured as HTTP_JSON also get a production adapter.
 */
let dynamic = new Map<string, SmsProviderAdapter>();
let refreshTimer: NodeJS.Timeout | undefined;

function buildDynamic(rows: SmsProviderRow[]) {
  const next = new Map<string, SmsProviderAdapter>();
  for (const p of rows) {
    const code = p.code.toLowerCase();
    const simKey = `${code}-simulation`;
    if (!(simKey in registry)) next.set(simKey, sim(simKey, `${p.name} (simulated)`, code.slice(0, 3).toUpperCase(), `${p.code}-SIM`)());
    if (p.adapterType !== 'HTTP_JSON') continue;
    const prodKey = `${code}-production`;
    if (prodKey in registry) continue;
    const { secrets, ...raw } = (p.adapterConfig ?? {}) as Record<string, unknown> & { secrets?: HttpJsonSecrets };
    const parsed = httpJsonConfigSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ provider: p.code }, 'Provider has an invalid HTTP adapter configuration; it will not be routable');
      continue;
    }
    next.set(prodKey, new HttpJsonSmsProvider({ key: prodKey, network: p.name, config: parsed.data, secrets: secrets ?? {}, allowPrivate: !isProduction }));
  }
  return next;
}

export const SmsProviderFactory = {
  available(): string[] {
    return [...new Set([...Object.keys(registry), ...dynamic.keys()])];
  },
  /** Rebuild the adapters that come from provider rows. Call at startup, after a provider changes, and periodically. */
  async refresh(): Promise<void> {
    dynamic = buildDynamic(await prisma.smsProvider.findMany());
  },
  /** Keeps this process in step with provider changes made through another process (API ↔ worker). */
  startAutoRefresh(everyMs = 30_000) {
    if (refreshTimer || isTest) return;
    refreshTimer = setInterval(() => void this.refresh().catch((err) => logger.error({ err }, 'Could not reload provider adapters')), everyMs);
    refreshTimer.unref();
  },
  has(key: string): boolean {
    return key in registry || dynamic.has(key);
  },
  get(key: string): SmsProviderAdapter {
    const fromRow = dynamic.get(key);
    if (fromRow) return fromRow;
    const existing = instances.get(key);
    if (existing) return existing;
    const make = registry[key];
    if (!make) throw new Error(`Unknown SMS adapter "${key}". Available: ${this.available().join(', ')}`);
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
