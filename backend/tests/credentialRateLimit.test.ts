import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// Tiny limits so the tests can hit them; this must run before the app modules read the environment.
vi.hoisted(() => {
  process.env.API_RATE_LIMIT = '2';
  process.env.API_IP_RATE_LIMIT = '3';
  process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true';
});

import { credentialIpLimiter, integrationLimiter } from '../src/middlewares/rateLimit';

describe('credential rate limiting', () => {
  it('limits per source IP before authentication', async () => {
    const mini = express();
    mini.use(credentialIpLimiter);
    mini.get('/', (_req, res) => res.json({ ok: true }));
    for (let i = 0; i < 3; i++) expect((await request(mini).get('/')).status).toBe(200);
    const limited = await request(mini).get('/');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });

  it('limits per credential, so another credential has its own quota', async () => {
    const mini = express();
    mini.use((req, _res, next) => {
      req.integration = { id: String(req.headers['x-cred']), name: 'x', prefix: 'x', scopes: [] };
      next();
    });
    mini.use(integrationLimiter);
    mini.get('/', (_req, res) => res.json({ ok: true }));
    expect((await request(mini).get('/').set('x-cred', 'a')).status).toBe(200);
    expect((await request(mini).get('/').set('x-cred', 'a')).status).toBe(200);
    expect((await request(mini).get('/').set('x-cred', 'a')).status).toBe(429);
    expect((await request(mini).get('/').set('x-cred', 'b')).status).toBe(200);
  });
});
