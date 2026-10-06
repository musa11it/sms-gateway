import { Prisma, type SmsNetwork, type SmsRoutingRule } from '@prisma/client';
import { z } from 'zod';
import { prisma, type Tx } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { stringList } from '../../utils/json';
import { audit } from '../audit-logs/audit.service';
import { loadRoutingContext, planRoute, type CandidateEvaluation, type Destination, type RoutePlan, type RoutingContext } from './routing.service';

/** Super Admin management of destination networks and routing rules (all changes audited). */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const prefix = z.string().trim().regex(/^\+\d{1,8}$/, 'Prefixes look like +25078');

// ── Networks ─────────────────────────────────────────────────────────────

export const networkBody = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/, 'Letters, digits, - and _ (e.g. RW-MTN)'),
    name: z.string().trim().min(2).max(80),
    countryCode: z.string().trim().length(2).toUpperCase(),
    countryName: z.string().trim().min(2).max(80),
    prefixes: z.array(prefix).min(1, 'Add at least one prefix').max(50),
    isActive: z.boolean().default(true),
  })
  .strict();

export function serializeNetwork(n: SmsNetwork & { _count?: { providers: number } }) {
  return { id: n.id, code: n.code, name: n.name, countryCode: n.countryCode, countryName: n.countryName, prefixes: stringList(n.prefixes), isActive: n.isActive, providerCount: n._count?.providers, updatedAt: n.updatedAt };
}

async function assertUniquePrefixes(tx: Tx, prefixes: string[], exceptId?: string) {
  if (new Set(prefixes).size !== prefixes.length) throw AppError.unprocessable('A prefix is listed twice', 'DUPLICATE_PREFIX');
  const others = await tx.smsNetwork.findMany({ where: { isActive: true, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  for (const o of others) {
    const clash = stringList(o.prefixes).find((p) => prefixes.includes(p));
    if (clash) throw AppError.conflict(`Prefix ${clash} already belongs to ${o.name}`, 'PREFIX_IN_USE');
  }
}

export async function createNetwork(input: z.infer<typeof networkBody>, actor: Actor, meta?: RequestMeta) {
  return prisma.$transaction(async (tx) => {
    if (input.isActive) await assertUniquePrefixes(tx, input.prefixes);
    const n = await tx.smsNetwork.create({ data: input });
    await audit({ actor, action: 'ROUTING_NETWORK_CREATED', resource: 'sms_network', resourceId: n.id, metadata: { network: serializeNetwork(n) }, meta }, tx);
    return n;
  });
}

export async function updateNetwork(id: string, input: Partial<z.infer<typeof networkBody>>, actor: Actor, meta?: RequestMeta) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.smsNetwork.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Network');
    const prefixes = input.prefixes ?? stringList(before.prefixes);
    if (input.isActive ?? before.isActive) await assertUniquePrefixes(tx, prefixes, id);
    const n = await tx.smsNetwork.update({ where: { id }, data: input });
    await audit({ actor, action: 'ROUTING_NETWORK_UPDATED', resource: 'sms_network', resourceId: id, metadata: { before: serializeNetwork(before), after: serializeNetwork(n) }, meta }, tx);
    return n;
  });
}

/**
 * Delete a destination network. Refused while a routing rule targets it (change the rule first) or
 * once messages have been routed to it (deactivate it instead, so message history stays accurate).
 * Provider capability links to the network are removed with it.
 */
export async function deleteNetwork(id: string, actor: Actor, meta?: RequestMeta) {
  return prisma.$transaction(async (tx) => {
    const network = await tx.smsNetwork.findUnique({ where: { id }, include: { _count: { select: { providers: true } } } });
    if (!network) throw AppError.notFound('Network');
    const rules = await tx.smsRoutingRule.findMany({ where: { networkId: id }, select: { name: true } });
    if (rules.length) {
      throw AppError.conflict(`${network.name} is used by routing rule${rules.length > 1 ? 's' : ''} ${rules.map((r) => `"${r.name}"`).join(', ')}. Change or remove the rule's network first.`, 'NETWORK_IN_USE');
    }
    const messages = await tx.smsRecipient.count({ where: { networkId: id } });
    if (messages) {
      throw AppError.conflict(`${messages.toLocaleString()} messages were routed to ${network.name}; deactivate it instead so their history stays accurate.`, 'NETWORK_HAS_HISTORY');
    }
    await tx.smsNetwork.delete({ where: { id } });
    await audit({ actor, action: 'ROUTING_NETWORK_DELETED', resource: 'sms_network', resourceId: id, metadata: { network: serializeNetwork(network), providerLinksRemoved: network._count.providers }, meta }, tx);
  });
}

// ── Rules ────────────────────────────────────────────────────────────────

const ruleFields = {
  name: z.string().trim().min(2).max(80),
  countryCode: z.string().trim().length(2).toUpperCase().nullable(),
  networkId: z.string().uuid().nullable(),
  strategy: z.enum(['LOWEST_COST', 'PRIORITY', 'PRIMARY_BACKUP']),
  primaryProviderId: z.string().uuid().nullable(),
  backupProviderIds: z.array(z.string().uuid()).max(20),
  allowedProviderIds: z.array(z.string().uuid()).max(50),
  minProviderCapacity: z.coerce.number().int().min(0).max(100_000_000),
  maxCostPerSegment: z.string().trim().regex(/^\d{1,8}(\.\d{1,4})?$/, 'Decimal with up to 4 places').nullable(),
  isActive: z.boolean(),
  description: z.string().trim().max(500).nullable(),
};

export const ruleCreateBody = z
  .object({
    ...ruleFields,
    countryCode: ruleFields.countryCode.default(null),
    networkId: ruleFields.networkId.default(null),
    strategy: ruleFields.strategy.default('PRIORITY'),
    primaryProviderId: ruleFields.primaryProviderId.default(null),
    backupProviderIds: ruleFields.backupProviderIds.default([]),
    allowedProviderIds: ruleFields.allowedProviderIds.default([]),
    minProviderCapacity: ruleFields.minProviderCapacity.default(0),
    maxCostPerSegment: ruleFields.maxCostPerSegment.default(null),
    isActive: ruleFields.isActive.default(true),
    description: ruleFields.description.default(null),
    priority: z.coerce.number().int().min(1).max(10_000).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const ruleUpdateBody = z.object(ruleFields).partial().extend({ reason: z.string().trim().max(500).optional() }).strict();

export function serializeRule(r: SmsRoutingRule & { network?: { name: string } | null; primaryProvider?: { name: string } | null }, providerNames?: Map<string, string>) {
  const backups = stringList(r.backupProviderIds);
  const allowed = stringList(r.allowedProviderIds);
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    countryCode: r.countryCode,
    networkId: r.networkId,
    destination: r.network?.name ?? (r.countryCode ? `Any network in ${r.countryCode}` : 'Any destination'),
    strategy: r.strategy,
    primaryProviderId: r.primaryProviderId,
    primaryProvider: r.primaryProvider?.name ?? null,
    backupProviderIds: backups,
    backupProviders: backups.map((id) => providerNames?.get(id) ?? id),
    allowedProviderIds: allowed,
    allowedProviders: allowed.map((id) => providerNames?.get(id) ?? id),
    minProviderCapacity: r.minProviderCapacity,
    maxCostPerSegment: r.maxCostPerSegment ? D(r.maxCostPerSegment).toFixed(2) : null,
    isActive: r.isActive,
    description: r.description,
    updatedAt: r.updatedAt,
    createdAt: r.createdAt,
  };
}

type RuleShape = {
  strategy: 'LOWEST_COST' | 'PRIORITY' | 'PRIMARY_BACKUP';
  countryCode: string | null;
  networkId: string | null;
  primaryProviderId: string | null;
  backupProviderIds: string[];
  allowedProviderIds: string[];
};

/**
 * Normalises and validates a rule. Each strategy uses only its own fields:
 *  - LOWEST_COST / PRIORITY: `allowedProviderIds` is the pool (empty = every provider serving the destination)
 *  - PRIMARY_BACKUP: `primaryProviderId` (required) then `backupProviderIds` in order
 * `explicit` holds the fields the request actually sent, so contradicting input is rejected while
 * leftovers from a previous strategy are simply cleared.
 */
async function validateRule(tx: Tx, r: RuleShape, explicit: Partial<RuleShape>) {
  let countryCode = r.countryCode;
  if (r.networkId) {
    const network = await tx.smsNetwork.findUnique({ where: { id: r.networkId } });
    if (!network) throw AppError.unprocessable('Unknown network', 'UNKNOWN_NETWORK', [{ field: 'networkId', message: 'Unknown network' }]);
    if (countryCode && countryCode !== network.countryCode) throw AppError.unprocessable(`${network.name} is in ${network.countryCode}, not ${countryCode}`, 'COUNTRY_MISMATCH', [{ field: 'countryCode', message: 'Does not match the network' }]);
    countryCode = network.countryCode;
  }
  let fields: Pick<RuleShape, 'primaryProviderId' | 'backupProviderIds' | 'allowedProviderIds'>;
  if (r.strategy === 'PRIMARY_BACKUP') {
    if (explicit.allowedProviderIds?.length) throw AppError.unprocessable('A provider pool applies to Lowest cost and Priority rules; Primary + backup uses its ordered list', 'STRATEGY_FIELD_MISMATCH', [{ field: 'allowedProviderIds', message: 'Not used by Primary + backup' }]);
    if (!r.primaryProviderId) throw AppError.unprocessable('Choose the primary provider', 'PRIMARY_REQUIRED', [{ field: 'primaryProviderId', message: 'Required for Primary + backup' }]);
    const backups = r.backupProviderIds;
    if (new Set(backups).size !== backups.length) throw AppError.unprocessable('A backup provider is listed twice', 'DUPLICATE_PROVIDER', [{ field: 'backupProviderIds', message: 'Duplicate' }]);
    if (backups.includes(r.primaryProviderId)) throw AppError.unprocessable('The primary provider cannot also be a backup', 'DUPLICATE_PROVIDER', [{ field: 'backupProviderIds', message: 'Primary is also a backup' }]);
    fields = { primaryProviderId: r.primaryProviderId, backupProviderIds: backups, allowedProviderIds: [] };
  } else {
    if (explicit.primaryProviderId || explicit.backupProviderIds?.length) {
      throw AppError.unprocessable('Primary and backup providers apply only to the Primary + backup strategy', 'STRATEGY_FIELD_MISMATCH', [{ field: 'strategy', message: 'Use Primary + backup for a fixed provider order' }]);
    }
    if (new Set(r.allowedProviderIds).size !== r.allowedProviderIds.length) throw AppError.unprocessable('A provider is listed twice', 'DUPLICATE_PROVIDER', [{ field: 'allowedProviderIds', message: 'Duplicate' }]);
    fields = { primaryProviderId: null, backupProviderIds: [], allowedProviderIds: r.allowedProviderIds };
  }
  const ids = [...new Set([...(fields.primaryProviderId ? [fields.primaryProviderId] : []), ...fields.backupProviderIds, ...fields.allowedProviderIds])];
  if (ids.length) {
    const found = await tx.smsProvider.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw AppError.unprocessable('One or more providers do not exist', 'UNKNOWN_PROVIDER');
  }
  return { countryCode, ...fields };
}

/** Summarises a routing plan for the admin UI: who is used, at what cost, why, and who is next. */
export function summarisePlan(plan: RoutePlan) {
  const pick = (c: CandidateEvaluation | null) => (c ? { providerId: c.provider.id, name: c.provider.name, costPerSegment: c.cost.toFixed(2), available: c.available } : null);
  return {
    selected: pick(plan.selected),
    backup: pick(plan.backup),
    reason: plan.reason,
    rejected: plan.candidates.filter((c) => !c.eligible).map((c) => ({ providerId: c.provider.id, name: c.provider.name, reason: c.reasons[0] })),
  };
}

/** Destination used to preview a rule: its network, else the first network in its country, else "other destinations". */
function previewDestination(ctx: RoutingContext, r: SmsRoutingRule): Destination {
  const network = r.networkId ? ctx.networks.find((n) => n.id === r.networkId) : r.countryCode ? ctx.networks.find((n) => n.countryCode === r.countryCode) : undefined;
  return { network: network ?? null, countryCode: network?.countryCode ?? r.countryCode };
}

/** An earlier active rule that matches everything this rule matches, so this rule is never reached. */
function shadowingRule(rules: SmsRoutingRule[], r: SmsRoutingRule) {
  return rules.find(
    (o) =>
      o.id !== r.id &&
      o.isActive &&
      (o.priority < r.priority || (o.priority === r.priority && o.createdAt < r.createdAt)) &&
      (o.countryCode === null || o.countryCode === r.countryCode) &&
      (o.networkId === null || o.networkId === r.networkId),
  );
}

export async function listRules() {
  const [rules, providers, ctx] = await Promise.all([
    prisma.smsRoutingRule.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }], include: { network: { select: { name: true } }, primaryProvider: { select: { name: true } } } }),
    prisma.smsProvider.findMany({ select: { id: true, name: true } }),
    loadRoutingContext(prisma),
  ]);
  const names = new Map(providers.map((p) => [p.id, p.name]));
  const capacity = new Map(ctx.providers.map((p) => [p.id, p.capacityBalance]));
  return rules.map((r) => {
    const dest = previewDestination(ctx, r);
    const shadow = r.isActive ? shadowingRule(rules, r) : undefined;
    return {
      ...serializeRule(r, names),
      // What this rule chooses right now for one 1-segment message (no capacity is reserved).
      preview: { destination: dest.network?.name ?? (dest.countryCode ? `${dest.countryCode} (no network)` : 'Other destinations'), ...summarisePlan(planRoute(ctx, dest, 1, capacity, { rule: r })) },
      shadowedBy: shadow ? { id: shadow.id, name: shadow.name } : null,
    };
  });
}

/** How messages route right now, per destination network plus everything outside them. */
export async function routingOverview() {
  const ctx = await loadRoutingContext(prisma);
  const capacity = new Map(ctx.providers.map((p) => [p.id, p.capacityBalance]));
  const destinations: Destination[] = [...ctx.networks.map((n) => ({ network: n, countryCode: n.countryCode })), { network: null, countryCode: null }];
  return destinations.map((dest) => {
    const plan = planRoute(ctx, dest, 1, capacity);
    return {
      destination: dest.network ? `${dest.network.countryName} / ${dest.network.name}` : 'Other destinations (no configured network)',
      networkId: dest.network?.id ?? null,
      rule: plan.rule ? { id: plan.rule.id, name: plan.rule.name, strategy: plan.rule.strategy } : null,
      strategy: plan.strategy,
      ...summarisePlan(plan),
    };
  });
}

export async function createRule(input: z.infer<typeof ruleCreateBody>, actor: Actor, meta?: RequestMeta) {
  const { reason, ...data } = input;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sms_routing_rules FOR UPDATE`;
    const normalised = await validateRule(tx, data, input);
    const last = await tx.smsRoutingRule.aggregate({ _max: { priority: true } });
    const rule = await tx.smsRoutingRule.create({
      data: {
        ...data,
        ...normalised,
        priority: data.priority ?? (last._max.priority ?? 0) + 1,
        maxCostPerSegment: data.maxCostPerSegment ? D(data.maxCostPerSegment) : null,
        createdById: actorUserId(actor),
        updatedById: actorUserId(actor),
      },
    });
    await audit({ actor, action: 'ROUTING_RULE_CREATED', resource: 'sms_routing_rule', resourceId: rule.id, metadata: { rule: serializeRule(rule), reason }, meta }, tx);
    return rule;
  });
}

export async function updateRule(id: string, input: z.infer<typeof ruleUpdateBody>, actor: Actor, meta?: RequestMeta) {
  const { reason, ...data } = input;
  return prisma.$transaction(async (tx) => {
    const before = await tx.smsRoutingRule.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Routing rule');
    const merged: RuleShape = {
      strategy: data.strategy ?? before.strategy,
      countryCode: data.countryCode !== undefined ? data.countryCode : before.countryCode,
      networkId: data.networkId !== undefined ? data.networkId : before.networkId,
      primaryProviderId: data.primaryProviderId !== undefined ? data.primaryProviderId : before.primaryProviderId,
      backupProviderIds: data.backupProviderIds ?? stringList(before.backupProviderIds),
      allowedProviderIds: data.allowedProviderIds ?? stringList(before.allowedProviderIds),
    };
    const normalised = await validateRule(tx, merged, data);
    const rule = await tx.smsRoutingRule.update({
      where: { id },
      data: {
        ...data,
        ...normalised,
        maxCostPerSegment: data.maxCostPerSegment === undefined ? undefined : data.maxCostPerSegment === null ? null : D(data.maxCostPerSegment),
        updatedById: actorUserId(actor),
      },
    });
    const b = serializeRule(before);
    const a = serializeRule(rule);
    const keys = ['name', 'countryCode', 'networkId', 'strategy', 'primaryProviderId', 'backupProviderIds', 'allowedProviderIds', 'minProviderCapacity', 'maxCostPerSegment', 'isActive', 'description'] as const;
    const changes = Object.fromEntries(keys.filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k])).map((k) => [k, { from: b[k], to: a[k] }]));
    if (Object.keys(changes).length) {
      const action = Object.keys(changes).length === 1 && changes.isActive ? (rule.isActive ? 'ROUTING_RULE_ACTIVATED' : 'ROUTING_RULE_DEACTIVATED') : 'ROUTING_RULE_UPDATED';
      await audit({ actor, action, resource: 'sms_routing_rule', resourceId: id, metadata: { name: rule.name, changes, reason }, meta }, tx);
    }
    return rule;
  });
}

/** Renumber priorities 1..n in the given order (must list every rule exactly once). */
export async function reorderRules(ids: string[], actor: Actor, meta?: RequestMeta) {
  return prisma.$transaction(async (tx) => {
    const rules = await tx.$queryRaw<{ id: string; priority: number; name: string }[]>`SELECT id, priority, name FROM sms_routing_rules FOR UPDATE`;
    if (ids.length !== rules.length || new Set(ids).size !== ids.length || !ids.every((id) => rules.some((r) => r.id === id))) {
      throw AppError.unprocessable('Send every routing rule exactly once in the new order', 'INVALID_ORDER');
    }
    const before = [...rules].sort((x, y) => x.priority - y.priority).map((r) => r.name);
    for (const [i, id] of ids.entries()) await tx.smsRoutingRule.update({ where: { id }, data: { priority: i + 1, updatedById: actorUserId(actor) } });
    const after = ids.map((id) => rules.find((r) => r.id === id)!.name);
    await audit({ actor, action: 'ROUTING_RULES_REORDERED', resource: 'sms_routing_rule', resourceId: null, metadata: { before, after }, meta }, tx);
  });
}
