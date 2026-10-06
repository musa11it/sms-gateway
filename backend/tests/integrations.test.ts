import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { app, createActiveOrg, createStaff, resetDatabase } from './helpers';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const BASE = '/api/v1/integrations/finance';

describe('finance system integration', () => {
  let superAdmin: Awaited<ReturnType<typeof createStaff>>;
  let verificationId: string;
  let documentId: string;

  beforeAll(async () => {
    await resetDatabase();
    superAdmin = await createStaff('SUPER_ADMIN');
    const org = await createActiveOrg();
    // A verification waiting for review, with one uploaded document.
    await prisma.verification.deleteMany({ where: { organizationId: org.org.id } });
    const v = await prisma.verification.create({ data: { organizationId: org.org.id, status: 'SUBMITTED', submittedAt: new Date() } });
    verificationId = v.id;
    const doc = await prisma.verificationDocument.create({
      data: { organizationId: org.org.id, verificationId: v.id, documentType: 'WEBSITE', originalName: 'https://example.com/', value: 'https://example.com/', uploadedById: org.user.id },
    });
    documentId = doc.id;
  });

  const issue = async (body: Record<string, unknown>) => {
    const r = await request(app).post('/api/v1/admin/integrations').set(bearer(superAdmin.token)).send({ name: 'Finance system', allowedIps: [], ...body });
    return r;
  };

  it('only a Super Admin can issue credentials, and the secret is shown once', async () => {
    const admin = await createStaff('ADMIN');
    await request(app).post('/api/v1/admin/integrations').set(bearer(admin.token)).send({ name: 'x', scopes: ['verification.view'] }).expect(403);

    const r = await issue({ scopes: ['verification.view'] });
    expect(r.status).toBe(201);
    expect(r.body.data.secret).toMatch(/^sgw_int_[0-9a-f]{12}_[A-Za-z0-9]{40}$/);
    const list = await request(app).get('/api/v1/admin/integrations').set(bearer(superAdmin.token)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(r.body.data.secret);
  });

  it('rejects missing, wrong and out-of-scope keys', async () => {
    await request(app).get(`${BASE}/verifications`).expect(401);
    await request(app).get(`${BASE}/verifications`).set(bearer('sgw_int_000000000000_' + 'a'.repeat(40))).expect(401);

    const readOnly = (await issue({ scopes: ['verification.view'] })).body.data.secret;
    await request(app).get(`${BASE}/verifications`).set(bearer(readOnly)).expect(200);
    await request(app).post(`${BASE}/documents/${documentId}/review`).set(bearer(readOnly)).send({ decision: 'APPROVED' }).expect(403);
  });

  it('enforces the IP allow-list', async () => {
    const key = (await issue({ scopes: ['verification.view'], allowedIps: ['203.0.113.9'] })).body.data.secret;
    await request(app).get(`${BASE}/verifications`).set(bearer(key)).expect(403);
  });

  it('reads pending verifications without exposing account owner details', async () => {
    const key = (await issue({ scopes: ['verification.view'] })).body.data.secret;
    const list = await request(app).get(`${BASE}/verifications`).set(bearer(key)).expect(200);
    expect(list.body.data).toHaveLength(1);
    const detail = await request(app).get(`${BASE}/verifications/${verificationId}`).set(bearer(key)).expect(200);
    expect(detail.body.data.documents[0].value).toBe('https://example.com/');
    expect(JSON.stringify(detail.body)).not.toMatch(/passwordHash|members|email/);
    expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_VERIFICATION_VIEWED', resourceId: verificationId } })).toBeGreaterThan(0);
  });

  it('reviews documents, but cannot touch decided verifications, and revocation stops access', async () => {
    const created = (await issue({ scopes: ['verification.view', 'verification.review'] })).body.data;
    const key = created.secret as string;

    await request(app).post(`${BASE}/documents/${documentId}/review`).set(bearer(key)).send({ decision: 'REJECTED' }).expect(422); // note required
    await request(app).post(`${BASE}/documents/${documentId}/review`).set(bearer(key)).send({ decision: 'APPROVED' }).expect(200);
    expect((await prisma.verificationDocument.findUniqueOrThrow({ where: { id: documentId } })).status).toBe('APPROVED');
    expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_DOCUMENT_REVIEWED', resourceId: documentId } })).toBe(1);
    // The business itself is still undecided — only staff can approve it.
    expect((await prisma.verification.findUniqueOrThrow({ where: { id: verificationId } })).status).toBe('SUBMITTED');

    const activity = await request(app).get(`/api/v1/admin/integrations/${created.integration.id}/activity`).set(bearer(superAdmin.token)).expect(200);
    expect(activity.body.data.length).toBeGreaterThan(0);

    await prisma.verification.update({ where: { id: verificationId }, data: { status: 'APPROVED' } });
    await request(app).get(`${BASE}/verifications/${verificationId}`).set(bearer(key)).expect(404);
    await request(app).post(`${BASE}/documents/${documentId}/review`).set(bearer(key)).send({ decision: 'REJECTED', note: 'x' }).expect(404);

    await request(app).post(`/api/v1/admin/integrations/${created.integration.id}/disable`).set(bearer(superAdmin.token)).expect(200);
    await request(app).get(`${BASE}/verifications`).set(bearer(key)).expect(403);
    await request(app).post(`/api/v1/admin/integrations/${created.integration.id}/enable`).set(bearer(superAdmin.token)).expect(200);
    await request(app).post(`/api/v1/admin/integrations/${created.integration.id}/revoke`).set(bearer(superAdmin.token)).expect(200);
    await request(app).get(`${BASE}/verifications`).set(bearer(key)).expect(401);
  });

  it('platform admin controls organization-level API access', async () => {
    const o = await createActiveOrg({ credits: 100 });
    const createKey = (scopes?: string[]) => request(app).post('/api/v1/developer/api-keys').set({ ...bearer(o.token), 'X-Organization-Id': o.org.id }).send({ name: 'Shop', ...(scopes ? { scopes } : {}) });
    const first = await createKey();
    expect(first.status).toBe(201);
    const secret = first.body.data.secret as string;
    await request(app).get('/api/v1/public/balance').set(bearer(secret)).expect(200);

    const set = (body: Record<string, unknown>) => request(app).put(`/api/v1/admin/organizations/${o.org.id}/api-access`).set(bearer(superAdmin.token)).send(body);
    // Cap scopes: balance.read removed, so the existing key loses it immediately.
    await set({ enabled: true, allowedScopes: ['sms.read'] }).expect(200);
    expect((await request(app).get('/api/v1/public/balance').set(bearer(secret))).status).toBe(403);
    expect((await createKey(['sms.send'])).status).toBe(422);

    // Switch the organization off entirely.
    await set({ enabled: false, allowedScopes: null }).expect(200);
    expect((await request(app).get('/api/v1/public/balance').set(bearer(secret))).status).toBe(403);
    expect((await createKey()).status).toBe(403);

    await set({ enabled: true, allowedScopes: null }).expect(200);
    await request(app).get('/api/v1/public/balance').set(bearer(secret)).expect(200);
    expect(await prisma.auditLog.count({ where: { action: 'ORGANIZATION_API_ACCESS_CHANGED', organizationId: o.org.id } })).toBe(3);

    // Staff can also disable a single key.
    const keyId = first.body.data.apiKey.id as string;
    await request(app).post(`/api/v1/admin/api-keys/${keyId}/disable`).set(bearer(superAdmin.token)).expect(200);
    expect((await request(app).get('/api/v1/public/balance').set(bearer(secret))).status).toBe(403);
  });

  it('a credential can call any admin endpoint it holds the permission for — and nothing else', async () => {
    const key = (await issue({ scopes: ['organizations.view'] })).body.data.secret as string;
    await request(app).get('/api/v1/admin/organizations').set(bearer(key)).expect(200);
    await request(app).get('/api/v1/admin/users').set(bearer(key)).expect(403); // lacks users.view
    // Never able to manage credentials, whatever it holds.
    await request(app).get('/api/v1/admin/integrations').set(bearer(key)).expect(403);
    const risky = (await issue({ scopes: ['integrations.manage', 'integrations.view'], allowedIps: ['203.0.113.9'], expiresAt: new Date(Date.now() + 86_400_000).toISOString() })).body.data.secret as string;
    await request(app).post('/api/v1/admin/integrations').set({ ...bearer(risky), 'X-Forwarded-For': '203.0.113.9' }).send({ name: 'x', scopes: ['organizations.view'] }).expect(403);
  });

  it('management permissions work, and high-risk ones require IP limits and an expiry', async () => {
    const o = await createActiveOrg();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect((await issue({ scopes: ['organizations.suspend', 'organizations.view'] })).status).toBe(201); // status change: normal risk
    expect((await issue({ scopes: ['wallet.adjust'] })).status).toBe(422);
    expect((await issue({ scopes: ['wallet.adjust'], allowedIps: ['203.0.113.9'] })).status).toBe(422); // still needs an expiry
    expect((await issue({ scopes: ['wallet.adjust'], allowedIps: ['203.0.113.9'], expiresAt: tomorrow })).status).toBe(201);

    const key = (await issue({ scopes: ['organizations.suspend'] })).body.data.secret as string;
    await request(app).post(`/api/v1/admin/organizations/${o.org.id}/status`).set(bearer(key)).send({ action: 'suspend', reason: 'Non-payment flagged by finance' }).expect(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: o.org.id } })).status).toBe('SUSPENDED');
    const log = await prisma.auditLog.findFirst({ where: { organizationId: o.org.id, action: { contains: 'SUSPEND' } }, include: { actor: true } });
    expect(log?.actor?.email).toMatch(/^integration-[0-9a-f]{12}@service\.local$/);
  });
});
