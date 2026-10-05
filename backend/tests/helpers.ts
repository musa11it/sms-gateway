import { Prisma } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { hashPassword } from '../src/modules/auth/password';
import { PERMISSIONS, SYSTEM_ROLES, resolveRolePermissions } from '../src/modules/permissions/catalog';
import { invalidateSettingsCache } from '../src/modules/settings/settings.service';
import { applyLedgerEntry } from '../src/modules/wallet/wallet.service';
import { purchaseCapacity } from '../src/modules/providers/provider.service';
import { SYSTEM_ACTOR } from '../src/types/actor';

export const app = createApp();
export const PASSWORD = 'Password123!';

/** Wipe every table (TRUNCATE bypasses the append-only row triggers) and re-create RBAC + packages. */
export async function resetDatabase() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT TABLE_NAME AS tablename FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> '_prisma_migrations'`;
  // FOREIGN_KEY_CHECKS is per connection, so pin every statement to one connection.
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of tables) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${t.tablename}\``);
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
    },
    { timeout: 120_000 },
  );
  invalidateSettingsCache();

  for (const p of PERMISSIONS) {
    await prisma.permission.createMany({ data: p.scopes.map((scope) => ({ key: p.key, scope, group: p.group, description: p.description })) });
  }
  for (const def of SYSTEM_ROLES) {
    const perms = await prisma.permission.findMany({ where: { scope: def.scope, key: { in: resolveRolePermissions(def) } } });
    await prisma.role.create({
      data: { code: def.code, name: def.name, scope: def.scope, isSystem: true, permissions: { create: perms.map((p) => ({ permissionId: p.id })) } },
    });
  }
  await prisma.smsPackage.create({ data: { name: 'Starter', credits: 1000, price: new Prisma.Decimal('15000'), currency: 'RWF' } });
  await createProviders();
}

/** Networks RW-MTN (+25078/+25079) and RW-AIRTEL (+25072/+25073). */
export async function createNetworks() {
  const mtn = await prisma.smsNetwork.create({ data: { code: 'RW-MTN', name: 'MTN Rwanda', countryCode: 'RW', countryName: 'Rwanda', prefixes: ['+25078', '+25079'] } });
  const airtel = await prisma.smsNetwork.create({ data: { code: 'RW-AIRTEL', name: 'Airtel Rwanda', countryCode: 'RW', countryName: 'Rwanda', prefixes: ['+25072', '+25073'] } });
  return { mtn: mtn.id, airtel: airtel.id };
}

/** MTN (serves MTN Rwanda), Airtel (serves Airtel Rwanda) and a catch-all aggregator, each funded through the real purchase flow. */
export async function createProviders(capacity = 100_000) {
  const networks = await createNetworks();
  const defs = [
    { code: 'MTN', name: 'MTN Rwanda', type: 'MNO' as const, costPerSms: '8', networkIds: [networks.mtn], servesAllDestinations: false, priority: 10 },
    { code: 'AIRTEL', name: 'Airtel Rwanda', type: 'MNO' as const, costPerSms: '8.5', networkIds: [networks.airtel], servesAllDestinations: false, priority: 10 },
    { code: 'GENERIC', name: 'Aggregator', type: 'AGGREGATOR' as const, costPerSms: '11', networkIds: [], servesAllDestinations: true, priority: 100 },
  ];
  const out: Record<string, string> = {};
  for (const { networkIds, ...d } of defs) {
    const p = await prisma.smsProvider.create({
      data: { ...d, routePrefixes: [], costPerSms: new Prisma.Decimal(d.costPerSms), mode: 'SIMULATION', status: 'ACTIVE', currency: 'RWF', networks: { create: networkIds.map((networkId) => ({ networkId })) } },
    });
    if (capacity > 0) await purchaseCapacity(p.id, { quantity: capacity }, SYSTEM_ACTOR);
    out[d.code] = p.id;
  }
  return out;
}

let counter = 0;
const uniq = () => `${Date.now()}${++counter}`;

export async function createStaff(roleCode: string) {
  const role = await prisma.role.findFirstOrThrow({ where: { code: roleCode, scope: 'PLATFORM' } });
  const user = await prisma.user.create({
    data: {
      email: `${roleCode.toLowerCase()}${uniq()}@test.local`,
      fullName: roleCode,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });
  return { user, token: await login(user.email) };
}

/** An approved organization with an owner, a wallet (optionally funded) and an approved sender. */
export async function createActiveOrg(opts: { credits?: number; roleCode?: string; senderStatus?: 'APPROVED' | 'PENDING' } = {}) {
  const role = await prisma.role.findFirstOrThrow({ where: { code: opts.roleCode ?? 'CUSTOMER_OWNER', scope: 'ORGANIZATION' } });
  const user = await prisma.user.create({
    data: { email: `owner${uniq()}@test.local`, fullName: 'Owner', passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  const org = await prisma.organization.create({
    data: {
      name: `Org ${uniq()}`,
      slug: `org-${uniq()}`,
      status: 'ACTIVE',
      approvedAt: new Date(),
      members: { create: { userId: user.id, roleId: role.id, isOwner: (opts.roleCode ?? 'CUSTOMER_OWNER') === 'CUSTOMER_OWNER' } },
      wallet: { create: { balance: 0, lowBalanceThreshold: 0 } },
    },
  });
  if (opts.credits) {
    await prisma.$transaction((tx) =>
      applyLedgerEntry(tx, { organizationId: org.id, type: 'ADMIN_CREDIT', amount: opts.credits!, reference: `test:${uniq()}`, description: 'Test credit' }),
    );
  }
  const sender = await prisma.senderId.create({
    data: { organizationId: org.id, name: `SND${String(counter).slice(-5)}`, purpose: 'Testing purposes', status: opts.senderStatus ?? 'APPROVED', requestedById: user.id },
  });
  return { user, org, sender, token: await login(user.email) };
}

export async function addMember(organizationId: string, roleCode: string) {
  const role = await prisma.role.findFirstOrThrow({ where: { code: roleCode, scope: 'ORGANIZATION' } });
  const user = await prisma.user.create({
    data: { email: `member${uniq()}@test.local`, fullName: 'Member', passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  await prisma.organizationMember.create({ data: { organizationId, userId: user.id, roleId: role.id } });
  return { user, token: await login(user.email) };
}

export async function login(email: string, password = PASSWORD) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}

export const balanceOf = async (organizationId: string) => (await prisma.wallet.findUniqueOrThrow({ where: { organizationId } })).balance;
