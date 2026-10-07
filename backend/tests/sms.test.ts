import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { dispatchMessage, pollPendingDeliveryStatuses } from '../src/modules/sms/sms.service';
import { app, balanceOf, createActiveOrg, resetDatabase } from './helpers';

beforeAll(resetDatabase);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('sending SMS', () => {
  it('requires an approved sender', async () => {
    const { token, sender } = await createActiveOrg({ credits: 100, senderStatus: 'PENDING' });
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'Hello', recipients: ['0788123456'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SENDER_NOT_APPROVED');
  });

  it('refuses when credits are insufficient and charges nothing', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 1 });
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'Hello', recipients: ['0788123456', '0788123457'] });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ success: false, code: 'INSUFFICIENT_CREDITS' });
    expect(await balanceOf(org.id)).toBe(1);
    expect(await prisma.smsMessage.count({ where: { organizationId: org.id } })).toBe(0);
  });

  it('refuses suspended or unapproved organizations', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 10 });
    await prisma.organization.update({ where: { id: org.id }, data: { status: 'SUSPENDED' } });
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'Hello', recipients: ['0788123456'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORGANIZATION_SUSPENDED');
  });

  it('calculates segments × recipients on the server, ignoring client values', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 1000 });
    const message = 'x'.repeat(200); // 2 GSM-7 segments
    const res = await request(app)
      .post('/api/v1/sms/send')
      .set(auth(token))
      .send({ senderId: sender.id, message, recipients: ['0788123456', '+250788123457', '250788123458', '0788123456'], totalCredits: 1, segments: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ recipientCount: 3, segments: 2, encoding: 'GSM7', totalCredits: 6 });
    expect(await balanceOf(org.id)).toBe(994);
  });

  it('rejects invalid recipients with details', async () => {
    const { token, sender } = await createActiveOrg({ credits: 10 });
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'Hi', recipients: ['0788123456', 'not-a-number'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_RECIPIENTS');
    expect(res.body.errors[0].field).toBe('recipients.1');
  });

  it('runs the simulated lifecycle: QUEUED → SENT → DELIVERED / FAILED, refunding rejected submissions', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 100 });
    const res = await request(app)
      .post('/api/v1/sms/send')
      .set(auth(token))
      .send({ senderId: sender.id, message: 'Order ready', recipients: ['+250788123456', '+250788129999', '+250788120000'] });
    const messageId = res.body.data.id;
    expect(await balanceOf(org.id)).toBe(97);

    let recipients = await prisma.smsRecipient.findMany({ where: { messageId } });
    expect(recipients.every((r) => r.status === 'QUEUED')).toBe(true);

    await dispatchMessage(messageId);
    recipients = await prisma.smsRecipient.findMany({ where: { messageId } });
    const byPhone = (p: string) => recipients.find((r) => r.phone === p)!;
    expect(byPhone('+250788123456').status).toBe('SENT');
    expect(byPhone('+250788123456').providerMessageId).toMatch(/^SIM-/);
    expect(byPhone('+250788120000')).toMatchObject({ status: 'REJECTED', errorCode: 'INVALID_DESTINATION', refunded: true });
    expect(await balanceOf(org.id)).toBe(98); // rejected submission refunded

    await pollPendingDeliveryStatuses(0);
    recipients = await prisma.smsRecipient.findMany({ where: { messageId } });
    expect(recipients.find((r) => r.phone === '+250788123456')!.status).toBe('DELIVERED');
    expect(recipients.find((r) => r.phone === '+250788129999')).toMatchObject({ status: 'FAILED', errorCode: 'ABSENT_SUBSCRIBER' });

    const batch = await prisma.smsMessage.findUniqueOrThrow({ where: { id: messageId } });
    expect(batch.status).toBe('COMPLETED');
    const reports = await prisma.smsDeliveryReport.count({ where: { recipient: { messageId } } });
    expect(reports).toBeGreaterThanOrEqual(4);
  });

  it('idempotency keys prevent double sends and double charges', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 10 });
    const body = { senderId: sender.id, message: 'Once', recipients: ['0788123456'], idempotencyKey: 'order-1234-ready' };
    const a = await request(app).post('/api/v1/sms/send').set(auth(token)).send(body);
    const b = await request(app).post('/api/v1/sms/send').set(auth(token)).send(body);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(b.body.data.duplicate).toBe(true);
    expect(await balanceOf(org.id)).toBe(9);
  });

  it('scheduled messages can be cancelled with a full refund', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 10 });
    const res = await request(app)
      .post('/api/v1/sms/send')
      .set(auth(token))
      .send({ senderId: sender.id, message: 'Later', recipients: ['0788123456', '0788123457'], scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(res.body.data.status).toBe('SCHEDULED');
    expect(await balanceOf(org.id)).toBe(8);
    expect((await request(app).post(`/api/v1/sms/${res.body.data.id}/cancel`).set(auth(token))).status).toBe(200);
    expect(await balanceOf(org.id)).toBe(10);
    expect((await request(app).post(`/api/v1/sms/${res.body.data.id}/cancel`).set(auth(token))).status).toBe(409);
  });
});
