/**
 * Idempotent development seed.
 *
 *   npm run prisma:seed
 *
 * - Permission catalog + system roles (role permissions are only set when a role is first
 *   created, so Super Admin customisations survive re-seeding).
 * - Staff accounts and a demo customer organization (clearly named "(Demo)").
 * - Demo SMS traffic is created through the real SMS service and delivered by the
 *   simulation provider once the API is running — nothing is fabricated.
 *
 * Development password for every seeded account: Password123!
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { GRANT_MIGRATIONS, PERMISSIONS, SYSTEM_ROLES, resolveRolePermissions } from '../src/modules/permissions/catalog';
import { SETTING_DEFAULTS, SETTING_DESCRIPTIONS, type SettingKey } from '../src/modules/settings/settings.service';

const prisma = new PrismaClient();
export const DEV_PASSWORD = 'Password123!';

async function seedSettings() {
  for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
    await prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: SETTING_DEFAULTS[key] as Prisma.InputJsonValue, description: SETTING_DESCRIPTIONS[key] },
      update: {},
    });
  }
}

async function seedRbac() {
  for (const p of PERMISSIONS) {
    for (const scope of p.scopes) {
      await prisma.permission.upsert({
        where: { key_scope: { key: p.key, scope } },
        create: { key: p.key, scope, group: p.group, description: p.description },
        update: { group: p.group, description: p.description },
      });
    }
  }
  const roles: Record<string, string> = {};
  for (const def of SYSTEM_ROLES) {
    let role = await prisma.role.findFirst({ where: { scope: def.scope, code: def.code, organizationId: null } });
    if (!role) {
      const perms = await prisma.permission.findMany({ where: { scope: def.scope, key: { in: resolveRolePermissions(def) } } });
      role = await prisma.role.create({
        data: {
          code: def.code,
          name: def.name,
          description: def.description,
          scope: def.scope,
          isSystem: true,
          permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
        },
      });
      console.log(`  + role ${def.code} (${perms.length} permissions)`);
    } else {
      await prisma.role.update({ where: { id: role.id }, data: { name: def.name, description: def.description, isSystem: true } });
    }
    roles[def.code] = role.id;
  }
  // Versioned grants for roles that already existed (never removes customisations).
  const versionRow = await prisma.systemSetting.findUnique({ where: { key: 'rbac.catalogVersion' } });
  const current = Number(versionRow?.value ?? 1);
  for (const m of GRANT_MIGRATIONS.filter((g) => g.version > current)) {
    for (const [code, keys] of Object.entries(m.grants)) {
      const def = SYSTEM_ROLES.find((r) => r.code === code)!;
      const perms = await prisma.permission.findMany({ where: { scope: def.scope, key: { in: keys } } });
      await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: roles[code], permissionId: p.id })), skipDuplicates: true });
    }
    console.log(`  + applied RBAC grant migration v${m.version}`);
  }
  const latest = Math.max(1, ...GRANT_MIGRATIONS.map((g) => g.version));
  await prisma.systemSetting.upsert({
    where: { key: 'rbac.catalogVersion' },
    create: { key: 'rbac.catalogVersion', value: latest, description: 'Internal: last applied RBAC grant migration' },
    update: { value: latest },
  });

  // Full-access roles always receive newly added catalog permissions.
  for (const code of ['SUPER_ADMIN', 'CUSTOMER_OWNER']) {
    const def = SYSTEM_ROLES.find((r) => r.code === code)!;
    const perms = await prisma.permission.findMany({ where: { scope: def.scope } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: roles[code], permissionId: p.id })), skipDuplicates: true });
  }
  return roles;
}

async function upsertUser(email: string, fullName: string, passwordHash: string, phone?: string) {
  return prisma.user.upsert({
    where: { email },
    create: { email, fullName, passwordHash, phone, status: 'ACTIVE', emailVerifiedAt: new Date() },
    update: {},
  });
}

async function seedStaff(roles: Record<string, string>, passwordHash: string) {
  const staff = [
    ['superadmin@example.com', 'Sarah Super', 'SUPER_ADMIN'],
    ['admin@example.com', 'Adam Admin', 'ADMIN'],
    ['support@example.com', 'Sam Support', 'SUPPORT'],
    ['finance@example.com', 'Fiona Finance', 'FINANCE'],
    ['operator@example.com', 'Oscar Operator', 'SMS_OPERATOR'],
  ] as const;
  for (const [email, name, role] of staff) {
    const user = await upsertUser(email, name, passwordHash);
    await prisma.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId: roles[role] } }, create: { userId: user.id, roleId: roles[role] }, update: {} });
  }
}

async function seedPackages() {
  const packages = [
    { name: 'Starter', credits: 1_000, price: '15000', description: 'Try it out — perfect for small shops', sortOrder: 1 },
    { name: 'Growth', credits: 5_000, price: '70000', description: 'For growing businesses', sortOrder: 2 },
    { name: 'Business', credits: 10_000, price: '130000', description: 'Best value for regular campaigns', sortOrder: 3, isPopular: true },
    { name: 'Pro', credits: 50_000, price: '600000', description: 'High-volume messaging', sortOrder: 4 },
    { name: 'Enterprise', credits: 100_000, price: '1100000', description: 'Lowest price per SMS', sortOrder: 5 },
  ];
  for (const p of packages) {
    const existing = await prisma.smsPackage.findFirst({ where: { name: p.name } });
    if (!existing) await prisma.smsPackage.create({ data: { ...p, price: new Prisma.Decimal(p.price), currency: 'RWF', validityDays: 365 } });
  }
}

/** Default volume tiers for any-quantity purchases (only when no tier exists yet; Super Admin edits them afterwards). */
async function seedPricingTiers() {
  if ((await prisma.smsPricingTier.count()) > 0) return;
  const tiers = [
    { name: 'Starter', minQuantity: 1, maxQuantity: 1_000, unitPrice: '13' },
    { name: 'Growth', minQuantity: 1_001, maxQuantity: 5_000, unitPrice: '11' },
    { name: 'Business', minQuantity: 5_001, maxQuantity: 10_000, unitPrice: '9' },
    { name: 'Volume', minQuantity: 10_001, maxQuantity: null, unitPrice: '8' },
  ];
  await prisma.smsPricingTier.createMany({ data: tiers.map((t, i) => ({ ...t, unitPrice: new Prisma.Decimal(t.unitPrice), currency: 'RWF', sortOrder: i + 1 })) });
  console.log(`  + ${tiers.length} pricing tiers`);
}

/**
 * Upstream providers. Starting capacity is bought through the real purchase service (which
 * calls the simulated provider), so it appears as genuine provider spend in finance reports.
 */
async function seedProviders(superAdminId: string) {
  // Destination networks (Super Admin manages these and which providers serve them).
  const networks: Record<string, string> = {};
  for (const n of [
    { code: 'RW-MTN', name: 'MTN Rwanda', prefixes: ['+25078', '+25079'] },
    { code: 'RW-AIRTEL', name: 'Airtel Rwanda', prefixes: ['+25072', '+25073'] },
  ]) {
    const row = await prisma.smsNetwork.upsert({ where: { code: n.code }, create: { ...n, countryCode: 'RW', countryName: 'Rwanda' }, update: {} });
    networks[n.code] = row.id;
  }
  const defs = [
    { code: 'MTN', name: 'MTN Rwanda', type: 'MNO' as const, costPerSms: '8.0000', networks: ['RW-MTN'], servesAll: false, priority: 10, initial: 100_000, notes: 'Direct connection for MTN subscribers.' },
    { code: 'AIRTEL', name: 'Airtel Rwanda', type: 'MNO' as const, costPerSms: '8.5000', networks: ['RW-AIRTEL'], servesAll: false, priority: 10, initial: 50_000, notes: 'Direct connection for Airtel subscribers.' },
    { code: 'GENERIC', name: 'Global Aggregator', type: 'AGGREGATOR' as const, costPerSms: '11.0000', networks: [], servesAll: true, priority: 100, initial: 20_000, notes: 'Catch-all route for other networks and international numbers.' },
  ];
  const { purchaseCapacity } = await import('../src/modules/providers/provider.service');
  for (const d of defs) {
    const p = await prisma.smsProvider.upsert({
      where: { code: d.code },
      create: {
        code: d.code,
        name: d.name,
        type: d.type,
        mode: 'SIMULATION',
        status: 'ACTIVE',
        currency: 'RWF',
        costPerSms: new Prisma.Decimal(d.costPerSms),
        routePrefixes: [],
        servesAllDestinations: d.servesAll,
        networks: { create: d.networks.map((code) => ({ networkId: networks[code] })) },
        priority: d.priority,
        notes: d.notes,
        lowCapacityThreshold: 10_000,
      },
      update: {},
    });
    if (p.totalPurchased === 0) {
      const r = await purchaseCapacity(p.id, { quantity: d.initial, notes: 'Initial capacity (development seed)' }, { type: 'USER', userId: superAdminId, email: 'superadmin@example.com' });
      console.log(`  + ${d.name}: purchased ${d.initial.toLocaleString()} SMS (${r.reference}, ${r.status})`);
    }
  }
}

async function seedDemoOrganization(roles: Record<string, string>, passwordHash: string) {
  const owner = await upsertUser('customer@example.com', 'Claire Customer', passwordHash, '+250788100200');
  const manager = await upsertUser('manager@example.com', 'Mike Manager', passwordHash);
  const staff = await upsertUser('staff@example.com', 'Stella Staff', passwordHash);

  let org = await prisma.organization.findUnique({ where: { slug: 'acme-retail-demo' } });
  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: 'Acme Retail Ltd (Demo)',
        slug: 'acme-retail-demo',
        status: 'ACTIVE',
        businessType: 'Retail / E-commerce',
        country: 'Rwanda',
        city: 'Kigali',
        address: 'KN 4 Ave, Kigali',
        registrationNumber: 'RDB-DEMO-000123',
        taxId: 'TIN-100200300',
        contactPersonName: 'Claire Customer',
        contactPersonPhone: '+250788100200',
        contactPersonEmail: 'customer@example.com',
        smsPurpose: 'Order notifications, delivery updates and occasional promotions to opted-in customers.',
        expectedMonthlyVolume: 20_000,
        approvedAt: new Date(),
        wallet: { create: { balance: 0, lowBalanceThreshold: 500 } },
        verifications: { create: { status: 'APPROVED', submittedAt: new Date(), reviewedAt: new Date(), reviewNote: 'Seeded demo organization (no documents on file).' } },
      },
    });
    console.log('  + demo organization');
  }
  const members: [string, string, boolean][] = [
    [owner.id, roles.CUSTOMER_OWNER, true],
    [manager.id, roles.CUSTOMER_MANAGER, false],
    [staff.id, roles.CUSTOMER_STAFF, false],
  ];
  for (const [userId, roleId, isOwner] of members) {
    await prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId } },
      create: { organizationId: org.id, userId, roleId, isOwner },
      update: {},
    });
  }

  // Sender IDs
  const senders = [
    { name: 'ACMESHOP', status: 'APPROVED' as const, purpose: 'Order confirmations and delivery notifications', approvedAt: new Date() },
    { name: 'ACME PROMO', status: 'PENDING' as const, purpose: 'Seasonal promotions for subscribers who opted in' },
  ];
  for (const s of senders) {
    await prisma.senderId.upsert({
      where: { organizationId_name: { organizationId: org.id, name: s.name } },
      create: { ...s, organizationId: org.id, requestedById: owner.id, sampleMessage: 'Hi {name}, your order #1234 is ready for pickup.' },
      update: {},
    });
  }

  // Starting credits: an explicit, clearly-labelled admin credit through the real ledger.
  // (Not a fake payment — so platform revenue reports only ever show real/simulated purchases.)
  const { applyLedgerEntry } = await import('../src/modules/wallet/wallet.service');
  const credited = await prisma.$transaction((tx) =>
    applyLedgerEntry(tx, {
      organizationId: org!.id,
      type: 'ADMIN_CREDIT',
      amount: 10_000,
      reference: 'seed:demo-starting-credits',
      description: 'Demo starting credits (development seed)',
      metadata: { seeded: true },
    }),
  );
  if (!credited.duplicate) console.log('  + demo starting credits (10,000)');

  // Contacts & groups
  const groupDefs = [
    ['Customers', '#4f46e5'],
    ['VIP', '#7c3aed'],
    ['Employees', '#059669'],
    ['Subscribers', '#d97706'],
  ] as const;
  const groups: Record<string, string> = {};
  for (const [name, color] of groupDefs) {
    const g = await prisma.contactGroup.upsert({
      where: { organizationId_name: { organizationId: org.id, name } },
      create: { organizationId: org.id, name, color, description: `${name} (demo)` },
      update: {},
    });
    groups[name] = g.id;
  }
  const contacts: [string, string, string[]][] = [
    ['Jean Uwimana', '+250788123456', ['Customers', 'VIP']],
    ['Alice Mukamana', '+250782123456', ['Customers']],
    ['Eric Niyonzima', '+250788234567', ['Customers', 'Subscribers']],
    ['Grace Ingabire', '+250783345678', ['VIP', 'Subscribers']],
    ['Patrick Habimana', '+250788456789', ['Employees']],
    ['Diane Uwase', '+250789567890', ['Employees']],
    ['Kevin Mugisha', '+250788678901', ['Customers']],
    ['Aline Umutoni', '+250782789012', ['Subscribers']],
    ['Olivier Nshuti', '+250788890123', ['Customers', 'VIP']],
    ['Sandrine Iradukunda', '+250783901234', ['Subscribers']],
    ['Test: fails delivery', '+250788119999', ['Customers']],
    ['Test: rejected number', '+250788110000', []],
  ];
  for (const [name, phone, gs] of contacts) {
    const c = await prisma.contact.upsert({
      where: { organizationId_phone: { organizationId: org.id, phone } },
      create: { organizationId: org.id, name, phone, tags: name.startsWith('Test') ? ['demo', 'test'] : ['demo'] },
      update: {},
    });
    if (gs.length) await prisma.contactGroupMember.createMany({ data: gs.map((g) => ({ groupId: groups[g], contactId: c.id })), skipDuplicates: true });
  }

  // Demo campaign draft
  const approved = await prisma.senderId.findFirstOrThrow({ where: { organizationId: org.id, name: 'ACMESHOP' } });
  const existingCampaign = await prisma.campaign.findFirst({ where: { organizationId: org.id, name: 'VIP weekend offer (demo)' } });
  if (!existingCampaign) {
    await prisma.campaign.create({
      data: {
        organizationId: org.id,
        name: 'VIP weekend offer (demo)',
        senderId: approved.id,
        message: 'Hi! As a VIP customer you get 20% off this weekend at Acme Retail. Show this SMS at checkout. Reply STOP to opt out.',
        createdById: owner.id,
        status: 'DRAFT',
        groups: { create: [{ groupId: groups.VIP }] },
      },
    });
  }
  return { org, owner };
}

/** Real demo traffic through the production code path (delivered by the simulator when the API runs). */
async function seedDemoTraffic(organizationId: string, ownerId: string) {
  const { sendSms } = await import('../src/modules/sms/sms.service');
  const sender = await prisma.senderId.findFirstOrThrow({ where: { organizationId, name: 'ACMESHOP' } });
  const result = await sendSms({
    organizationId,
    actor: { type: 'USER', userId: ownerId, email: 'customer@example.com' },
    senderId: sender.id,
    recipients: ['+250788123456', '+250782123456', '+250788234567', '+250788119999', '+250788110000'],
    message: 'Hello from Acme Retail (demo)! Your order #1042 is ready for pickup at KN 4 Ave. Thank you for shopping with us.',
    source: 'DASHBOARD',
    idempotencyKey: 'seed-demo-message-0001',
  });
  if (!result.duplicate) console.log('  + demo SMS queued (the simulator delivers it once the API is running)');
}

async function main() {
  console.log('Seeding…');
  const { hashPassword } = await import('../src/modules/auth/password');
  const passwordHash = await hashPassword(DEV_PASSWORD);
  await seedSettings();
  const roles = await seedRbac();
  await seedStaff(roles, passwordHash);
  await seedPackages();
  await seedPricingTiers();
  const superAdmin = await prisma.user.findUniqueOrThrow({ where: { email: 'superadmin@example.com' } });
  await seedProviders(superAdmin.id);
  const { org, owner } = await seedDemoOrganization(roles, passwordHash);
  await seedDemoTraffic(org.id, owner.id);
  console.log(`Done. Development password for all seeded accounts: ${DEV_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    const { prisma: appPrisma } = await import('../src/config/prisma');
    await appPrisma.$disconnect();
    const { queue } = await import('../src/workers/queue');
    await queue.close();
  });
