import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { invalidateSettingsCache } from '../src/modules/settings/settings.service';
import { app, balanceOf, createActiveOrg, createStaff, resetDatabase } from './helpers';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const src = (file: string) => fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8');
const IP = '203.0.113.9';
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

let superAdmin: Awaited<ReturnType<typeof createStaff>>;

/** Issues a platform credential as a signed-in Super Admin; returns the one-time key and its id. */
async function issue(body: Record<string, unknown>) {
  const r = await request(app).post('/api/v1/admin/api-credentials').set(bearer(superAdmin.token)).send({ name: 'Finance System', allowedIps: [], ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { key: r.body.data.secret as string, id: r.body.data.integration.id as string };
}
const secretPart = (key: string) => key.split('_')[3];

beforeAll(async () => {
  await resetDatabase();
  superAdmin = await createStaff('SUPER_ADMIN');
});

describe('API credentials — authentication', () => {
  it('accepts a valid key and returns the request id', async () => {
    const { key } = await issue({ scopes: ['organizations.view'] });
    const r = await request(app).get('/api/v1/admin/organizations').set(bearer(key));
    expect(r.status).toBe(200);
    expect(r.headers['x-request-id']).toBeTruthy();
  });

  it('rejects a wrong secret and an unknown prefix identically, without revealing which was wrong', async () => {
    const { key } = await issue({ scopes: ['organizations.view'] });
    const wrongSecret = await request(app).get('/api/v1/admin/organizations').set(bearer(key.slice(0, -1) + (key.endsWith('a') ? 'b' : 'a')));
    const unknownPrefix = await request(app).get('/api/v1/admin/organizations').set(bearer(`sgw_int_${'0'.repeat(12)}_${'a'.repeat(40)}`));
    for (const r of [wrongSecret, unknownPrefix]) {
      expect(r.status).toBe(401);
      expect(r.body.requestId).toBe(r.headers['x-request-id']);
    }
    expect(wrongSecret.body.message).toBe(unknownPrefix.body.message);
    expect(wrongSecret.body.code).toBe(unknownPrefix.body.code);
  });

  it('rejects disabled, revoked and expired credentials immediately', async () => {
    const call = (key: string) => request(app).get('/api/v1/admin/organizations').set(bearer(key));
    const a = await issue({ scopes: ['organizations.view'] });
    await request(app).post(`/api/v1/admin/api-credentials/${a.id}/disable`).set(bearer(superAdmin.token)).expect(200);
    expect((await call(a.key)).status).toBe(403);
    await request(app).post(`/api/v1/admin/api-credentials/${a.id}/enable`).set(bearer(superAdmin.token)).expect(200);
    expect((await call(a.key)).status).toBe(200);
    await request(app).post(`/api/v1/admin/api-credentials/${a.id}/revoke`).set(bearer(superAdmin.token)).expect(200);
    expect((await call(a.key)).status).toBe(401);

    const b = await issue({ scopes: ['organizations.view'] });
    await prisma.integrationClient.update({ where: { id: b.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(b.key)).status).toBe(401);
  });

  it('enforces the IP allow-list', async () => {
    const { key } = await issue({ scopes: ['organizations.view'], allowedIps: [IP] });
    expect((await request(app).get('/api/v1/admin/organizations').set(bearer(key))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/organizations').set({ ...bearer(key), 'X-Forwarded-For': IP })).status).toBe(200);
  });

  it('rejects an organization key when the organization’s API access is switched off', async () => {
    const o = await createActiveOrg({ credits: 5 });
    const created = await request(app).post('/api/v1/developer/api-keys').set({ ...bearer(o.token), 'X-Organization-Id': o.org.id }).send({ name: 'Shop' }).expect(201);
    const key = created.body.data.secret as string;
    await request(app).get('/api/v1/public/balance').set(bearer(key)).expect(200);
    await request(app).put(`/api/v1/admin/organizations/${o.org.id}/api-access`).set(bearer(superAdmin.token)).send({ enabled: false, allowedScopes: null }).expect(200);
    const blocked = await request(app).get('/api/v1/public/balance').set(bearer(key));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('API_ACCESS_DISABLED');
  });
});

describe('API credentials — authorization', () => {
  it('allows what the scopes allow and nothing else', async () => {
    const { key } = await issue({ scopes: ['organizations.view'] });
    await request(app).get('/api/v1/admin/organizations').set(bearer(key)).expect(200);
    const denied = await request(app).get('/api/v1/admin/users').set(bearer(key));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
  });

  it('never gives an organization key a scope above the organization’s ceiling', async () => {
    const o = await createActiveOrg();
    await request(app).put(`/api/v1/admin/organizations/${o.org.id}/api-access`).set(bearer(superAdmin.token)).send({ enabled: true, allowedScopes: ['sms.read', 'balance.read'] }).expect(200);
    const asks = (scopes: string[]) => request(app).post('/api/v1/developer/api-keys').set({ ...bearer(o.token), 'X-Organization-Id': o.org.id }).send({ name: 'k', scopes });
    const refused = await asks(['sms.read', 'sms.send']);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('SCOPE_NOT_PERMITTED');
    expect(refused.body.errors[0].field).toBe('scopes');
    expect((await asks(['sms.read'])).status).toBe(201);
  });

  it('requires an IP allow-list and an expiry for high-risk permissions, on create and on update', async () => {
    const r = (body: Record<string, unknown>) => request(app).post('/api/v1/admin/api-credentials').set(bearer(superAdmin.token)).send({ name: 'x', allowedIps: [], ...body });
    expect((await r({ scopes: ['wallet.adjust'] })).status).toBe(422);
    expect((await r({ scopes: ['wallet.adjust'], allowedIps: [IP] })).status).toBe(422);
    expect((await r({ scopes: ['wallet.adjust'], allowedIps: [IP], expiresAt: tomorrow() })).status).toBe(201);
    const { id } = await issue({ scopes: ['organizations.view'] });
    const patch = await request(app).patch(`/api/v1/admin/api-credentials/${id}`).set(bearer(superAdmin.token)).send({ scopes: ['organizations.view', 'wallet.refund'] });
    expect(patch.status).toBe(422);
    expect(patch.body.code).toBe('HIGH_RISK_REQUIRES_LIMITS');
  });

  it('allows any IP address only as an explicit choice, and still requires an expiry for high-risk scopes', async () => {
    const r = (body: Record<string, unknown>) => request(app).post('/api/v1/admin/api-credentials').set(bearer(superAdmin.token)).send({ name: 'x', ...body });
    expect((await r({ scopes: ['wallet.adjust'], allowedIps: ['*'] })).status).toBe(422); // high-risk: still needs an expiry
    expect((await r({ scopes: ['organizations.view'], allowedIps: ['*', IP] })).status).toBe(422); // either one or the other
    const any = await r({ scopes: ['wallet.adjust', 'organizations.view'], allowedIps: ['*'], expiresAt: tomorrow() });
    expect(any.status).toBe(201);
    expect(any.body.data.integration.allowedIps).toEqual(['*']);
    // Works from an address that is not on any list.
    expect((await request(app).get('/api/v1/admin/organizations').set({ ...bearer(any.body.data.secret), 'X-Forwarded-For': '198.51.100.77' })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_CREATED', resourceId: any.body.data.integration.id } })).toBe(1);
  });

  it('a credential can never create or change credentials — even if it holds the permission', async () => {
    const { key } = await issue({ scopes: ['integrations.manage', 'integrations.view'], allowedIps: [IP], expiresAt: tomorrow() });
    const asCredential = { ...bearer(key), 'X-Forwarded-For': IP };
    for (const [method, url] of [['post', '/api/v1/admin/api-credentials'], ['get', '/api/v1/admin/api-credentials'], ['post', '/api/v1/admin/integrations']] as const) {
      const r = await request(app)[method](url).set(asCredential).send({ name: 'stronger', scopes: ['organizations.view'] });
      expect(r.status, url).toBe(403);
      expect(r.body.code).toBe('HUMAN_ONLY');
    }
  });

  it('service accounts cannot sign in, reset a password, or appear as users', async () => {
    const { id } = await issue({ scopes: ['organizations.view'] });
    const client = await prisma.integrationClient.findUniqueOrThrow({ where: { id } });
    const account = await prisma.user.findUniqueOrThrow({ where: { id: client.userId! } });
    expect(account.isServiceAccount).toBe(true);
    await request(app).post('/api/v1/auth/login').send({ email: account.email, password: 'anything-at-all-1' }).expect(401);
    await request(app).post('/api/v1/auth/forgot-password').send({ email: account.email });
    expect(await prisma.userToken.count({ where: { userId: account.id } })).toBe(0);
    const users = await request(app).get('/api/v1/admin/users?limit=100').set(bearer(superAdmin.token)).expect(200);
    expect((users.body.data as { email: string }[]).some((u) => u.email === account.email)).toBe(false);
  });
});

describe('API credentials — secrets and rotation', () => {
  it('never stores, logs or returns the plaintext secret', async () => {
    const { key, id } = await issue({ scopes: ['organizations.view'] });
    const secret = secretPart(key);
    expect(secret).toMatch(/^[A-Za-z0-9]{40}$/);
    await request(app).get('/api/v1/admin/organizations').set(bearer(key)).expect(200);

    const everywhere = JSON.stringify({
      credentials: await prisma.integrationClient.findMany(),
      audit: await prisma.auditLog.findMany(),
      requests: await prisma.integrationRequestLog.findMany(),
      users: await prisma.user.findMany(),
      mail: await prisma.emailMessage.findMany(),
    });
    expect(everywhere).not.toContain(secret);
    expect(everywhere).not.toContain(key);

    for (const url of ['/api/v1/admin/api-credentials', `/api/v1/admin/api-credentials/${id}`, `/api/v1/admin/api-credentials/${id}/requests`]) {
      const body = JSON.stringify((await request(app).get(url).set(bearer(superAdmin.token)).expect(200)).body);
      expect(body).not.toContain(secret);
      expect(body).not.toMatch(/keyHash|previousKeyHash/);
    }
  });

  it('records every request without bodies or secrets', async () => {
    const { key, id } = await issue({ scopes: ['organizations.view'] });
    const r = await request(app).get('/api/v1/admin/organizations?limit=1').set(bearer(key));
    await new Promise((resolve) => setTimeout(resolve, 200)); // the log row is written when the response finishes
    const log = await prisma.integrationRequestLog.findFirstOrThrow({ where: { credentialId: id } });
    expect(log).toMatchObject({ method: 'GET', path: '/api/v1/admin/organizations', statusCode: 200, requestId: r.headers['x-request-id'] });
  });

  it('rotates: the old key stops at once, or after an overlap window', async () => {
    const call = (key: string) => request(app).get('/api/v1/admin/organizations').set(bearer(key));
    const a = await issue({ scopes: ['organizations.view'] });
    const hard = await request(app).post(`/api/v1/admin/api-credentials/${a.id}/rotate`).set(bearer(superAdmin.token)).send({}).expect(200);
    expect((await call(a.key)).status).toBe(401);
    expect((await call(hard.body.data.secret)).status).toBe(200);

    const b = await issue({ scopes: ['organizations.view'] });
    const soft = await request(app).post(`/api/v1/admin/api-credentials/${b.id}/rotate`).set(bearer(superAdmin.token)).send({ overlapMinutes: 10 }).expect(200);
    expect((await call(b.key)).status).toBe(200); // old key still valid during the overlap
    expect((await call(soft.body.data.secret)).status).toBe(200);
    await prisma.integrationClient.update({ where: { id: b.id }, data: { previousValidUntil: new Date(Date.now() - 1000) } });
    expect((await call(b.key)).status).toBe(401); // overlap over
  });

  it('uses a CSPRNG and constant-time comparison', () => {
    for (const file of ['modules/integrations/integration.service.ts', 'modules/api-keys/apiKey.service.ts']) expect(src(file)).not.toContain('Math.random');
    expect(src('modules/api-keys/apiKey.service.ts')).toContain('crypto.randomBytes');
    expect(src('utils/crypto.ts')).toContain('timingSafeEqual');
    expect(src('modules/integrations/integration.service.ts')).not.toMatch(/keyHash\s*===|===\s*row\??\.keyHash/);
  });
});

describe('API credentials — idempotency', () => {
  async function pendingDocument() {
    const o = await createActiveOrg();
    await prisma.verification.deleteMany({ where: { organizationId: o.org.id } });
    const v = await prisma.verification.create({ data: { organizationId: o.org.id, status: 'SUBMITTED', submittedAt: new Date() } });
    const doc = await prisma.verificationDocument.create({ data: { organizationId: o.org.id, verificationId: v.id, documentType: 'WEBSITE', originalName: 'https://example.com/', value: 'https://example.com/', uploadedById: o.user.id } });
    return doc.id;
  }

  it('replays the original result for a retried request and rejects a changed one', async () => {
    const docId = await pendingDocument();
    const { key } = await issue({ scopes: ['verification.view', 'verification.review'] });
    const review = (body: Record<string, unknown>, idem = 'finance-review-0001') => request(app).post(`/api/v1/integrations/finance/documents/${docId}/review`).set({ ...bearer(key), 'Idempotency-Key': idem }).send(body);

    const first = await review({ decision: 'APPROVED' });
    expect(first.status).toBe(200);
    const retry = await review({ decision: 'APPROVED' });
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_DOCUMENT_REVIEWED', resourceId: docId } })).toBe(1); // executed once

    const changed = await review({ decision: 'REJECTED', note: 'changed my mind' });
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await review({ decision: 'APPROVED' }, 'short')).status).toBe(400);
  });

  it('never charges or sends twice when an SMS request is retried, even concurrently', async () => {
    const o = await createActiveOrg({ credits: 10 });
    const created = await request(app).post('/api/v1/developer/api-keys').set({ ...bearer(o.token), 'X-Organization-Id': o.org.id }).send({ name: 'Shop' }).expect(201);
    const key = created.body.data.secret as string;
    const send = (message: string, idem: string) => request(app).post('/api/v1/public/sms/send').set({ ...bearer(key), 'Idempotency-Key': idem }).send({ sender: o.sender.name, recipient: '+250788123456', message });

    expect((await send('Your order is ready.', 'order-1042-send')).status).toBe(201);
    const replay = await send('Your order is ready.', 'order-1042-send');
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(await balanceOf(o.org.id)).toBe(9);
    expect((await send('A different message', 'order-1042-send')).status).toBe(422);

    const burst = await Promise.all(Array.from({ length: 5 }, () => send('Burst message', 'order-1043-send')));
    expect(burst.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    expect(await prisma.smsMessage.count({ where: { organizationId: o.org.id, clientReference: null, idempotencyKey: 'order-1043-send' } })).toBe(1);
    expect(await balanceOf(o.org.id)).toBe(8);
    invalidateSettingsCache();
  });
});
