import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SCOPES } from '../src/modules/integrations/scopes';
import { documentedAdminPermissions, orphanedBodies } from '../src/docs/adminEndpoints';
import { app } from './helpers';

describe('API documentation', () => {
  it('serves the OpenAPI document and the Swagger UI publicly', async () => {
    const spec = await request(app).get('/api/docs/openapi.json').expect(200);
    expect(spec.body.openapi).toBe('3.1.0');
    expect(Object.keys(spec.body.paths)).toContain('/public/sms/send');
    expect((await request(app).get('/api/docs').expect(200)).text).toContain('SwaggerUIBundle');
  });

  it('only documents scopes that exist, and documents every scope', async () => {
    const spec = (await request(app).get('/api/docs/openapi.json')).body;
    const used = new Set<string>();
    for (const p of Object.values<Record<string, { security?: Record<string, string[]>[] }>>(spec.paths)) {
      for (const op of Object.values(p)) for (const sec of op.security ?? []) for (const scopes of Object.values(sec)) scopes.forEach((s) => used.add(s));
    }
    const registry = SCOPES.map((s) => s.key);
    expect([...used].every((s) => registry.includes(s))).toBe(true);
    // Every organization-level scope has documented endpoints.
    expect(SCOPES.filter((s) => s.level === 'ORGANIZATION').every((s) => used.has(s.key))).toBe(true);
  });

  it('documents the admin API from the real routers, but never credential management', async () => {
    const spec = (await request(app).get('/api/docs/openapi.json')).body;
    const paths = Object.keys(spec.paths);
    expect(paths).toContain('/admin/organizations');
    expect(paths).toContain('/admin/organizations/{id}/status');
    expect(paths.some((p) => p.startsWith('/admin/integrations'))).toBe(false);
    expect(spec.paths['/admin/organizations/{id}/status'].post.security).toEqual([{ IntegrationKey: ['organizations.suspend'] }]);
    // Every permission a documented endpoint asks for can actually be granted to a credential.
    const grantable = SCOPES.map((s) => s.key);
    expect(documentedAdminPermissions().every((p) => grantable.includes(p))).toBe(true);
  });

  it('has no hand-written request body for a route that does not exist', () => {
    expect(orphanedBodies()).toEqual([]);
  });

  it('documents request bodies and examples for the key admin endpoints', async () => {
    const spec = (await request(app).get('/api/docs/openapi.json')).body;
    const create = spec.paths['/admin/api-credentials'].post;
    expect(create.requestBody.content['application/json'].schema.required).toEqual(['name', 'scopes']);
    expect(create.requestBody.content['application/json'].example.name).toBe('Finance System');
    expect(spec.paths['/admin/organizations'].post.requestBody.content['application/json'].schema.properties.owner).toBeDefined();
    expect(spec.paths['/admin/api-credentials/{id}/rotate'].post.requestBody.content['application/json'].example).toEqual({ overlapMinutes: 60 });
  });
});
