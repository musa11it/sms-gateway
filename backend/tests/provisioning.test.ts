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

  it('walks an organization through every onboarding stage on its behalf, up to approved', async () => {
    const created = await request(app).post('/api/v1/admin/organizations').set(bearer(admin.token)).send({ name: 'Wizard Co', owner: owner(10) }).expect(201);
    const id = created.body.data.organization.id as string;
    const url = (suffix: string) => `/api/v1/admin/organizations/${id}${suffix}`;

    // The customer's own requirements (dynamic, set by the platform) are what the admin sees.
    const overview = (await request(app).get(url('/verification')).set(bearer(admin.token)).expect(200)).body.data;
    expect(overview.requirements.length).toBeGreaterThan(0);
    expect(overview.missingFields.length).toBeGreaterThan(0);
    expect(overview.missingDocuments.length).toBeGreaterThan(0);

    // Not complete → cannot submit or approve, and the response says what is missing.
    const early = await request(app).post(url('/finalize')).set(bearer(admin.token)).send({ outcome: 'APPROVE' });
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('VERIFICATION_INCOMPLETE');
    expect((await prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT');

    // Fill the organization details and provide every required item.
    await request(app)
      .patch(url(''))
      .set(bearer(admin.token))
      .send({ businessType: 'Retail / E-commerce', country: 'Rwanda', address: 'KN 4 Ave', registrationNumber: 'RDB-1', contactPersonName: 'Owner Ten', contactPersonPhone: '0788555110', smsPurpose: 'Order updates' })
      .expect(200);
    for (const type of overview.missingDocuments.map((d: { type: string }) => d.type)) {
      await request(app).post(url('/documents')).set(bearer(admin.token)).field('documentType', type).attach('file', Buffer.from('%PDF-1.4 admin'), { filename: 'doc.pdf', contentType: 'application/pdf' }).expect(201);
    }
    const ready = (await request(app).get(url('/verification')).set(bearer(admin.token)).expect(200)).body.data;
    expect(ready.canSubmit).toBe(true);

    // Save as draft changes nothing; approve completes every stage.
    await request(app).post(url('/finalize')).set(bearer(admin.token)).send({ outcome: 'SAVE_DRAFT' }).expect(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT');
    await request(app).post(url('/finalize')).set(bearer(admin.token)).send({ outcome: 'APPROVE', note: 'Verified in person' }).expect(200);

    const org = await prisma.organization.findUniqueOrThrow({ where: { id }, include: { verifications: { include: { reviews: true, documents: true } } } });
    expect(org.status).toBe('ACTIVE');
    expect(org.verifications[0].status).toBe('APPROVED');
    expect(org.verifications[0].documents.every((d) => d.status === 'APPROVED')).toBe(true);
    expect(org.verifications[0].reviews.map((r) => r.action)).toContain('APPROVE');
    expect(await prisma.auditLog.count({ where: { organizationId: id, action: 'BUSINESS_APPROVED' } })).toBe(1);
    // Approved verifications are locked, exactly as for a customer.
    await request(app).post(url('/documents')).set(bearer(admin.token)).field('documentType', 'OTHER').attach('file', Buffer.from('%PDF-1.4 late'), { filename: 'late.pdf', contentType: 'application/pdf' }).expect(409);
  });

  it('can submit for review instead of approving, leaving the decision to staff', async () => {
    const created = await request(app).post('/api/v1/admin/organizations').set(bearer(admin.token)).send({ name: 'Review Later Co', owner: owner(11) }).expect(201);
    const id = created.body.data.organization.id as string;
    const url = (suffix: string) => `/api/v1/admin/organizations/${id}${suffix}`;
    const missing = (await request(app).get(url('/verification')).set(bearer(admin.token))).body.data.missingDocuments as { type: string }[];
    await request(app).patch(url('')).set(bearer(admin.token)).send({ businessType: 'Education', country: 'Rwanda', address: 'KG 1', registrationNumber: 'R-2', contactPersonName: 'Owner', contactPersonPhone: '0788555111', smsPurpose: 'Alerts' }).expect(200);
    for (const d of missing) await request(app).post(url('/documents')).set(bearer(admin.token)).field('documentType', d.type).attach('file', Buffer.from('%PDF-1.4 x'), { filename: 'a.pdf', contentType: 'application/pdf' }).expect(201);
    await request(app).post(url('/finalize')).set(bearer(admin.token)).send({ outcome: 'SUBMIT' }).expect(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_REVIEW');
  });

  it('lets staff mark a required file as already on file, instead of uploading it', async () => {
    const created = await request(app).post('/api/v1/admin/organizations').set(bearer(admin.token)).send({ name: 'On File Co', owner: owner(12) }).expect(201);
    const id = created.body.data.organization.id as string;
    const url = (suffix: string) => `/api/v1/admin/organizations/${id}${suffix}`;
    await request(app).patch(url('')).set(bearer(admin.token)).send({ businessType: 'Education', country: 'Rwanda', address: 'KG 9', registrationNumber: 'R-9', contactPersonName: 'Owner', contactPersonPhone: '0788555112', smsPurpose: 'Alerts' }).expect(200);

    const required = ((await request(app).get(url('/verification')).set(bearer(admin.token))).body.data.missingDocuments as { type: string }[]).map((d) => d.type);
    for (const type of required) await request(app).post(url('/documents/on-file')).set(bearer(admin.token)).send({ documentType: type, note: 'Seen in person' }).expect(201);

    const overview = (await request(app).get(url('/verification')).set(bearer(admin.token)).expect(200)).body.data;
    expect(overview.canSubmit).toBe(true);
    const marker = overview.documents.find((d: { documentType: string }) => d.documentType === required[0]);
    expect(marker).toMatchObject({ onFile: true, status: 'APPROVED', value: 'On file — Seen in person' });

    // Re-marking edits the note instead of piling up records; switching it off removes the record.
    await request(app).post(url('/documents/on-file')).set(bearer(admin.token)).send({ documentType: required[0] }).expect(201);
    const after = (await request(app).get(url('/verification')).set(bearer(admin.token))).body.data;
    expect(after.documents.filter((d: { documentType: string }) => d.documentType === required[0])).toHaveLength(1);
    await request(app).delete(url(`/documents/${marker.id}`)).set(bearer(admin.token)).expect(404); // old record was replaced
    const current = after.documents.find((d: { documentType: string }) => d.documentType === required[0]);
    await request(app).delete(url(`/documents/${current.id}`)).set(bearer(admin.token)).expect(200);
    expect((await request(app).get(url('/verification')).set(bearer(admin.token))).body.data.missingDocuments.length).toBe(1);
    await request(app).post(url('/documents/on-file')).set(bearer(admin.token)).send({ documentType: required[0] }).expect(201);

    // Nothing is stored or downloadable, and the whole journey still reaches approved.
    expect(await prisma.verificationDocument.count({ where: { organizationId: id, storageKey: { not: null } } })).toBe(0);
    await request(app).post(url('/finalize')).set(bearer(admin.token)).send({ outcome: 'APPROVE' }).expect(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
    expect(await prisma.auditLog.count({ where: { organizationId: id, action: 'DOCUMENT_MARKED_ON_FILE' } })).toBe(required.length + 2);
  });

  it('only file items can be marked as on file', async () => {
    const created = await request(app).post('/api/v1/admin/organizations').set(bearer(admin.token)).send({ name: 'Kinds Org Co', owner: owner(13) }).expect(201);
    const id = created.body.data.organization.id as string;
    const settings = await request(app).put('/api/v1/admin/settings/verification.requiredDocuments').set(bearer(admin.token)).send({ value: [{ type: 'WEBSITE', label: 'Website', required: true, kind: 'URL' }, { type: 'CERT', label: 'Certificate', required: true, kind: 'FILE' }] });
    expect(settings.status).toBe(200);
    await request(app).post(`/api/v1/admin/organizations/${id}/documents/on-file`).set(bearer(admin.token)).send({ documentType: 'WEBSITE' }).expect(422);
    await request(app).post(`/api/v1/admin/organizations/${id}/documents/on-file`).set(bearer(admin.token)).send({ documentType: 'CERT' }).expect(201);
  });
});
