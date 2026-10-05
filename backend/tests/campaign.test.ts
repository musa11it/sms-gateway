import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { dispatchMessage, pollPendingDeliveryStatuses, releaseDueScheduledMessages } from '../src/modules/sms/sms.service';
import { app, balanceOf, createActiveOrg, resetDatabase } from './helpers';

beforeAll(resetDatabase);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function setup(credits = 100) {
  const ctx = await createActiveOrg({ credits });
  const group = await request(app).post('/api/v1/contact-groups').set(auth(ctx.token)).send({ name: 'VIP' });
  for (const phone of ['0788100001', '0788100002', '0788109999']) {
    const c = await request(app).post('/api/v1/contacts').set(auth(ctx.token)).send({ phone, groupIds: [group.body.data.id] });
    expect(c.status).toBe(201);
  }
  // An unsubscribed contact in the group must be skipped.
  await request(app).post('/api/v1/contacts').set(auth(ctx.token)).send({ phone: '0788100003', groupIds: [group.body.data.id], status: 'UNSUBSCRIBED' });
  const campaign = await request(app)
    .post('/api/v1/campaigns')
    .set(auth(ctx.token))
    .send({ name: 'Weekend promo', senderId: ctx.sender.id, message: 'Big sale this weekend!', groupIds: [group.body.data.id], phones: ['0788100004'] });
  expect(campaign.status).toBe(201);
  expect(campaign.body.data.status).toBe('DRAFT');
  return { ...ctx, campaignId: campaign.body.data.id as string };
}

describe('campaigns', () => {
  it('creates a draft without charging', async () => {
    const { org } = await setup();
    expect(await balanceOf(org.id)).toBe(100);
  });

  it('launches, processes and completes with accurate stats', async () => {
    const { token, org, campaignId } = await setup();
    const launch = await request(app).post(`/api/v1/campaigns/${campaignId}/launch`).set(auth(token)).send({});
    expect(launch.status).toBe(200);
    expect(launch.body.data.recipients).toBe(4); // 3 active group members + 1 explicit number, unsubscribed skipped
    expect(await balanceOf(org.id)).toBe(96);

    await dispatchMessage(launch.body.data.messageId);
    await pollPendingDeliveryStatuses(0);

    const detail = await request(app).get(`/api/v1/campaigns/${campaignId}`).set(auth(token));
    expect(detail.body.data.status).toBe('PARTIALLY_COMPLETED'); // ...9999 fails delivery
    expect(detail.body.data.stats).toMatchObject({ recipients: 4, delivered: 3, failed: 1, pending: 0, creditsUsed: 4 });
    const notif = await prisma.notification.count({ where: { organizationId: org.id, type: 'CAMPAIGN_COMPLETED' } });
    expect(notif).toBeGreaterThan(0);
    // Launched campaigns cannot be edited or re-launched
    expect((await request(app).patch(`/api/v1/campaigns/${campaignId}`).set(auth(token)).send({ name: 'x y' })).status).toBe(409);
    expect((await request(app).post(`/api/v1/campaigns/${campaignId}/launch`).set(auth(token)).send({})).status).toBe(409);
  });

  it('schedules (reserving credits), releases when due, and cancels with refund', async () => {
    const { token, org, campaignId } = await setup();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const sched = await request(app).post(`/api/v1/campaigns/${campaignId}/launch`).set(auth(token)).send({ scheduledAt: at });
    expect(sched.body.data.status).toBe('SCHEDULED');
    expect(await balanceOf(org.id)).toBe(96);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe('SCHEDULED');

    const cancel = await request(app).post(`/api/v1/campaigns/${campaignId}/cancel`).set(auth(token));
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');
    expect(await balanceOf(org.id)).toBe(100);
  });

  it('scheduler releases due campaigns to the queue', async () => {
    const { token, campaignId } = await setup();
    const sched = await request(app).post(`/api/v1/campaigns/${campaignId}/launch`).set(auth(token)).send({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    await prisma.smsMessage.update({ where: { id: sched.body.data.messageId }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    await releaseDueScheduledMessages();
    expect((await prisma.smsMessage.findUniqueOrThrow({ where: { id: sched.body.data.messageId } })).status).toBe('QUEUED');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe('QUEUED');
  });

  it('a failed launch (insufficient credits) leaves the draft untouched', async () => {
    const { token, campaignId, org } = await setup(2);
    const launch = await request(app).post(`/api/v1/campaigns/${campaignId}/launch`).set(auth(token)).send({});
    expect(launch.status).toBe(402);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe('DRAFT');
    expect(await balanceOf(org.id)).toBe(2);
  });
});
