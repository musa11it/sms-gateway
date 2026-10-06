import { Prisma, type SmsNetwork, type SmsProvider, type SmsRoutingRule } from '@prisma/client';
import type { Db } from '../../config/prisma';
import { SmsProviderFactory } from '../../integrations/sms/SmsProviderFactory';
import { stringList } from '../../utils/json';

/**
 * Routing engine: decides which provider carries a message to a destination. Pure planning over
 * a snapshot of configuration (providers, networks, rules); the caller reserves capacity.
 *
 *  1. Destination: the active network with the longest matching E.164 prefix (or none).
 *  2. Rule: the first active rule in order (lowest priority number) whose country/network match.
 *     No match = default routing: every provider serving the destination, by priority.
 *  3. Candidates, by strategy:
 *       LOWEST_COST    the rule's provider pool (empty = all serving the destination), cheapest first
 *       PRIORITY       the same pool, highest priority (lowest number) first
 *       PRIMARY_BACKUP the primary, then the backups in their configured order
 *     Ties fall back to the other key (cost/priority), then healthy before degraded.
 *  4. Eligibility: ACTIVE, adapter installed, health not DOWN, serves the destination, supports
 *     sender IDs, cost ≤ rule maximum, and enough capacity above the reserve (the larger of the
 *     provider's minimum capacity and the rule's minimum).
 *  5. The first eligible candidate is used; the next eligible one is the backup. No eligible
 *     candidate = the send is refused before anything is charged or reserved.
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
    db.smsNetwork.findMany({ where: { isActive: true }, orderBy: [{ countryCode: 'asc' }, { name: 'asc' }] }),
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
  if (!selected) return candidates.length ? 'No eligible provider — the send would be refused and nothing charged.' : 'No provider serves this destination — the send would be refused and nothing charged.';
  const skipped = candidates.slice(0, candidates.indexOf(selected));
  const blocked = skipped.length ? ` (${skipped.map((c) => `${c.provider.name}: ${c.reasons[0].charAt(0).toLowerCase()}${c.reasons[0].slice(1)}`).join('; ')})` : '';
  if (strategy === 'PRIMARY_BACKUP') return selected.role === 'primary' ? 'Primary provider' : `Backup provider — the primary is unavailable${blocked}`;
  const base = strategy === 'LOWEST_COST' ? 'Lowest eligible cost' : 'Highest-priority eligible provider';
  return `${base}${rule ? '' : ' (default routing: no rule matches this destination)'}${blocked ? `; skipped${blocked}` : ''}`;
}
