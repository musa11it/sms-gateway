import { Prisma, type SmsNetwork, type SmsRoutingRule } from '@prisma/client';
import { z } from 'zod';
import { prisma, type Tx } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { stringList } from '../../utils/json';
import { audit } from '../audit-logs/audit.service';
import { callingCodeFor, countryName, isKnownCountry } from './destination.service';
import { loadRoutingContext, planRoute, type CandidateEvaluation, type Destination, type RoutePlan, type RoutingContext } from './routing.service';

/** Super Admin management of destination countries, networks and routing rules (all changes audited). */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const prefix = z.string().trim().regex(/^\+\d{1,8}$/, 'Prefixes look like +25078');

// ── Countries ────────────────────────────────────────────────────────────

const lengthList = z.array(z.coerce.number().int().min(4, 'At least 4 digits').max(15, 'At most 15 digits')).max(5);

export const countryBody = z
  .object({
    isoCode: z
      .string()
      .trim()
      .toUpperCase()
      .length(2, 'Use the 2-letter ISO code (e.g. KE)')
      .refine(isKnownCountry, 'Unknown country code'),
    name: z.string().trim().min(2).max(80).optional(),
    isActive: z.boolean().default(true),
    validationMode: z.enum(['STRICT', 'LENGTH']).default('STRICT'),
    nationalNumberLengths: lengthList.default([]),
    // Providers that can deliver to every number of the country.
    providerIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .strict();

export const countryUpdateBody = countryBody.omit({ isoCode: true }).partial().strict();

type CountryRow = Prisma.SmsCountryGetPayload<{ include: { networks: { include: { _count: { select: { providers: true } } } }; providers: { include: { provider: { select: { id: true; name: true; code: true } } } } } }>;

/** Configuration status: does every number of the country have at least one provider? */
function countryStatus(c: CountryRow) {
  if (!c.isActive) return 'INACTIVE' as const;
  const countryWide = c.providers.length > 0;
  const activeNetworks = c.networks.filter((n) => n.isActive);
  const covered = activeNetworks.filter((n) => n._count.providers > 0).length;
  if (countryWide) return 'CONFIGURED' as const;
  if (!covered) return 'NO_PROVIDER' as const;
  // Networks are covered but numbers outside them (or uncovered networks) have no provider.
  return covered === activeNetworks.length ? ('NETWORKS_ONLY' as const) : ('PARTIAL' as const);
}

export function serializeCountry(c: CountryRow) {
  return {
    id: c.id,
    isoCode: c.isoCode,
    name: c.name,
    callingCode: callingCodeFor(c.isoCode),
    isActive: c.isActive,
    validationMode: c.validationMode,
    nationalNumberLengths: (c.nationalNumberLengths as number[]) ?? [],
    networkCount: c.networks.length,
    providers: c.providers.map((p) => p.provider),
    status: countryStatus(c),
    updatedAt: c.updatedAt,
  };
}

const countryInclude = { networks: { include: { _count: { select: { providers: true } } } }, providers: { include: { provider: { select: { id: true, name: true, code: true } } } } } as const;

export async function listCountries() {
  const rows = await prisma.smsCountry.findMany({ orderBy: { name: 'asc' }, include: countryInclude });
  return rows.map(serializeCountry);
}

async function setCountryProviders(tx: Tx, countryId: string, providerIds: string[]) {
  const unique = [...new Set(providerIds)];
  if (unique.length && (await tx.smsProvider.count({ where: { id: { in: unique } } })) !== unique.length) throw AppError.unprocessable('One or more providers do not exist', 'UNKNOWN_PROVIDER');
  await tx.smsProviderCountry.deleteMany({ where: { countryId } });
  if (unique.length) await tx.smsProviderCountry.createMany({ data: unique.map((providerId) => ({ providerId, countryId })) });
}

export async function createCountry(input: z.infer<typeof countryBody>, actor: Actor, meta?: RequestMeta) {
  const { providerIds, ...data } = input;
  return prisma.$transaction(async (tx) => {
    if (await tx.smsCountry.findUnique({ where: { isoCode: data.isoCode } })) throw AppError.conflict(`${countryName(data.isoCode)} is already configured`, 'COUNTRY_EXISTS');
    const c = await tx.smsCountry.create({ data: { ...data, name: data.name ?? countryName(data.isoCode) } });
    if (providerIds) await setCountryProviders(tx, c.id, providerIds);
    const row = await tx.smsCountry.findUniqueOrThrow({ where: { id: c.id }, include: countryInclude });
    await audit({ actor, action: 'ROUTING_COUNTRY_CREATED', resource: 'sms_country', resourceId: c.id, metadata: { country: serializeCountry(row) }, meta }, tx);
    return row;
  });
}

export async function updateCountry(id: string, input: z.infer<typeof countryUpdateBody>, actor: Actor, meta?: RequestMeta) {
  const { providerIds, ...data } = input;
  return prisma.$transaction(async (tx) => {
    const before = await tx.smsCountry.findUnique({ where: { id }, include: countryInclude });
    if (!before) throw AppError.notFound('Country');
    await tx.smsCountry.update({ where: { id }, data });
    if (data.name && data.name !== before.name) await tx.smsNetwork.updateMany({ where: { countryCode: before.isoCode }, data: { countryName: data.name } });
    if (providerIds) await setCountryProviders(tx, id, providerIds);
    const row = await tx.smsCountry.findUniqueOrThrow({ where: { id }, include: countryInclude });
    await audit({ actor, action: 'ROUTING_COUNTRY_UPDATED', resource: 'sms_country', resourceId: id, metadata: { before: serializeCountry(before), after: serializeCountry(row) }, meta }, tx);
    return row;
  });
}

/**
 * Deletes a country together with its networks, only when nothing depends on them: no routing rule
 * targets the country or one of its networks, and no message was ever sent there (disable instead).
 */
export async function deleteCountry(id: string, actor: Actor, meta?: RequestMeta) {
  return prisma.$transaction(async (tx) => {
    const country = await tx.smsCountry.findUnique({ where: { id }, include: countryInclude });
    if (!country) throw AppError.notFound('Country');
    const networks = await tx.smsNetwork.findMany({ where: { countryCode: country.isoCode } });
    const networkIds = networks.map((n) => n.id);
    const rules = await tx.smsRoutingRule.findMany({ where: { OR: [{ countryCode: country.isoCode }, { networkId: { in: networkIds } }] }, select: { name: true } });
    if (rules.length) {
      throw AppError.conflict(`${country.name} is used by routing rule${rules.length > 1 ? 's' : ''} ${rules.map((r) => `"${r.name}"`).join(', ')}. Change or remove the rule first.`, 'COUNTRY_IN_USE');
    }
    const messages = await tx.smsRecipient.count({ where: { OR: [{ countryCode: country.isoCode }, { networkId: { in: networkIds } }] } });
    if (messages) throw AppError.conflict(`${messages.toLocaleString()} messages were sent to ${country.name}; disable it instead so their history stays accurate.`, 'COUNTRY_HAS_HISTORY');
    await tx.smsNetwork.deleteMany({ where: { id: { in: networkIds } } });
    await tx.smsCountry.delete({ where: { id } });
    await audit(
      { actor, action: 'ROUTING_COUNTRY_DELETED', resource: 'sms_country', resourceId: id, metadata: { country: serializeCountry(country), networksDeleted: networks.map((n) => n.code) }, meta },
      tx,
    );
  });
}

// ── Networks ─────────────────────────────────────────────────────────────

export const networkBody = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/, 'Letters, digits, - and _ (e.g. RW-MTN)'),
    name: z.string().trim().min(2).max(80),
    countryCode: z.string().trim().length(2).toUpperCase(),
    prefixes: z.array(prefix).min(1, 'At least one valid prefix is required').max(50),
    nationalNumberLengths: lengthList.optional(),
    isActive: z.boolean().default(true),
    // Providers that can deliver to this network.
    providerIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .strict();

type NetworkRow = SmsNetwork & { _count?: { providers: number }; providers?: { provider: { id: string; name: string; code: string } }[] };

export function serializeNetwork(n: NetworkRow) {
  return {
    id: n.id,
    code: n.code,
    name: n.name,
    countryCode: n.countryCode,
    countryName: n.countryName,
    callingCode: callingCodeFor(n.countryCode),
    prefixes: stringList(n.prefixes),
    nationalNumberLengths: Array.isArray(n.nationalNumberLengths) ? (n.nationalNumberLengths as number[]) : [],
    isActive: n.isActive,
    providerCount: n._count?.providers ?? n.providers?.length,
    providers: n.providers?.map((p) => p.provider) ?? [],
    updatedAt: n.updatedAt,
  };
}

export const networkInclude = { _count: { select: { providers: true } }, providers: { include: { provider: { select: { id: true, name: true, code: true } } } } } as const;

/** Country must exist (and be active for an active network); prefixes must sit inside the country and be unique. */
async function validateNetwork(tx: Tx, input: { countryCode: string; prefixes: string[]; isActive: boolean }, exceptId?: string) {
  const country = await tx.smsCountry.findUnique({ where: { isoCode: input.countryCode } });
  if (!country) throw AppError.unprocessable(`${countryName(input.countryCode)} is not a configured country. Add the country first.`, 'COUNTRY_NOT_CONFIGURED', [{ field: 'countryCode', message: 'Add the country first' }]);
  if (input.isActive && !country.isActive) throw AppError.unprocessable('Network must belong to an active country', 'COUNTRY_INACTIVE', [{ field: 'countryCode', message: 'Country is inactive' }]);
  const cc = `+${callingCodeFor(country.isoCode)}`;
  for (const p of input.prefixes) {
    if (!p.startsWith(cc)) throw AppError.unprocessable(`Prefix ${p} is not a ${country.name} number (must start with ${cc})`, 'PREFIX_COUNTRY_MISMATCH', [{ field: 'prefixes', message: `Must start with ${cc}` }]);
    if (p === cc) throw AppError.unprocessable(`Prefix ${p} is the whole of ${country.name}; give providers country-wide capability instead`, 'PREFIX_TOO_SHORT', [{ field: 'prefixes', message: `Longer than ${cc}` }]);
  }
  if (new Set(input.prefixes).size !== input.prefixes.length) throw AppError.unprocessable('A prefix is listed twice', 'DUPLICATE_PREFIX', [{ field: 'prefixes', message: 'Duplicate' }]);
  if (!input.isActive) return country;
  const others = await tx.smsNetwork.findMany({ where: { isActive: true, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  for (const o of others) {
    const clash = stringList(o.prefixes).find((p) => input.prefixes.includes(p));
    if (clash) throw AppError.conflict(`Prefix ${clash} already belongs to another configured destination (${o.name})`, 'PREFIX_IN_USE');
  }
  return country;
}

async function setNetworkProviders(tx: Tx, networkId: string, providerIds: string[]) {
  const unique = [...new Set(providerIds)];
  if (unique.length && (await tx.smsProvider.count({ where: { id: { in: unique } } })) !== unique.length) throw AppError.unprocessable('One or more providers do not exist', 'UNKNOWN_PROVIDER');
  await tx.smsProviderNetwork.deleteMany({ where: { networkId } });
  if (unique.length) await tx.smsProviderNetwork.createMany({ data: unique.map((providerId) => ({ providerId, networkId })) });
}

export async function createNetwork(input: z.infer<typeof networkBody>, actor: Actor, meta?: RequestMeta) {
  const { providerIds, nationalNumberLengths, ...data } = input;
  return prisma.$transaction(async (tx) => {
    const country = await validateNetwork(tx, data);
    const n = await tx.smsNetwork.create({ data: { ...data, countryName: country.name, nationalNumberLengths: nationalNumberLengths ?? [] } });
    if (providerIds) await setNetworkProviders(tx, n.id, providerIds);
    const row = await tx.smsNetwork.findUniqueOrThrow({ where: { id: n.id }, include: networkInclude });
    await audit({ actor, action: 'ROUTING_NETWORK_CREATED', resource: 'sms_network', resourceId: n.id, metadata: { network: serializeNetwork(row) }, meta }, tx);
    return row;
  });
}

export async function updateNetwork(id: string, input: Partial<z.infer<typeof networkBody>>, actor: Actor, meta?: RequestMeta) {
  const { providerIds, nationalNumberLengths, ...data } = input;
  return prisma.$transaction(async (tx) => {
    const before = await tx.smsNetwork.findUnique({ where: { id }, include: networkInclude });
    if (!before) throw AppError.notFound('Network');
    const country = await validateNetwork(
      tx,
      { countryCode: data.countryCode ?? before.countryCode, prefixes: data.prefixes ?? stringList(before.prefixes), isActive: data.isActive ?? before.isActive },
      id,
    );
    await tx.smsNetwork.update({ where: { id }, data: { ...data, countryName: country.name, ...(nationalNumberLengths ? { nationalNumberLengths } : {}) } });
    if (providerIds) await setNetworkProviders(tx, id, providerIds);
    const row = await tx.smsNetwork.findUniqueOrThrow({ where: { id }, include: networkInclude });
    await audit({ actor, action: 'ROUTING_NETWORK_UPDATED', resource: 'sms_network', resourceId: id, metadata: { before: serializeNetwork(before), after: serializeNetwork(row) }, meta }, tx);
    return row;
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

/** Route status for the admin overview. */
function routeStatus(plan: RoutePlan) {
  if (plan.selected) return 'CONFIGURED' as const;
  const serving = plan.candidates.filter((c) => !c.reasonCodes.includes('UNSUPPORTED_DESTINATION'));
  if (!serving.length) return 'UNSUPPORTED' as const;
  const down = serving.every((c) => c.reasonCodes.some((r) => r === 'PROVIDER_INACTIVE' || r === 'PROVIDER_DOWN' || r === 'NO_ADAPTER'));
  return down ? ('PROVIDER_UNAVAILABLE' as const) : ('NO_ELIGIBLE_PROVIDER' as const);
}

/**
 * How messages route right now, for configured destinations only: every active network of every
 * active country, plus "other numbers" of a country when a provider serves the whole country.
 */
export async function routingOverview() {
  const ctx = await loadRoutingContext(prisma);
  const capacity = new Map(ctx.providers.map((p) => [p.id, p.capacityBalance]));
  const rows: { label: string; dest: Destination; country: string }[] = [];
  for (const c of ctx.countries.filter((x) => x.isActive)) {
    const networks = ctx.networks.filter((n) => n.countryCode === c.isoCode);
    for (const n of networks) rows.push({ label: `${c.name} / ${n.name}`, dest: { network: n, countryCode: c.isoCode }, country: c.isoCode });
    const countryWide = ctx.providers.some((p) => p.countryIds.includes(c.id));
    if (countryWide || !networks.length) rows.push({ label: networks.length ? `${c.name} / other numbers` : c.name, dest: { network: null, countryCode: c.isoCode }, country: c.isoCode });
  }
  return rows.map(({ label, dest, country }) => {
    const plan = planRoute(ctx, dest, 1, capacity);
    return {
      destination: label,
      countryCode: country,
      networkId: dest.network?.id ?? null,
      rule: plan.rule ? { id: plan.rule.id, name: plan.rule.name, strategy: plan.rule.strategy } : null,
      strategy: plan.strategy,
      status: routeStatus(plan),
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
