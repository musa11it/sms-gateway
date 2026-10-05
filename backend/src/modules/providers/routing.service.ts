import { Prisma, type SmsNetwork, type SmsProvider, type SmsRoutingRule } from '@prisma/client';
import type { Db } from '../../config/prisma';
import { SmsProviderFactory } from '../../integrations/sms/SmsProviderFactory';
import { stringList } from '../../utils/json';

/**
 * Routing engine: decides which provider carries a message to a destination. Pure planning over
 * a snapshot of configuration (providers, networks, rules); the caller reserves capacity.
 *
 *  1. Destination: the active network with the longest matching E.164 prefix (or none).
 *  2. Rule: the first active rule (lowest priority number) whose country/network match.
 *  3. Candidates: the rule's primary + backups in that order, or else every provider allowed by
 *     the rule (all providers without a rule), ordered by the rule's strategy.
 *  4. Eligibility: ACTIVE, adapter installed, health not DOWN, serves the destination, supports
 *     sender IDs, cost ≤ rule maximum, and enough capacity above the reserve (the larger of the
 *     provider's minimum capacity and the rule's minimum).
 *  5. The first eligible candidate is used; later eligible candidates are the backups.
 */

export type RoutingProvider = SmsProvider & { networkIds: string[] };
export type RoutingNetwork = SmsNetwork & { prefixList: string[] };

export interface RoutingContext {
  providers: RoutingProvider[];
  networks: RoutingNetwork[];
  rules: SmsRoutingRule[];
}

export interface Destination {
  network: RoutingNetwork | null;
  countryCode: string | null;
}

export interface CandidateEvaluation {
  provider: RoutingProvider;
  eligible: boolean;
  /** Why the provider cannot be used (empty when eligible). */
  reasons: string[];
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
  const [providers, links, networks, rules] = await Promise.all([
    db.smsProvider.findMany({ orderBy: [{ priority: 'asc' }, { code: 'asc' }] }),
    db.smsProviderNetwork.findMany(),
    db.smsNetwork.findMany({ where: { isActive: true } }),
    db.smsRoutingRule.findMany({ where: { isActive: true }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
  ]);
  return {
    providers: providers.map((p) => ({ ...p, networkIds: links.filter((l) => l.providerId === p.id).map((l) => l.networkId) })),
    networks: networks.map((n) => ({ ...n, prefixList: stringList(n.prefixes) })),
    rules,
  };
}

export function resolveDestination(ctx: RoutingContext, phone: string): Destination {
  let best: RoutingNetwork | null = null;
  let bestLen = 0;
  for (const n of ctx.networks) {
    for (const p of n.prefixList) {
      if (phone.startsWith(p) && p.length > bestLen) {
        best = n;
        bestLen = p.length;
      }
    }
  }
  return { network: best, countryCode: best?.countryCode ?? null };
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
    const health = HEALTH_RANK[a.health] - HEALTH_RANK[b.health];
    if (health) return health;
    const cost = D(a.costPerSms).comparedTo(D(b.costPerSms));
    if (strategy === 'LOWEST_COST') return cost || a.priority - b.priority;
    if (strategy === 'PRIORITY_THEN_COST') return a.priority - b.priority || cost;
    return a.priority - b.priority;
  };
}

/**
 * Evaluate and order every candidate for one destination. `remaining` holds live capacity per
 * provider (callers decrement it as recipients are assigned); `need` is segments per recipient.
 */
export function planRoute(ctx: RoutingContext, dest: Destination, need: number, remaining: Map<string, number>): RoutePlan {
  const rule = matchRule(ctx, dest);
  const strategy = rule?.strategy ?? 'PRIORITY';
  const byId = new Map(ctx.providers.map((p) => [p.id, p]));
  const allowed = rule ? stringList(rule.allowedProviderIds) : [];
  const backups = rule ? stringList(rule.backupProviderIds) : [];
  const explicit = rule && (rule.primaryProviderId || backups.length) ? [rule.primaryProviderId, ...backups].filter((x): x is string => !!x) : null;

  let ordered: { provider: RoutingProvider; role: CandidateEvaluation['role'] }[];
  if (explicit) {
    ordered = explicit
      .map((id, i) => ({ provider: byId.get(id)!, role: (i === 0 && rule!.primaryProviderId ? 'primary' : 'backup') as CandidateEvaluation['role'] }))
      .filter((c) => c.provider);
  } else {
    const pool = allowed.length ? ctx.providers.filter((p) => allowed.includes(p.id)) : ctx.providers;
    ordered = [...pool].sort(strategyOrder(strategy)).map((provider) => ({ provider, role: 'candidate' as const }));
  }

  const candidates = ordered.map(({ provider: p, role }): CandidateEvaluation => {
    const reasons: string[] = [];
    const reserve = Math.max(p.minimumCapacity, rule?.minProviderCapacity ?? 0);
    const available = (remaining.get(p.id) ?? p.capacityBalance) - reserve;
    const cost = D(p.costPerSms);
    if (p.status !== 'ACTIVE') reasons.push(`Provider is ${p.status.toLowerCase()}`);
    if (p.health === 'DOWN') reasons.push('Health is DOWN');
    if (!SmsProviderFactory.forProvider(p)) reasons.push('No integration adapter installed');
    if (!p.servesAllDestinations && !(dest.network && p.networkIds.includes(dest.network.id))) {
      reasons.push(dest.network ? `Does not serve ${dest.network.name}` : 'Does not serve destinations outside configured networks');
    }
    if (!p.supportsSenderId) reasons.push('Does not support sender IDs');
    if (rule?.maxCostPerSegment && cost.gt(rule.maxCostPerSegment)) reasons.push(`Cost ${cost.toFixed(2)} exceeds the rule maximum ${D(rule.maxCostPerSegment).toFixed(2)}`);
    if (available < need) {
      reasons.push(
        reserve > 0
          ? `Insufficient capacity: ${Math.max(0, available).toLocaleString()} usable above the ${reserve.toLocaleString()} reserve, ${need.toLocaleString()} needed`
          : `Insufficient capacity: ${Math.max(0, available).toLocaleString()} available, ${need.toLocaleString()} needed`,
      );
    }
    return { provider: p, eligible: reasons.length === 0, reasons, cost, available: Math.max(0, available), reserve, role };
  });

  const eligible = candidates.filter((c) => c.eligible);
  const selected = eligible[0] ?? null;
  const backup = eligible[1] ?? null;
  return { destination: dest, rule, strategy, candidates, selected, backup, reason: explain(rule, strategy, candidates, selected) };
}

function explain(rule: SmsRoutingRule | null, strategy: SmsRoutingRule['strategy'], candidates: CandidateEvaluation[], selected: CandidateEvaluation | null): string {
  if (!selected) return candidates.length ? 'No eligible provider: every candidate was excluded (see reasons).' : 'No provider is configured for this destination.';
  const skipped = candidates.slice(0, candidates.indexOf(selected)).map((c) => `${c.provider.name}: ${c.reasons[0]}`);
  const via = rule ? `rule "${rule.name}"` : 'default routing (no rule matched)';
  let why: string;
  if (selected.role === 'primary') why = `Primary provider of ${via}`;
  else if (selected.role === 'backup') why = `Backup provider of ${via}`;
  else if (strategy === 'LOWEST_COST') why = `Lowest-cost eligible provider under ${via}`;
  else if (strategy === 'PRIORITY_THEN_COST') why = `Highest-priority eligible provider (cost as tie-breaker) under ${via}`;
  else why = `Highest-priority eligible provider with sufficient capacity under ${via}`;
  return skipped.length ? `${why}; skipped ${skipped.join('; ')}.` : `${why}.`;
}
