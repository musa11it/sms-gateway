import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { app, createActiveOrg, createStaff, resetDatabase } from './helpers';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const owner = (n: number) => ({ fullName: `Owner ${n}`, email: `owner${n}@new-org.test`, phone: `07885551${String(n).padStart(2, '0')}` });
const setupToken = async (email: string) => /token=([\w-]+)/.exec((await prisma.emailMessage.findFirstOrThrow({ where: { to: email }, orderBy: { createdAt: 'desc' } })).text)![1];

describe('admin creates organizations and gives access', () => {
  let admin: Awaited<ReturnType<typeof createStaff>>;

  beforeAll(async () => {
    await resetDatabase();
    admin = await createStaff('SUPER_ADMIN');
  });

  it('creates an organization with a new owner and a generated password shown once', async () => {
    const r = await request(app).post('/api/v1/admin/organizations').set(bearer(admin.token)).send({ name: 'Admin Made Co', country: 'Rwanda', owner: owner(1) });
    expect(r.status).toBe(201);
    expect(r.body.data.organization.status).toBe('DRAFT'); // owner still completes verification
    expect(r.body.data.owner.created).toBe(true);
    const password = r.body.data.owner.temporaryPassword as string;
    expect(password).toMatch(/^(?=.*[A-Za-z])(?=.*\d).{14}$/);

    // The generated password works immediately, and is never put in the email or the audit log.
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner1@new-org.test', password });
    expect(login.status).toBe(200);
    const mail = await prisma.emailMessage.findFirstOrThrow({ where: { to: 'owner1@new-org.test' } });
    expect(mail.text).not.toContain(password);
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(password);

    // The emailed link still lets them choose their own password instead.
    await request(app).post('/api/v1/auth/reset-password').send({ token: await setupToken('owner1@new-org.test'), password: 'BrandNew123' }).expect(200);
    await request(app).post('/api/v1/auth/login').send({ email: 'owner1@new-org.test', password }).expect(401);
  });

  it('can approve immediately, set API access, and records that verification was skipped', async () => {
    const r = await request(app)
      .post('/api/v1/admin/organizations')
      .set(bearer(admin.token))
      .send({ name: 'Instant Co', owner: owner(2), activate: true, apiAccess: { enabled: false, allowedScopes: null } })
      .expect(201);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: r.body.data.organization.id }, include: { verifications: { include: { reviews: true } }, wallet: true } });
    expect(org.status).toBe('ACTIVE');
    expect(org.apiAccessEnabled).toBe(false);
    expect(org.wallet).not.toBeNull();
    expect(org.verifications[0].status).toBe('APPROVED');
    expect(org.verifications[0].reviews[0].action).toBe('ADMIN_CREATED_APPROVED');
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'owner2@new-org.test' } })).status).toBe('ACTIVE');
  });

  it('reuses an existing account as owner without emailing a password link', async () => {
    const existing = await createActiveOrg();
    const before = await prisma.emailMessage.count();
    const r = await request(app).post('/api/v1/admin/organizations').set(bearer(admin.token)).send({ name: 'Second Org', owner: { fullName: 'Same Person', email: existing.user.email } }).expect(201);
    expect(r.body.data.owner.created).toBe(false);
    expect(r.body.data.owner.temporaryPassword).toBeNull(); // existing accounts keep their own password
    expect(await prisma.emailMessage.count()).toBe(before);
    expect(await prisma.organizationMember.count({ where: { userId: existing.user.id } })).toBe(2);
  });

  it('is permission-controlled', async () => {
    const support = await createStaff('SUPPORT');
    await request(app).post('/api/v1/admin/organizations').set(bearer(support.token)).send({ name: 'Nope Co', owner: owner(3) }).expect(403);
    expect(await prisma.organization.count({ where: { name: 'Nope Co' } })).toBe(0);
  });

  it('gives a person access to an existing organization with a chosen role', async () => {
    const o = await createActiveOrg();
    const roles = (await request(app).get(`/api/v1/admin/organizations/${o.org.id}/roles`).set(bearer(admin.token)).expect(200)).body.data as { id: string; name: string }[];
    expect(roles.some((x) => x.name === 'Owner')).toBe(false);
    const manager = roles.find((x) => x.name === 'Manager')!;

    const grant = (email: string, roleId: string) => request(app).post(`/api/v1/admin/organizations/${o.org.id}/members`).set(bearer(admin.token)).send({ person: { fullName: 'New Manager', email }, roleId });
    expect((await grant('manager@new-org.test', manager.id)).status).toBe(201);
    expect((await grant('manager@new-org.test', manager.id)).status).toBe(409); // already has access
    expect(await prisma.organizationMember.count({ where: { organizationId: o.org.id } })).toBe(2);

    const ownerRole = await prisma.role.findFirstOrThrow({ where: { code: 'CUSTOMER_OWNER', scope: 'ORGANIZATION' } });
    expect((await grant('x@new-org.test', ownerRole.id)).status).toBe(422);
  });
});
