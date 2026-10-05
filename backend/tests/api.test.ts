import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { publicApiLimiter } from '../src/middlewares/rateLimit';
import { app, balanceOf, createActiveOrg, resetDatabase } from './helpers';

beforeAll(resetDatabase);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function keyFor(token: string) {
  const res = await request(app).post('/api/v1/developer/api-keys').set(auth(token)).send({ name: 'Backend' });
  expect(res.status).toBe(201);
  expect(res.body.data.secret).toMatch(/^sgw_live_[0-9a-f]{12}_[A-Za-z0-9]{40}$/);
  return res.body.data as { secret: string; apiKey: { id: string } };
}

describe('public API', () => {
  it('sends through the same business rules as the dashboard', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 10 });
    const { secret } = await keyFor(token);
    const res = await request(app).post('/api/v1/public/sms/send').set(auth(secret)).send({ sender: sender.name, recipient: '+250788123456', message: 'Your order is ready.' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.messageId).toBeTruthy();
    expect(await balanceOf(org.id)).toBe(9);

    const status = await request(app).get(`/api/v1/public/sms/${res.body.messageId}`).set(auth(secret));
    expect(status.body.data.status).toBe('QUEUED');

    // Unapproved sender through the API is refused too
    await prisma.senderId.update({ where: { id: sender.id }, data: { status: 'SUSPENDED' } });
    const blocked = await request(app).post('/api/v1/public/sms/send').set(auth(secret)).send({ sender: sender.name, recipient: '+250788123456', message: 'x' });
    expect(blocked.body.code).toBe('SENDER_NOT_APPROVED');
    expect(await prisma.apiRequestLog.count({ where: { organizationId: org.id } })).toBeGreaterThanOrEqual(3);
  });

  it('stores only a hash of the key', async () => {
    const { token } = await createActiveOrg();
    const { secret, apiKey } = await keyFor(token);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: apiKey.id } });
    expect(row.keyHash).not.toContain(secret.split('_')[3]);
    const list = await request(app).get('/api/v1/developer/api-keys').set(auth(token));
    expect(JSON.stringify(list.body)).not.toContain(secret);
  });

  it('rejects invalid, malformed and revoked keys', async () => {
    const { token } = await createActiveOrg({ credits: 5 });
    const { secret, apiKey } = await keyFor(token);
    expect((await request(app).get('/api/v1/public/balance').set(auth(secret))).body.data.balance).toBe(5);
    expect((await request(app).get('/api/v1/public/balance').set(auth('garbage'))).body.code).toBe('INVALID_API_KEY');
    const tampered = secret.slice(0, -1) + (secret.endsWith('a') ? 'b' : 'a');
    expect((await request(app).get('/api/v1/public/balance').set(auth(tampered))).status).toBe(401);
    await request(app).post(`/api/v1/developer/api-keys/${apiKey.id}/revoke`).set(auth(token)).expect(200);
    const revoked = await request(app).get('/api/v1/public/balance').set(auth(secret));
    expect(revoked.status).toBe(401);
    expect(revoked.body.code).toBe('API_KEY_REVOKED');
  });

  it('suspended organizations cannot use the API', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 5 });
    const { secret } = await keyFor(token);
    await prisma.organization.update({ where: { id: org.id }, data: { status: 'SUSPENDED' } });
    const res = await request(app).post('/api/v1/public/sms/send').set(auth(secret)).send({ sender: sender.name, recipient: '+250788123456', message: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORGANIZATION_SUSPENDED');
  });

  describe('rate limiting', () => {
    beforeAll(() => {
      process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true';
    });
    afterAll(() => {
      delete process.env.ENABLE_RATE_LIMIT_IN_TESTS;
    });

    it('limits requests per API key', async () => {
      const mini = express();
      mini.use((req, _res, next) => {
        req.apiKey = { id: String(req.headers['x-key']), prefix: 'x', scopes: [], rateLimitPerMinute: null };
        next();
      });
      mini.use(publicApiLimiter(2));
      mini.get('/', (_req, res) => res.json({ ok: true }));
      expect((await request(mini).get('/').set('x-key', 'a')).status).toBe(200);
      expect((await request(mini).get('/').set('x-key', 'a')).status).toBe(200);
      const limited = await request(mini).get('/').set('x-key', 'a');
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('RATE_LIMITED');
      // A different key has its own quota
      expect((await request(mini).get('/').set('x-key', 'b')).status).toBe(200);
    });
  });
});
