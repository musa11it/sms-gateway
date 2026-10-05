import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { addMember, app, createActiveOrg, createStaff, resetDatabase } from './helpers';

beforeAll(resetDatabase);

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('platform RBAC', () => {
  it('lets authorised staff in and keeps unauthorised staff out', async () => {
    const support = await createStaff('SUPPORT');
    const finance = await createStaff('FINANCE');
    expect((await request(app).get('/api/v1/admin/organizations').set(auth(support.token))).status).toBe(200);
    expect((await request(app).get('/api/v1/admin/organizations').set(auth(finance.token))).status).toBe(200);
    // Finance has no user management or API key access
    const users = await request(app).get('/api/v1/admin/users').set(auth(finance.token));
    expect(users.status).toBe(403);
    expect(users.body.code).toBe('PERMISSION_DENIED');
    expect((await request(app).get('/api/v1/admin/api-keys').set(auth(finance.token))).status).toBe(403);
    // Support cannot adjust wallets
    const { org } = await createActiveOrg();
    const adj = await request(app).post(`/api/v1/admin/billing/wallets/${org.id}/adjust`).set(auth(support.token)).send({ kind: 'CREDIT', amount: 100, reason: 'goodwill credit', reference: 'T-1' });
    expect(adj.status).toBe(403);
  });

  it('customers cannot reach admin APIs', async () => {
    const { token } = await createActiveOrg();
    const res = await request(app).get('/api/v1/admin/users').set(auth(token));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_STAFF');
  });

  it('permissions changes take effect without code changes', async () => {
    const support = await createStaff('SUPPORT');
    expect((await request(app).get('/api/v1/admin/audit-logs').set(auth(support.token))).status).toBe(403);
    const role = await prisma.role.findFirstOrThrow({ where: { code: 'SUPPORT', scope: 'PLATFORM' } });
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key_scope: { key: 'audit_logs.view', scope: 'PLATFORM' } } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    expect((await request(app).get('/api/v1/admin/audit-logs').set(auth(support.token))).status).toBe(200);
  });

  it('prevents privilege escalation when editing roles', async () => {
    const admin = await createStaff('ADMIN');
    const role = await prisma.role.findFirstOrThrow({ where: { code: 'SUPPORT', scope: 'PLATFORM' } });
    // ADMIN lacks roles.update by default
    expect((await request(app).patch(`/api/v1/admin/roles/${role.id}`).set(auth(admin.token)).send({ permissions: ['wallet.adjust'] })).status).toBe(403);
    const sa = await createStaff('SUPER_ADMIN');
    const superRole = await prisma.role.findFirstOrThrow({ where: { code: 'SUPER_ADMIN', scope: 'PLATFORM' } });
    const res = await request(app).patch(`/api/v1/admin/roles/${superRole.id}`).set(auth(sa.token)).send({ permissions: [] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SYSTEM_ROLE');
    // Only a super admin may grant SUPER_ADMIN
    const target = await createStaff('SUPPORT');
    const grant = await request(app).put(`/api/v1/admin/users/${target.user.id}/roles`).set(auth(admin.token)).send({ roleIds: [superRole.id] });
    expect(grant.status).toBe(403);
  });
});

describe('organization RBAC & tenant isolation', () => {
  it('staff members can send but cannot manage API keys or the team', async () => {
    const { org } = await createActiveOrg({ credits: 100 });
    const staff = await addMember(org.id, 'CUSTOMER_STAFF');
    expect((await request(app).get('/api/v1/contacts').set(auth(staff.token))).status).toBe(200);
    expect((await request(app).post('/api/v1/developer/api-keys').set(auth(staff.token)).send({ name: 'x key' })).status).toBe(403);
    expect((await request(app).get('/api/v1/organization/members').set(auth(staff.token))).status).toBe(403);
  });

  it('managers cannot grant roles with more access than their own', async () => {
    const { org } = await createActiveOrg();
    const manager = await addMember(org.id, 'CUSTOMER_MANAGER');
    const ownerRole = await prisma.role.findFirstOrThrow({ where: { code: 'CUSTOMER_OWNER', scope: 'ORGANIZATION' } });
    const inv = await request(app).post('/api/v1/organization/invitations').set(auth(manager.token)).send({ email: 'x@test.local', roleId: ownerRole.id });
    expect(inv.status).toBe(403);
  });

  it('never exposes another organization’s data', async () => {
    const a = await createActiveOrg();
    const b = await createActiveOrg();
    const contact = await request(app).post('/api/v1/contacts').set(auth(a.token)).send({ name: 'Secret', phone: '0788000111' });
    expect(contact.status).toBe(201);
    const id = contact.body.data.id;

    expect((await request(app).get(`/api/v1/contacts/${id}`).set(auth(b.token))).status).toBe(404);
    expect((await request(app).patch(`/api/v1/contacts/${id}`).set(auth(b.token)).send({ name: 'Hacked' })).status).toBe(404);
    expect((await request(app).delete(`/api/v1/contacts/${id}`).set(auth(b.token))).status).toBe(404);
    const list = await request(app).get('/api/v1/contacts').set(auth(b.token));
    expect(list.body.data.find((c: { id: string }) => c.id === id)).toBeUndefined();
    // Selecting the other org via header is refused
    const hdr = await request(app).get('/api/v1/contacts').set(auth(b.token)).set('X-Organization-Id', a.org.id);
    expect(hdr.status).toBe(403);
    expect(hdr.body.code).toBe('NOT_A_MEMBER');
    // Using another org's sender ID is refused
    const send = await request(app).post('/api/v1/sms/send').set(auth(b.token)).send({ senderId: a.sender.id, message: 'hi', recipients: ['0788000111'] });
    expect(send.status).toBe(422);
    expect(send.body.code).toBe('SENDER_NOT_FOUND');
  });
});
