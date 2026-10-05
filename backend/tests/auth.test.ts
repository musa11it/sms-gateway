import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { PASSWORD, app, createActiveOrg, resetDatabase } from './helpers';

beforeAll(resetDatabase);

describe('auth', () => {
  it('registers a user with an organization, wallet and pending status', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ fullName: 'Jane Doe', email: 'Jane@Example.com', password: 'Secret123', organizationName: 'Jane Shop' });
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.headers['set-cookie']?.[0]).toMatch(/sgw_rt=.*HttpOnly/i);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'jane@example.com' }, include: { memberships: { include: { organization: { include: { wallet: true } } } } } });
    expect(user.status).toBe('PENDING_EMAIL_VERIFICATION');
    expect(user.passwordHash).not.toContain('Secret123');
    expect(user.memberships[0].isOwner).toBe(true);
    expect(user.memberships[0].organization.status).toBe('DRAFT');
    expect(user.memberships[0].organization.wallet?.balance).toBe(0);
    expect(await prisma.emailMessage.count({ where: { to: 'jane@example.com', template: 'email-verification' } })).toBe(1);
  });

  it('rejects duplicate email and weak passwords', async () => {
    const dup = await request(app).post('/api/v1/auth/register').send({ fullName: 'X Y', email: 'jane@example.com', password: 'Secret123', organizationName: 'X' + 'y' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('EMAIL_TAKEN');
    const weak = await request(app).post('/api/v1/auth/register').send({ fullName: 'X Y', email: 'x@example.com', password: 'short', organizationName: 'Xy' });
    expect(weak.status).toBe(422);
    expect(weak.body).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
  });

  it('logs in with valid credentials and rejects invalid ones', async () => {
    const ok = await request(app).post('/api/v1/auth/login').send({ email: 'jane@example.com', password: 'Secret123' });
    expect(ok.status).toBe(200);
    const bad = await request(app).post('/api/v1/auth/login').send({ email: 'jane@example.com', password: 'nope-nope1' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('INVALID_CREDENTIALS');
    const unknown = await request(app).post('/api/v1/auth/login').send({ email: 'ghost@example.com', password: 'nope-nope1' });
    expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('blocks suspended accounts, including existing sessions', async () => {
    const { user, token } = await createActiveOrg();
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(403);
    expect(me.body.code).toBe('ACCOUNT_SUSPENDED');
    const login = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
    expect(login.status).toBe(403);
  });

  it('verifies email with a one-time token', async () => {
    const mail = await prisma.emailMessage.findFirstOrThrow({ where: { to: 'jane@example.com', template: 'email-verification' } });
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'jane@example.com' } })).status).toBe('PENDING_REVIEW');
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(400);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'jane@example.com', password: 'Secret123' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const r1 = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(r1.status).toBe(200);
    // Replaying the old token revokes the session.
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(replay.status).toBe(401);
    const newCookie = r1.headers['set-cookie'][0].split(';')[0];
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', newCookie)).status).toBe(401);
  });

  it('logout revokes the session immediately', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'jane@example.com', password: 'Secret123' });
    const token = login.body.data.accessToken;
    await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`).expect(200);
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
});
