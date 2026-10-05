import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from './helpers';

describe('health endpoints', () => {
  it('liveness is always ok', async () => {
    const r = await request(app).get('/health/live').expect(200);
    expect(r.body.status).toBe('ok');
  });

  it('readiness reports each dependency and exposes nothing sensitive', async () => {
    for (const path of ['/health', '/health/ready']) {
      const r = await request(app).get(path).expect(200);
      expect(r.body).toMatchObject({ status: 'ok', database: 'up', storage: 'up' });
      expect(JSON.stringify(r.body)).not.toMatch(/mysql|password|localhost/i);
    }
  });
});
