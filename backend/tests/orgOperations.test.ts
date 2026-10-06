import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { addMember, app, balanceOf, createActiveOrg, createStaff, resetDatabase } from './helpers';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('staff operating on an organization’s behalf — always with a reason, always audited', () => {
  let admin: Awaited<ReturnType<typeof createStaff>>;

  beforeAll(async () => {
    await resetDatabase();
    admin = await createStaff('SUPER_ADMIN');
  });

  const auditOf = (organizationId: string, action: string) => prisma.auditLog.findMany({ where: { organizationId, action }, orderBy: { createdAt: 'asc' } });

  it('creates and approves a sender ID for an organization, recording who and why', async () => {
    const o = await createActiveOrg();
    const post = (body: Record<string, unknown>) => request(app).post(`/api/v1/admin/organizations/${o.org.id}/senders`).set(bearer(admin.token)).send(body);

    expect((await post({ name: 'SHOPKIGALI', purpose: 'Order updates' })).status).toBe(422); // reason is mandatory
    expect((await post({ name: 'x', purpose: 'Order updates', reason: 'Customer asked by phone' })).status).toBe(422); // GSM rules still apply

    const r = await post({ name: 'SHOPKIGALI', purpose: 'Order updates', approveNow: true, reason: 'Customer asked by phone' });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('APPROVED');
    const [entry] = await auditOf(o.org.id, 'SENDER_CREATED_BY_STAFF');
    expect(entry.actorId).toBe(admin.user.id);
    expect(entry.metadata).toMatchObject({ byStaff: true, reason: 'Customer asked by phone', approvedImmediately: true });
    expect((await post({ name: 'SHOPKIGALI', purpose: 'Again', reason: 'Duplicate attempt' })).status).toBe(409);
  });

  it('is permission-controlled, and approving needs its own permission', async () => {
    const o = await createActiveOrg();
    const url = `/api/v1/admin/organizations/${o.org.id}/senders`;
    const support = await createStaff('SUPPORT');
    await request(app).post(url).set(bearer(support.token)).send({ name: 'NOPE ORG', purpose: 'x test', reason: 'should be refused' }).expect(403);
    const operator = await createStaff('SMS_OPERATOR'); // can review senders but not approve them
    const pending = await request(app).post(url).set(bearer(operator.token)).send({ name: 'PENDING ID', purpose: 'Alerts', reason: 'Created for the customer' }).expect(201);
    expect(pending.body.data.status).toBe('PENDING');
    await request(app).post(url).set(bearer(operator.token)).send({ name: 'APPROVED ID', purpose: 'Alerts', approveNow: true, reason: 'Trying to self-approve' }).expect(403);
  });

  it('withdraws an unused sender ID with a reason', async () => {
    const o = await createActiveOrg();
    const created = await request(app).post(`/api/v1/admin/organizations/${o.org.id}/senders`).set(bearer(admin.token)).send({ name: 'WITHDRAWME', purpose: 'Test purpose', reason: 'Created on request' }).expect(201);
    const url = `/api/v1/admin/organizations/${o.org.id}/senders/${created.body.data.id}/withdraw`;
    await request(app).post(url).set(bearer(admin.token)).send({}).expect(422);
    await request(app).post(url).set(bearer(admin.token)).send({ reason: 'Created by mistake' }).expect(200);
    expect(await prisma.senderId.count({ where: { id: created.body.data.id } })).toBe(0);
    expect((await auditOf(o.org.id, 'SENDER_WITHDRAWN_BY_STAFF'))[0].metadata).toMatchObject({ byStaff: true, reason: 'Created by mistake' });
  });

  it('changes, disables and removes a team member, keeping before/after and the reason', async () => {
    const o = await createActiveOrg();
    const staffRole = await prisma.role.findFirstOrThrow({ where: { code: 'CUSTOMER_STAFF', scope: 'ORGANIZATION' } });
    const manager = await prisma.role.findFirstOrThrow({ where: { code: 'CUSTOMER_MANAGER', scope: 'ORGANIZATION' } });
    const member = await addMember(o.org.id, 'CUSTOMER_STAFF');
    const row = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId: o.org.id, userId: member.user.id } });
    const url = `/api/v1/admin/organizations/${o.org.id}/members/${row.id}`;

    await request(app).patch(url).set(bearer(admin.token)).send({ roleId: manager.id }).expect(422); // no reason
    await request(app).patch(url).set(bearer(admin.token)).send({ roleId: manager.id, reason: 'Promoted by the owner' }).expect(200);
    await request(app).patch(url).set(bearer(admin.token)).send({ status: 'DISABLED', reason: 'On leave' }).expect(200);
    const updates = await auditOf(o.org.id, 'MEMBER_UPDATED');
    expect(updates[0].metadata).toMatchObject({ byStaff: true, reason: 'Promoted by the owner', before: { role: staffRole.name }, after: { role: manager.name } });
    expect(updates[1].metadata).toMatchObject({ reason: 'On leave', after: { status: 'DISABLED' } });

    // The owner is protected, and removal needs a reason.
    const ownerRow = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId: o.org.id, isOwner: true } });
    await request(app).patch(`/api/v1/admin/organizations/${o.org.id}/members/${ownerRow.id}`).set(bearer(admin.token)).send({ status: 'DISABLED', reason: 'Should not work' }).expect(403);
    await request(app).post(`${url}/remove`).set(bearer(admin.token)).send({}).expect(422);
    await request(app).post(`${url}/remove`).set(bearer(admin.token)).send({ reason: 'Left the company' }).expect(200);
    expect(await prisma.organizationMember.count({ where: { id: row.id } })).toBe(0);
    expect((await auditOf(o.org.id, 'MEMBER_REMOVED'))[0].metadata).toMatchObject({ byStaff: true, reason: 'Left the company' });
  });

  it('wallet adjustments by staff already require a reason and leave a ledger entry', async () => {
    const o = await createActiveOrg({ credits: 10 });
    const adjust = (body: Record<string, unknown>) => request(app).post(`/api/v1/admin/billing/wallets/${o.org.id}/adjust`).set(bearer(admin.token)).send(body);
    expect((await adjust({ kind: 'CREDIT', amount: 50, reference: 'ops-0001' })).status).toBe(422);
    expect((await adjust({ kind: 'CREDIT', amount: 50, reason: 'Goodwill credit for outage', reference: 'ops-0001' })).status).toBe(200);
    expect(await balanceOf(o.org.id)).toBe(60);
  });
});
