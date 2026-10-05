import crypto from 'crypto';
import net from 'net';
import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { hmacSha256, safeEqual } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { stringList } from '../../utils/json';
import { audit } from '../audit-logs/audit.service';
import { notifyOrganization } from '../notifications/notification.service';

/**
 * API key format:  sgw_live_<prefix 12 hex>_<secret 40 base62>
 * - prefix: public, unique, used for lookup (indexed)
 * - secret: shown once; only HMAC-SHA256(API_KEY_PEPPER, secret) is stored
 */
const KEY_RE = /^sgw_live_([0-9a-f]{12})_([A-Za-z0-9]{40})$/;
export const API_SCOPES = ['sms.send', 'sms.read', 'balance.read'] as const;

function base62(len: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(len * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < len; i++) {
    if (bytes[i] < 248) out += alphabet[bytes[i] % 62];
  }
  return out.length === len ? out : base62(len);
}

function hashSecret(secret: string) {
  return hmacSha256(env.API_KEY_PEPPER, secret);
}

export function serializeApiKey(k: {
  id: string; name: string; prefix: string; lastFour: string; scopes: Prisma.JsonValue; allowedIps: Prisma.JsonValue; lastUsedAt: Date | null; lastUsedIp: string | null;
  usageCount: number; expiresAt: Date | null; revokedAt: Date | null; createdAt: Date; createdBy?: { fullName: string } | null;
  environment: string; isEnabled: boolean; rateLimitPerMinute: number | null;
}) {
  return {
    id: k.id,
    name: k.name,
    maskedKey: `sgw_live_${k.prefix}_••••••••${k.lastFour}`,
    prefix: k.prefix,
    scopes: stringList(k.scopes),
    allowedIps: stringList(k.allowedIps),
    lastUsedAt: k.lastUsedAt,
    lastUsedIp: k.lastUsedIp,
    usageCount: k.usageCount,
    expiresAt: k.expiresAt,
    revokedAt: k.revokedAt,
    environment: k.environment,
    isEnabled: k.isEnabled,
    rateLimitPerMinute: k.rateLimitPerMinute,
    status: k.revokedAt ? 'REVOKED' : k.expiresAt && k.expiresAt < new Date() ? 'EXPIRED' : !k.isEnabled ? 'DISABLED' : 'ACTIVE',
    createdAt: k.createdAt,
    createdBy: k.createdBy?.fullName ?? null,
  };
}

export async function createApiKey(
  organizationId: string,
  input: { name: string; scopes?: string[]; allowedIps?: string[]; expiresAt?: Date | null; environment?: string; rateLimitPerMinute?: number | null },
  actor: Actor,
  meta?: RequestMeta,
) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  if (org.status !== 'ACTIVE') throw AppError.forbidden('Your organization must be approved to create API keys', 'ORGANIZATION_NOT_APPROVED');
  for (const ip of input.allowedIps ?? []) {
    if (!net.isIP(ip)) throw AppError.unprocessable(`"${ip}" is not a valid IP address`, 'INVALID_IP', [{ field: 'allowedIps', message: 'Invalid IP address' }]);
  }
  const prefix = crypto.randomBytes(6).toString('hex');
  const secret = base62(40);
  const key = await prisma.apiKey.create({
    data: {
      organizationId,
      name: input.name,
      prefix,
      keyHash: hashSecret(secret),
      lastFour: secret.slice(-4),
      scopes: input.scopes?.length ? input.scopes : ['sms.send', 'sms.read', 'balance.read'],
      allowedIps: input.allowedIps ?? [],
      expiresAt: input.expiresAt ?? null,
      environment: input.environment ?? 'production',
      rateLimitPerMinute: input.rateLimitPerMinute ?? null,
      createdById: actorUserId(actor)!,
    },
    include: { createdBy: { select: { fullName: true } } },
  });
  await audit({ actor, action: 'API_KEY_CREATED', resource: 'api_key', resourceId: key.id, organizationId, metadata: { name: key.name, prefix, scopes: key.scopes }, meta });
  await notifyOrganization(organizationId, { type: 'API_KEY_CREATED', title: 'New API key created', body: `API key "${key.name}" (sgw_live_${prefix}_…) was created.`, link: '/app/developer/api-keys' }, 'api_keys.view');
  return { apiKey: serializeApiKey(key), secret: `sgw_live_${prefix}_${secret}` };
}

export async function revokeApiKey(organizationId: string | null, id: string, actor: Actor, meta?: RequestMeta) {
  const key = await prisma.apiKey.findFirst({ where: { id, ...(organizationId ? { organizationId } : {}) } });
  if (!key) throw AppError.notFound('API key');
  if (key.revokedAt) throw AppError.conflict('API key is already revoked', 'ALREADY_REVOKED');
  await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date(), revokedById: actorUserId(actor) } });
  await audit({ actor, action: 'API_KEY_REVOKED', resource: 'api_key', resourceId: id, organizationId: key.organizationId, metadata: { name: key.name, prefix: key.prefix }, meta });
}

/** Revoke and issue a replacement with the same name/scopes/IP allow-list. */
export async function regenerateApiKey(organizationId: string, id: string, actor: Actor, meta?: RequestMeta) {
  const key = await prisma.apiKey.findFirst({ where: { id, organizationId } });
  if (!key) throw AppError.notFound('API key');
  if (!key.revokedAt) await revokeApiKey(organizationId, id, actor, meta);
  return createApiKey(
    organizationId,
    { name: key.name, scopes: stringList(key.scopes), allowedIps: stringList(key.allowedIps), expiresAt: key.expiresAt, environment: key.environment, rateLimitPerMinute: key.rateLimitPerMinute },
    actor,
    meta,
  );
}

/** Temporarily disable (or re-enable) a key without destroying it. */
export async function setApiKeyEnabled(organizationId: string | null, id: string, enabled: boolean, actor: Actor, meta?: RequestMeta) {
  const key = await prisma.apiKey.findFirst({ where: { id, ...(organizationId ? { organizationId } : {}) } });
  if (!key) throw AppError.notFound('API key');
  if (key.revokedAt) throw AppError.conflict('Revoked keys cannot be re-enabled', 'ALREADY_REVOKED');
  await prisma.apiKey.update({ where: { id }, data: { isEnabled: enabled } });
  await audit({ actor, action: enabled ? 'API_KEY_ENABLED' : 'API_KEY_DISABLED', resource: 'api_key', resourceId: id, organizationId: key.organizationId, metadata: { name: key.name }, meta });
}

export type AuthenticatedKey = { id: string; organizationId: string; prefix: string; scopes: string[]; rateLimitPerMinute: number | null };

export async function authenticateApiKey(raw: string | undefined, ip: string | undefined): Promise<AuthenticatedKey> {
  const match = raw ? KEY_RE.exec(raw.trim()) : null;
  if (!match) throw AppError.unauthorized('Missing or malformed API key', 'INVALID_API_KEY');
  const [, prefix, secret] = match;
  const key = await prisma.apiKey.findUnique({ where: { prefix } });
  // Compare even when the key is missing so timing does not reveal valid prefixes.
  const valid = safeEqual(hashSecret(secret), key?.keyHash ?? '0'.repeat(64));
  if (!key || !valid) throw AppError.unauthorized('Invalid API key', 'INVALID_API_KEY');
  if (key.revokedAt) throw AppError.unauthorized('This API key has been revoked', 'API_KEY_REVOKED');
  if (key.expiresAt && key.expiresAt < new Date()) throw AppError.unauthorized('This API key has expired', 'API_KEY_EXPIRED');
  if (!key.isEnabled) throw AppError.forbidden('This API key is disabled', 'API_KEY_DISABLED');
  const allowedIps = stringList(key.allowedIps);
  if (allowedIps.length && (!ip || !allowedIps.includes(ip.replace(/^::ffff:/, '')))) {
    throw AppError.forbidden('Requests from this IP address are not allowed for this key', 'IP_NOT_ALLOWED');
  }
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date(), lastUsedIp: ip, usageCount: { increment: 1 } } });
  return { id: key.id, organizationId: key.organizationId, prefix: key.prefix, scopes: stringList(key.scopes), rateLimitPerMinute: key.rateLimitPerMinute };
}
