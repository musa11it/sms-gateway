import { Prisma, type SmsCountry, type SmsNetwork, type SmsProvider, type SmsRoutingRule } from '@prisma/client';
import type { Db } from '../../config/prisma';
import { SmsProviderFactory } from '../../integrations/sms/SmsProviderFactory';
import { stringList } from '../../utils/json';

/**
 * Routing engine: decides which provider carries a message to a destination. Pure planning over
 * a snapshot of configuration (providers, networks, rules); the caller reserves capacity.
 *
 *  1. Destination: validated number → configured country → network by longest E.164 prefix
 *     (see destination.service.ts; invalid or unsupported numbers never reach this engine).
 *  2. Rule: the first active rule in order (lowest priority number) whose country/network match.
 *     No match = default routing: every provider serving the destination, by priority.
 *  3. Candidates, by strategy:
 *       LOWEST_COST    the rule's provider pool (empty = all serving the destination), cheapest first
 *       PRIORITY       the same pool, highest priority (lowest number) first
 *       PRIMARY_BACKUP the primary, then the backups in their configured order
 *     Ties fall back to the other key (cost/priority), then healthy before degraded.
 *  4. Eligibility: ACTIVE, adapter installed, health not DOWN, explicitly serves the destination
 *     (its country, or its network when the number is on a configured network), supports
 *     sender IDs, cost ≤ rule maximum, and enough capacity above the reserve (the larger of the
 *     provider's minimum capacity and the rule's minimum).
 *  5. The first eligible candidate is used; the next eligible one is the backup. No eligible
 *     candidate = the send is refused before anything is charged or reserved.
 */

export type RoutingProvider = SmsProvider & { networkIds: string[]; countryIds: string[] };
export type RoutingNetwork = SmsNetwork & { prefixList: string[] };

export interface RoutingContext {
  providers: RoutingProvider[];
  /** Active networks of active countries (maintenance ones included: detection reports them). */
  networks: RoutingNetwork[];
  /** Deactivated networks: their numbers are recognised and refused, never routed as "no network". */
  inactiveNetworks?: RoutingNetwork[];
  countries: SmsCountry[];
  rules: SmsRoutingRule[];
}

export interface Destination {
  network: RoutingNetwork | null;
  countryCode: string | null;
}

/** Machine-readable reasons a provider was excluded (with a readable message alongside). */
export type RejectionCode =
  | 'PROVIDER_INACTIVE'
  | 'PROVIDER_DOWN'
  | 'NO_ADAPTER'
  | 'UNSUPPORTED_DESTINATION'
  | 'SENDER_ID_UNSUPPORTED'
  | 'COST_ABOVE_MAXIMUM'
  | 'BELOW_RESERVE'
  | 'INSUFFICIENT_CAPACITY';

export interface CandidateEvaluation {
  provider: RoutingProvider;
  eligible: boolean;
  /** Why the provider cannot be used (empty when eligible). */
  reasons: string[];
  reasonCodes: RejectionCode[];
  cost: Prisma.Decimal;
  /** Capacity usable for this route after the reserve. */
  available: number;
  reserve: number;
  role: 'primary' | 'backup' | 'candidate';
}

export interface RoutePlan {
  destination: Destination;
  rule: SmsRoutingRule | null;
  strategy: SmsRoutingRule['strategy'];
  candidates: CandidateEvaluation[];
  selected: CandidateEvaluation | null;
  backup: CandidateEvaluation | null;
  reason: string;
}

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const HEALTH_RANK = { HEALTHY: 0, DEGRADED: 1, DOWN: 2 } as const;

export async function loadRoutingContext(db: Db): Promise<RoutingContext> {
  const [providers, links, countryLinks, countries, networks, rules] = await Promise.all([
    db.smsProvider.findMany({ orderBy: [{ priority: 'asc' }, { code: 'asc' }] }),
    db.smsProviderNetwork.findMany(),
    db.smsProviderCountry.findMany(),
    db.smsCountry.findMany({ orderBy: { name: 'asc' } }),
    db.smsNetwork.findMany({ orderBy: [{ countryCode: 'asc' }, { name: 'asc' }] }),
    db.smsRoutingRule.findMany({ where: { isActive: true }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
  ]);
  // Networks of inactive countries are not routable.
  const activeCountries = new Set(countries.filter((c) => c.isActive).map((c) => c.isoCode));
  return {
    providers: providers.map((p) => ({
      ...p,
      networkIds: links.filter((l) => l.providerId === p.id).map((l) => l.networkId),
      countryIds: countryLinks.filter((l) => l.providerId === p.id).map((l) => l.countryId),
    })),
    countries,
    networks: networks.filter((n) => n.isActive && activeCountries.has(n.countryCode)).map((n) => ({ ...n, prefixList: stringList(n.prefixes) })),
    inactiveNetworks: networks.filter((n) => !n.isActive).map((n) => ({ ...n, prefixList: stringList(n.prefixes) })),
    rules,
  };
}

/** Does the provider explicitly serve this destination (whole country, or the number's network)? */
export function servesDestination(ctx: RoutingContext, p: RoutingProvider, dest: Destination) {
  const country = dest.countryCode ? ctx.countries.find((c) => c.isoCode === dest.countryCode) : undefined;
  return (!!country && p.countryIds.includes(country.id)) || (!!dest.network && p.networkIds.includes(dest.network.id));
}

function destinationLabel(ctx: RoutingContext, dest: Destination) {
  if (dest.network) return dest.network.name;
  const country = ctx.countries.find((c) => c.isoCode === dest.countryCode);
  return country ? `${country.name} (outside its configured networks)` : 'this destination';
}

export function matchRule(ctx: RoutingContext, dest: Destination): SmsRoutingRule | null {
  return (
    ctx.rules.find(
      (r) => (r.countryCode === null || r.countryCode === dest.countryCode) && (r.networkId === null || r.networkId === dest.network?.id),
    ) ?? null
  );
}

function strategyOrder(strategy: SmsRoutingRule['strategy']) {
  return (a: RoutingProvider, b: RoutingProvider) => {
    const cost = D(a.costPerSms).comparedTo(D(b.costPerSms));
    const primary = strategy === 'LOWEST_COST' ? cost || a.priority - b.priority : a.priority - b.priority || cost;
    return primary || HEALTH_RANK[a.health] - HEALTH_RANK[b.health] || a.code.localeCompare(b.code);
  };
}

/**
 * Evaluate and order every candidate for one destination. `remaining` holds live capacity per
 * provider (callers decrement it as recipients are assigned); `need` is segments per recipient.
 */
export function planRoute(ctx: RoutingContext, dest: Destination, need: number, remaining: Map<string, number>, opts: { rule?: SmsRoutingRule | null } = {}): RoutePlan {
  // `opts.rule` previews a specific rule for the destination instead of the first matching one.
  const rule = opts.rule !== undefined ? opts.rule : matchRule(ctx, dest);
  const strategy = rule?.strategy ?? 'PRIORITY';
  const byId = new Map(ctx.providers.map((p) => [p.id, p]));
  const allowed = rule && strategy !== 'PRIMARY_BACKUP' ? stringList(rule.allowedProviderIds) : [];

  let ordered: { provider: RoutingProvider; role: CandidateEvaluation['role'] }[];
  if (rule && strategy === 'PRIMARY_BACKUP') {
    ordered = [rule.primaryProviderId, ...stringList(rule.backupProviderIds)]
      .filter((id): id is string => !!id && byId.has(id))
      .map((id, i) => ({ provider: byId.get(id)!, role: (i === 0 ? 'primary' : 'backup') as CandidateEvaluation['role'] }));
  } else {
    const pool = allowed.length ? ctx.providers.filter((p) => allowed.includes(p.id)) : ctx.providers;
    ordered = [...pool].sort(strategyOrder(strategy)).map((provider) => ({ provider, role: 'candidate' as const }));
  }

  const candidates = ordered.map(({ provider: p, role }): CandidateEvaluation => {
    const reasons: string[] = [];
    const reasonCodes: RejectionCode[] = [];
    const reject = (code: RejectionCode, message: string) => {
      reasonCodes.push(code);
      reasons.push(message);
    };
    const reserve = Math.max(p.minimumCapacity, rule?.minProviderCapacity ?? 0);
    const balance = remaining.get(p.id) ?? p.capacityBalance;
    const available = balance - reserve;
    const cost = D(p.costPerSms);
    if (p.status !== 'ACTIVE') reject('PROVIDER_INACTIVE', `Provider is ${p.status.toLowerCase()}`);
    if (p.health === 'DOWN') reject('PROVIDER_DOWN', 'Provider health is DOWN');
    if (!SmsProviderFactory.forProvider(p)) reject('NO_ADAPTER', 'No integration adapter installed');
    if (!servesDestination(ctx, p, dest)) reject('UNSUPPORTED_DESTINATION', `Not configured to serve ${destinationLabel(ctx, dest)}`);
    if (!p.supportsSenderId) reject('SENDER_ID_UNSUPPORTED', 'Does not support sender IDs');
    if (rule?.maxCostPerSegment && cost.gt(rule.maxCostPerSegment)) reject('COST_ABOVE_MAXIMUM', `Cost ${cost.toFixed(2)} exceeds the rule maximum ${D(rule.maxCostPerSegment).toFixed(2)}`);
    if (available < need) {
      if (balance >= need) reject('BELOW_RESERVE', `Capacity below reserve: ${Math.max(0, available).toLocaleString()} usable above the ${reserve.toLocaleString()} reserve, ${need.toLocaleString()} needed`);
      else reject('INSUFFICIENT_CAPACITY', `Insufficient capacity: ${Math.max(0, balance).toLocaleString()} available, ${need.toLocaleString()} needed`);
    }
    return { provider: p, eligible: reasons.length === 0, reasons, reasonCodes, cost, available: Math.max(0, available), reserve, role };
  });

  const eligible = candidates.filter((c) => c.eligible);
  const selected = eligible[0] ?? null;
  const backup = eligible[1] ?? null;
  return { destination: dest, rule, strategy, candidates, selected, backup, reason: explain(rule, strategy, candidates, selected) };
}

function explain(rule: SmsRoutingRule | null, strategy: SmsRoutingRule['strategy'], candidates: CandidateEvaluation[], selected: CandidateEvaluation | null): string {
  if (!selected) {
    const serving = candidates.filter((c) => !c.reasonCodes.includes('UNSUPPORTED_DESTINATION'));
    if (!serving.length) return 'No provider is configured for this destination — the send is refused and nothing is charged.';
    if (serving.every((c) => c.reasonCodes.some((r) => r === 'INSUFFICIENT_CAPACITY' || r === 'BELOW_RESERVE'))) return 'No provider has enough usable capacity — the send is refused and nothing is charged.';
    return 'No eligible provider — the send is refused and nothing is charged.';
  }
  const skipped = candidates.slice(0, candidates.indexOf(selected));
  const blocked = skipped.length ? ` (${skipped.map((c) => `${c.provider.name}: ${c.reasons[0].charAt(0).toLowerCase()}${c.reasons[0].slice(1)}`).join('; ')})` : '';
  if (strategy === 'PRIMARY_BACKUP') return selected.role === 'primary' ? 'Primary provider' : `Backup provider — the primary is unavailable${blocked}`;
  const eligibleCount = candidates.filter((c) => c.eligible).length;
  const base = eligibleCount === 1 ? 'Only eligible provider' : strategy === 'LOWEST_COST' ? 'Lowest eligible cost' : 'Highest-priority eligible provider';
  return `${base}${rule ? '' : ' (default routing: no rule matches this destination)'}${blocked ? `; skipped${blocked}` : ''}`;
}
