import crypto from 'crypto';
import net from 'net';
import { prisma } from '../../config/prisma';
import { isProduction } from '../../config/env';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { safeEqual } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { stringList } from '../../utils/json';
import { audit } from '../audit-logs/audit.service';
import { hashPassword } from '../auth/password';
import { base62, hashSecret } from '../api-keys/apiKey.service';

/**
 * Credentials for trusted external systems, issued only by platform staff.
 * Format: sgw_int_<prefix 12 hex>_<secret 40 base62>. Only an HMAC of the secret is stored.
 */
const KEY_RE = /^sgw_int_([0-9a-f]{12})_([A-Za-z0-9]{40})$/;
import { PLATFORM_SCOPES, isHighRiskScope } from './scopes';

export const INTEGRATION_SCOPES = PLATFORM_SCOPES;
export type IntegrationScope = string;

type Row = NonNullable<Awaited<ReturnType<typeof prisma.integrationClient.findUnique>>>;

export function serializeIntegration(k: Row) {
  return {
    id: k.id,
    name: k.name,
    maskedKey: `sgw_int_${k.prefix}_••••••••${k.lastFour}`,
    prefix: k.prefix,
    scopes: stringList(k.scopes),
    allowedIps: stringList(k.allowedIps),
    expiresAt: k.expiresAt,
    lastUsedAt: k.lastUsedAt,
    lastUsedIp: k.lastUsedIp,
    usageCount: k.usageCount,
    revokedAt: k.revokedAt,
    status: k.revokedAt ? 'REVOKED' : k.expiresAt && k.expiresAt < new Date() ? 'EXPIRED' : !k.isEnabled ? 'DISABLED' : 'ACTIVE',
    createdAt: k.createdAt,
  };
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Every credential acts as its own non-interactive service account, so audit logs and ownership
 * columns work as they do for staff. The account has no usable password and no roles and cannot
 * sign in; the only permissions it ever has are the credential's scopes.
 */
async function createServiceUser(tx: Tx, name: string, prefix: string) {
  return tx.user.create({
    data: {
      email: `integration-${prefix}@service.local`,
      fullName: `[Integration] ${name}`.slice(0, 190),
      passwordHash: await hashPassword(crypto.randomBytes(48).toString('base64url')),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
}

export async function createIntegration(
  input: { name: string; scopes: IntegrationScope[]; allowedIps: string[]; expiresAt?: Date | null },
  actor: Actor,
  meta?: RequestMeta,
) {
  for (const ip of input.allowedIps) {
    if (!net.isIP(ip)) throw AppError.unprocessable(`"${ip}" is not a valid IP address`, 'INVALID_IP', [{ field: 'allowedIps', message: 'Invalid IP address' }]);
  }
  if (isProduction && input.allowedIps.length === 0) {
    throw AppError.unprocessable('Restrict this credential to at least one IP address', 'IP_ALLOWLIST_REQUIRED', [{ field: 'allowedIps', message: 'Required in production' }]);
  }
  const risky = input.scopes.filter(isHighRiskScope);
  if (risky.length && (input.allowedIps.length === 0 || !input.expiresAt)) {
    throw AppError.unprocessable(
      `These permissions move money or change access (${risky.join(', ')}). Restrict the credential to specific IP addresses and set an expiry date.`,
      'HIGH_RISK_REQUIRES_LIMITS',
      [{ field: input.allowedIps.length === 0 ? 'allowedIps' : 'expiresAt', message: 'Required for high-risk permissions' }],
    );
  }
  if (input.expiresAt && input.expiresAt <= new Date()) throw AppError.unprocessable('Expiry must be in the future', 'INVALID_EXPIRY', [{ field: 'expiresAt', message: 'Must be in the future' }]);

  const prefix = crypto.randomBytes(6).toString('hex');
  const secret = base62(40);
  const row = await prisma.$transaction(async (tx) => {
    const serviceUser = await createServiceUser(tx, input.name, prefix);
    return tx.integrationClient.create({
      data: {
        name: input.name,
        prefix,
        keyHash: hashSecret(secret),
        lastFour: secret.slice(-4),
        scopes: input.scopes,
        allowedIps: input.allowedIps,
        expiresAt: input.expiresAt ?? null,
        userId: serviceUser.id,
        createdById: actorUserId(actor)!,
      },
    });
  });
  await audit({ actor, action: 'INTEGRATION_CREATED', resource: 'integration_client', resourceId: row.id, metadata: { name: row.name, prefix, scopes: input.scopes, allowedIps: input.allowedIps }, meta });
  return { integration: serializeIntegration(row), secret: `sgw_int_${prefix}_${secret}` };
}

export async function setIntegrationEnabled(id: string, enabled: boolean, actor: Actor, meta?: RequestMeta) {
  const row = await prisma.integrationClient.findUnique({ where: { id } });
  if (!row) throw AppError.notFound('Integration');
  if (row.revokedAt) throw AppError.conflict('Revoked credentials cannot be re-enabled', 'ALREADY_REVOKED');
  await prisma.integrationClient.update({ where: { id }, data: { isEnabled: enabled } });
  await audit({ actor, action: enabled ? 'INTEGRATION_ENABLED' : 'INTEGRATION_DISABLED', resource: 'integration_client', resourceId: id, metadata: { name: row.name }, meta });
}

export async function revokeIntegration(id: string, actor: Actor, meta?: RequestMeta) {
  const row = await prisma.integrationClient.findUnique({ where: { id } });
  if (!row) throw AppError.notFound('Integration');
  if (row.revokedAt) throw AppError.conflict('Already revoked', 'ALREADY_REVOKED');
  await prisma.$transaction([
    prisma.integrationClient.update({ where: { id }, data: { revokedAt: new Date(), revokedById: actorUserId(actor) } }),
    ...(row.userId ? [prisma.user.update({ where: { id: row.userId }, data: { status: 'DEACTIVATED' } })] : []),
  ]);
  await audit({ actor, action: 'INTEGRATION_REVOKED', resource: 'integration_client', resourceId: id, metadata: { name: row.name }, meta });
}

/** The service account a credential acts as. Credentials created before accounts existed get one on first use. */
export async function serviceUserFor(client: { id: string; name: string; prefix: string; userId: string | null }) {
  if (client.userId) return prisma.user.findUniqueOrThrow({ where: { id: client.userId } });
  return prisma.$transaction(async (tx) => {
    const user = await createServiceUser(tx, client.name, client.prefix);
    await tx.integrationClient.update({ where: { id: client.id }, data: { userId: user.id } });
    return user;
  });
}

export async function authenticateIntegration(raw: string | undefined, ip: string | undefined) {
  const match = raw ? KEY_RE.exec(raw.trim()) : null;
  if (!match) throw AppError.unauthorized('Missing or malformed integration key', 'INVALID_INTEGRATION_KEY');
  const [, prefix, secret] = match;
  const row = await prisma.integrationClient.findUnique({ where: { prefix } });
  // Compare even when the key is missing so timing does not reveal valid prefixes.
  const valid = safeEqual(hashSecret(secret), row?.keyHash ?? '0'.repeat(64));
  if (!row || !valid) throw AppError.unauthorized('Invalid integration key', 'INVALID_INTEGRATION_KEY');
  if (row.revokedAt) throw AppError.unauthorized('This credential has been revoked', 'INTEGRATION_REVOKED');
  if (row.expiresAt && row.expiresAt < new Date()) throw AppError.unauthorized('This credential has expired', 'INTEGRATION_EXPIRED');
  if (!row.isEnabled) throw AppError.forbidden('This credential is disabled', 'INTEGRATION_DISABLED');
  const allowedIps = stringList(row.allowedIps);
  if (allowedIps.length && (!ip || !allowedIps.includes(ip.replace(/^::ffff:/, '')))) {
    throw AppError.forbidden('Requests from this IP address are not allowed for this credential', 'IP_NOT_ALLOWED');
  }
  await prisma.integrationClient.update({ where: { id: row.id }, data: { lastUsedAt: new Date(), lastUsedIp: ip, usageCount: { increment: 1 } } });
  return { id: row.id, name: row.name, prefix: row.prefix, scopes: stringList(row.scopes), userId: row.userId };
}
