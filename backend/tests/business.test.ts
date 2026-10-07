import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { PaymentProviderFactory } from '../src/integrations/payments/PaymentProviderFactory';
import type { SimulationPaymentProvider } from '../src/integrations/payments/SimulationPaymentProvider';
import { SmsProviderFactory } from '../src/integrations/sms/SmsProviderFactory';
import { financialSummary } from '../src/modules/finance/finance.service';
import { verifyAndApply } from '../src/modules/payments/payment.service';
import { adjustCapacity, purchaseCapacity } from '../src/modules/providers/provider.service';
import { invalidateSettingsCache } from '../src/modules/settings/settings.service';
import { dispatchMessage, pollPendingDeliveryStatuses } from '../src/modules/sms/sms.service';
import { deliverWebhook, emitWebhookEvent } from '../src/modules/webhooks/webhook.service';
import { SYSTEM_ACTOR } from '../src/types/actor';
import { encrypt, verifySignature } from '../src/utils/crypto';
import { addMember, app, balanceOf, createActiveOrg, createStaff, resetDatabase } from './helpers';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const provider = (code: string) => prisma.smsProvider.findUniqueOrThrow({ where: { code } });

beforeAll(resetDatabase);

describe('provider capacity', () => {
  it('a purchase creates a purchase record, a ledger entry and provider-side balance', async () => {
    const mtn = await provider('MTN');
    expect(mtn.capacityBalance).toBe(100_000);
    expect(mtn.totalSpent.toFixed(2)).toBe('800000.00');
    const purchase = await prisma.providerPurchase.findFirstOrThrow({ where: { providerId: mtn.id } });
    expect(purchase).toMatchObject({ status: 'SUCCESS', quantity: 100_000 });
    expect(purchase.reference).toMatch(/^PUR-\d{5}$/);
    const entry = await prisma.providerCapacityLedger.findUniqueOrThrow({ where: { reference: `purchase:${purchase.id}` } });
    expect(entry).toMatchObject({ type: 'PURCHASE', amount: 100_000, balanceBefore: 0, balanceAfter: 100_000 });
    const reported = await SmsProviderFactory.forProvider(mtn)!.getBalance();
    expect(reported.available).toBe(100_000);
  });

  it('super admin buys capacity over the API; unauthorised staff cannot', async () => {
    const sa = await createStaff('SUPER_ADMIN');
    const support = await createStaff('SUPPORT');
    const airtel = await provider('AIRTEL');
    expect((await request(app).post(`/api/v1/admin/providers/${airtel.id}/purchase`).set(auth(support.token)).send({ quantity: 1000 })).status).toBe(403);
    const res = await request(app).post(`/api/v1/admin/providers/${airtel.id}/purchase`).set(auth(sa.token)).send({ quantity: 10_000 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'SUCCESS', quantity: 10_000, totalCost: '85000.00' });
    expect((await provider('AIRTEL')).capacityBalance).toBe(110_000);
  });

  it('routes by prefix and deducts provider capacity together with the customer wallet', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 100 });
    const before = { mtn: (await provider('MTN')).capacityBalance, airtel: (await provider('AIRTEL')).capacityBalance, generic: (await provider('GENERIC')).capacityBalance };
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'x'.repeat(200), recipients: ['+250788100001', '+250728100002', '+447400123456'] });
    expect(res.status).toBe(201);
    expect(res.body.data.totalCredits).toBe(6); // 3 recipients × 2 segments
    expect(await balanceOf(org.id)).toBe(94);
    expect((await provider('MTN')).capacityBalance).toBe(before.mtn - 2);
    expect((await provider('AIRTEL')).capacityBalance).toBe(before.airtel - 2);
    expect((await provider('GENERIC')).capacityBalance).toBe(before.generic - 2);
    const recipients = await prisma.smsRecipient.findMany({ where: { messageId: res.body.data.id } });
    const byPhone = Object.fromEntries(recipients.map((r) => [r.phone, r]));
    expect(byPhone['+250788100001'].provider).toBe('mtn-simulation');
    expect(byPhone['+250728100002'].provider).toBe('airtel-simulation');
    expect(byPhone['+447400123456'].provider).toBe('generic-simulation');
    expect(Number(byPhone['+250788100001'].providerCost)).toBe(16); // 2 segments × WAC 8
  });

  it('refuses to send when no provider has capacity, charging nothing', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 1_000_000 });
    await prisma.smsProvider.updateMany({ data: { status: 'INACTIVE' } });
    try {
      const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'Hi', recipients: ['+250788100001'] });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PROVIDER_CAPACITY_UNAVAILABLE');
      expect(await balanceOf(org.id)).toBe(1_000_000);
    } finally {
      await prisma.smsProvider.updateMany({ data: { status: 'ACTIVE' } });
    }
  });

  it('does not oversell a provider beyond its capacity', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 1_000_000 });
    const generic = await provider('GENERIC');
    // Leave the catch-all aggregator (the only route for +44 numbers) with 5,000 SMS.
    await adjustCapacity(generic.id, { amount: 5_000 - generic.capacityBalance, reason: 'test: shrink capacity', reference: 'test-shrink' }, SYSTEM_ACTOR);
    const recipients = Array.from({ length: 1000 }, (_, i) => `+4474001${String(i + 1).padStart(5, '0')}`);
    const tooMany = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'x'.repeat(1530), recipients }); // 10 segments → 10,000 needed
    expect(tooMany.status).toBe(503);
    expect(tooMany.body.code).toBe('PROVIDER_CAPACITY_UNAVAILABLE');
    expect(await balanceOf(org.id)).toBe(1_000_000);
    expect((await provider('GENERIC')).capacityBalance).toBe(5_000);
    const fits = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'x'.repeat(760), recipients }); // 5 segments → 5,000
    expect(fits.status).toBe(201);
    expect((await provider('GENERIC')).capacityBalance).toBe(0);
    await adjustCapacity(generic.id, { amount: 100_000, reason: 'test: restore', reference: 'test-restore' }, SYSTEM_ACTOR);
  });

  it('releases capacity and refunds credits when a provider rejects a message', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 10 });
    const before = (await provider('MTN')).capacityBalance;
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'Hi', recipients: ['+250788120000'] });
    expect((await provider('MTN')).capacityBalance).toBe(before - 1);
    await dispatchMessage(res.body.data.id);
    expect((await provider('MTN')).capacityBalance).toBe(before);
    expect(await balanceOf(org.id)).toBe(10);
    const r = await prisma.smsRecipient.findFirstOrThrow({ where: { messageId: res.body.data.id } });
    expect(r).toMatchObject({ status: 'REJECTED', errorCode: 'INVALID_DESTINATION', capacityReleased: true, refunded: true });
  });

  it('delivers through the simulated network with delivery reports', async () => {
    const { token, sender } = await createActiveOrg({ credits: 10 });
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'Hi', recipients: ['+250788123456', '+250728129999'] });
    await dispatchMessage(res.body.data.id);
    await pollPendingDeliveryStatuses(0);
    const rs = await prisma.smsRecipient.findMany({ where: { messageId: res.body.data.id }, orderBy: { phone: 'asc' } });
    expect(rs.find((r) => r.phone === '+250788123456')).toMatchObject({ status: 'DELIVERED' });
    expect(rs.find((r) => r.phone === '+250788123456')!.providerMessageId).toMatch(/^MTN-/);
    expect(rs.find((r) => r.phone === '+250728129999')).toMatchObject({ status: 'FAILED', errorCode: 'ABSENT_SUBSCRIBER' });
    expect(rs.find((r) => r.phone === '+250728129999')!.providerMessageId).toMatch(/^ATL-/);
  });

  it('cancelling a scheduled send releases capacity and refunds credits', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 10 });
    const before = (await provider('MTN')).capacityBalance;
    const res = await request(app)
      .post('/api/v1/sms/send')
      .set(auth(token))
      .send({ senderId: sender.id, message: 'Later', recipients: ['+250788100010', '+250788100011'], scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await provider('MTN')).capacityBalance).toBe(before - 2);
    await request(app).post(`/api/v1/sms/${res.body.data.id}/cancel`).set(auth(token)).expect(200);
    expect((await provider('MTN')).capacityBalance).toBe(before);
    expect(await balanceOf(org.id)).toBe(10);
  });

  it('the capacity ledger is append-only', async () => {
    const e = await prisma.providerCapacityLedger.findFirstOrThrow();
    await expect(prisma.providerCapacityLedger.update({ where: { id: e.id }, data: { amount: 1 } })).rejects.toThrow(/append-only/);
  });
});

describe('finance', () => {
  it('records the sale, fee and contribution and computes profit from the ledgers', async () => {
    const from = new Date(Date.now() - 1000);
    const { org, token } = await createActiveOrg();
    const created = await request(app).post('/api/v1/payments').set(auth(token)).send({ quantity: 1000, method: 'MOBILE_MONEY', payerPhone: '0788123456' });
    const payment = created.body.data.payment;
    await (PaymentProviderFactory.getActive() as SimulationPaymentProvider).simulatePayerAction(payment.providerReference, 'APPROVE');
    await verifyAndApply(payment.id);
    await verifyAndApply(payment.id); // idempotent

    const sale = await prisma.customerPurchase.findUniqueOrThrow({ where: { paymentId: payment.id } });
    expect(sale.revenue.toFixed(2)).toBe('13000.00'); // 1,000 × RWF 13
    expect(sale.paymentFee.toFixed(2)).toBe('195.00'); // 1.5% mobile money (reported by the simulated gateway)
    expect(Number(sale.estimatedProviderCost)).toBeGreaterThan(0);
    expect(sale.contribution.toFixed(2)).toBe(sale.revenue.minus(sale.estimatedProviderCost).minus(sale.paymentFee).toFixed(2));
    expect(await prisma.customerPurchase.count({ where: { organizationId: org.id } })).toBe(1);

    const sa = await createStaff('SUPER_ADMIN');
    await request(app).post(`/api/v1/admin/providers/${(await provider('GENERIC')).id}/purchase`).set(auth(sa.token)).send({ quantity: 1000 }).expect(201); // 11,000
    await request(app)
      .post('/api/v1/admin/finance/expenses')
      .set(auth(sa.token))
      .send({ category: 'INFRASTRUCTURE', description: 'Hosting', amount: '2000', incurredAt: new Date().toISOString() })
      .expect(201);

    const s = await financialSummary(from, new Date());
    expect(s.money.revenue).toBe('13000.00');
    expect(s.money.providerSpend).toBe('11000.00');
    expect(s.money.grossMargin).toBe('2000.00');
    expect(s.money.paymentFees).toBe('195.00');
    expect(s.money.otherExpenses).toBe('2000.00');
    expect(s.money.netProfit).toBe('-195.00'); // 13000 − 11000 − 0 − 195 − 2000
    expect(s.sms.soldToCustomers).toBe(1000);
    expect(s.sms.purchasedFromProviders).toBe(1000);

    // Refund is recorded as its own ledger row and reduces profit.
    const finance = await createStaff('FINANCE');
    await request(app).post(`/api/v1/admin/billing/payments/${payment.id}/refund`).set(auth(finance.token)).send({ reason: 'Customer request' }).expect(200);
    const refund = await prisma.refund.findUniqueOrThrow({ where: { paymentId: payment.id } });
    expect(refund).toMatchObject({ creditsReversed: 1000 });
    const after = await financialSummary(from, new Date());
    expect(after.money.refunds).toBe('13000.00');
    expect(after.money.netProfit).toBe('-13195.00');
  });

  it('profit figures require profit.view; support cannot see finance at all', async () => {
    const admin = await createStaff('ADMIN'); // finance.view but not profit.view
    const res = await request(app).get('/api/v1/admin/finance/overview?range=all').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.money.revenue).toBeDefined();
    expect(res.body.data.money.netProfit).toBeNull();
    const support = await createStaff('SUPPORT');
    expect((await request(app).get('/api/v1/admin/finance/overview').set(auth(support.token))).status).toBe(403);
    const fin = await createStaff('FINANCE');
    const r2 = await request(app).get('/api/v1/admin/finance/overview?range=month').set(auth(fin.token));
    expect(r2.body.data.money.netProfit).not.toBeNull();
  });
});

describe('webhooks', () => {
  let server: http.Server;
  let url = '';
  let mode: 'ok' | 'fail' = 'ok';
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = mode === 'ok' ? 200 : 500;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => server.close());

  async function hookFor(orgId: string, userId: string) {
    return prisma.webhook.create({ data: { organizationId: orgId, url, events: ['sms.delivered', 'wallet.low_balance'], secretEncrypted: encrypt('whsec_test'), createdById: userId } });
  }

  it('signs deliveries with HMAC, timestamp and event id', async () => {
    const { org, user } = await createActiveOrg();
    await hookFor(org.id, user.id);
    await emitWebhookEvent(org.id, 'sms.delivered', { messageId: 'x' }, 'evt_sign_1');
    const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { organizationId: org.id } });
    await deliverWebhook(d.id);
    const got = received.at(-1)!;
    expect(verifySignature('whsec_test', got.body, String(got.headers['x-smsgateway-signature']))).toBe(true);
    expect(verifySignature('wrong', got.body, String(got.headers['x-smsgateway-signature']))).toBe(false);
    expect(JSON.parse(got.body)).toMatchObject({ id: 'evt_sign_1', type: 'sms.delivered' });
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('SUCCESS');
  });

  it('retries failing endpoints with backoff and gives up after 6 attempts', async () => {
    const { org, user } = await createActiveOrg();
    await hookFor(org.id, user.id);
    mode = 'fail';
    await emitWebhookEvent(org.id, 'sms.delivered', { messageId: 'y' }, 'evt_retry_1');
    const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { organizationId: org.id } });
    await deliverWebhook(d.id);
    let row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: 'RETRYING', attempts: 1, responseStatus: 500 });
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    for (let i = 0; i < 5; i++) await deliverWebhook(d.id);
    row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: 'FAILED', attempts: 6 });
    mode = 'ok';
  });

  it('events are deduplicated by event id', async () => {
    const { org, user } = await createActiveOrg();
    await hookFor(org.id, user.id);
    await emitWebhookEvent(org.id, 'sms.delivered', {}, 'evt_dup');
    await emitWebhookEvent(org.id, 'sms.delivered', {}, 'evt_dup');
    expect(await prisma.webhookDelivery.count({ where: { organizationId: org.id } })).toBe(1);
  });
});

describe('business verification lifecycle', () => {
  async function registerAndSubmit(email: string) {
    const reg = await request(app).post('/api/v1/auth/register').send({ fullName: 'Owner', email, password: 'Secret123', organizationName: 'Verify Co' });
    const token = reg.body.data.accessToken;
    const mail = await prisma.emailMessage.findFirstOrThrow({ where: { to: email } });
    await request(app).post('/api/v1/auth/verify-email').send({ token: /token=([\w-]+)/.exec(mail.text)![1] }).expect(200);
    await request(app)
      .patch('/api/v1/organization')
      .set(auth(token))
      .send({ businessType: 'Retail / E-commerce', country: 'Rwanda', address: 'KN 1', registrationNumber: 'R-1', contactPersonName: 'Owner', contactPersonPhone: '0788555111', smsPurpose: 'Order notifications' })
      .expect(200);
    for (const type of ['BUSINESS_REGISTRATION', 'IDENTIFICATION']) {
      await request(app).post('/api/v1/verification/documents').set(auth(token)).field('documentType', type).attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'doc.pdf', contentType: 'application/pdf' }).expect(201);
    }
    const sub = await request(app).post('/api/v1/verification/submit').set(auth(token));
    expect(sub.status).toBe(200);
    return { token, verificationId: sub.body.data.verification.id as string };
  }

  it('admin-configured requirements: link / text / select answers and per-item file rules', async () => {
    const admin = await createStaff('ADMIN');
    const requirements = [
      { type: 'BUSINESS_REGISTRATION', label: 'Certificate', required: true, kind: 'FILE', allowedFormats: ['PNG'], maxSizeMb: 1 },
      { type: 'WEBSITE', label: 'Website', required: true, kind: 'URL' },
      { type: 'TIN', label: 'Tax number', required: false, kind: 'TEXT', maxLength: 9 },
      { type: 'SECTOR', label: 'Sector', required: false, kind: 'SELECT', options: ['Retail', 'Bank'] },
    ];
    await request(app).put('/api/v1/admin/settings/verification.requiredDocuments').set(auth(admin.token)).send({ value: requirements }).expect(200);
    invalidateSettingsCache();

    const reg = await request(app).post('/api/v1/auth/register').send({ fullName: 'Owner', email: 'kinds@test.local', password: 'Secret123', organizationName: 'Kinds Co' });
    const token = reg.body.data.accessToken;
    const mail = await prisma.emailMessage.findFirstOrThrow({ where: { to: 'kinds@test.local' } });
    await request(app).post('/api/v1/auth/verify-email').send({ token: /token=([\w-]+)/.exec(mail.text)![1] }).expect(200);

    const value = (documentType: string, v: string) => request(app).post('/api/v1/verification/documents/value').set(auth(token)).send({ documentType, value: v });
    expect((await value('WEBSITE', 'not a link')).status).toBe(422);
    expect((await value('TIN', '0123456789')).status).toBe(422);
    expect((await value('SECTOR', 'Mining')).status).toBe(422);
    expect((await value('BUSINESS_REGISTRATION', 'x')).status).toBe(422);
    expect((await value('WEBSITE', 'example.com')).body.data.value).toBe('https://example.com/');
    await value('WEBSITE', 'https://example.org').then((r) => expect(r.status).toBe(201));
    expect(await prisma.verificationDocument.count({ where: { documentType: 'WEBSITE' } })).toBe(1); // replaced, not duplicated

    const pdf = await request(app).post('/api/v1/verification/documents').set(auth(token)).field('documentType', 'BUSINESS_REGISTRATION').attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(pdf.status).toBe(422); // only PNG allowed for this item
    expect((await request(app).post('/api/v1/verification/documents').set(auth(token)).field('documentType', 'WEBSITE').attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'doc.pdf', contentType: 'application/pdf' })).status).toBe(422);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    await request(app).post('/api/v1/verification/documents').set(auth(token)).field('documentType', 'BUSINESS_REGISTRATION').attach('file', png, { filename: 'c.png', contentType: 'image/png' }).expect(201);

    const overview = await request(app).get('/api/v1/verification').set(auth(token)).expect(200);
    expect(overview.body.data.missingDocuments).toEqual([]);
  });

  it('submit → more information → resubmit → approve, with review history', async () => {
    const { token, verificationId } = await registerAndSubmit('lifecycle1@test.local');
    const admin = await createStaff('ADMIN');
    const ask = await request(app).post(`/api/v1/admin/verifications/${verificationId}/decision`).set(auth(admin.token)).send({ decision: 'REQUEST_INFORMATION', note: 'Upload a clearer ID' });
    expect(ask.status).toBe(200);
    expect((await prisma.verification.findUniqueOrThrow({ where: { id: verificationId } })).status).toBe('MORE_INFORMATION_REQUIRED');
    await request(app).post('/api/v1/verification/submit').set(auth(token)).expect(200);
    await request(app).post(`/api/v1/admin/verifications/${verificationId}/decision`).set(auth(admin.token)).send({ decision: 'APPROVE' }).expect(200);
    const v = await prisma.verification.findUniqueOrThrow({ where: { id: verificationId }, include: { reviews: true, organization: true } });
    expect(v.status).toBe('APPROVED');
    expect(v.organization.status).toBe('ACTIVE');
    expect(v.reviews.map((r) => r.action).sort()).toEqual(['APPROVE', 'REQUEST_INFORMATION']);
    expect(await prisma.auditLog.count({ where: { organizationId: v.organizationId, action: 'BUSINESS_APPROVED' } })).toBe(1);
  });

  it('reject and suspension are reflected on the verification; suspended orgs cannot send', async () => {
    const { verificationId } = await registerAndSubmit('lifecycle2@test.local');
    const admin = await createStaff('ADMIN');
    await request(app).post(`/api/v1/admin/verifications/${verificationId}/decision`).set(auth(admin.token)).send({ decision: 'REJECT', note: 'Documents do not match' }).expect(200);
    expect((await prisma.verification.findUniqueOrThrow({ where: { id: verificationId } })).status).toBe('REJECTED');

    const { org, token, sender } = await createActiveOrg({ credits: 10 });
    const ver = await prisma.verification.create({ data: { organizationId: org.id, status: 'APPROVED' } });
    await request(app).post(`/api/v1/admin/organizations/${org.id}/status`).set(auth(admin.token)).send({ action: 'suspend', reason: 'Spam complaints' }).expect(200);
    expect((await prisma.verification.findUniqueOrThrow({ where: { id: ver.id } })).status).toBe('SUSPENDED');
    const send = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'x', recipients: ['+250788100001'] });
    expect(send.body.code).toBe('ORGANIZATION_SUSPENDED');
    await request(app).post(`/api/v1/admin/organizations/${org.id}/status`).set(auth(admin.token)).send({ action: 'reactivate' }).expect(200);
    expect((await prisma.verification.findUniqueOrThrow({ where: { id: ver.id } })).status).toBe('APPROVED');
  });

  it('verification documents are private to the organization and staff', async () => {
    const { token } = await registerAndSubmit('lifecycle3@test.local');
    const doc = await prisma.verificationDocument.findFirstOrThrow({ where: { organization: { members: { some: { user: { email: 'lifecycle3@test.local' } } } } } });
    expect((await request(app).get(`/api/v1/verification/documents/${doc.id}/download`).set(auth(token))).status).toBe(200);
    const other = await createActiveOrg();
    expect((await request(app).get(`/api/v1/verification/documents/${doc.id}/download`).set(auth(other.token))).status).toBe(404);
    const admin = await createStaff('ADMIN');
    expect((await request(app).get(`/api/v1/admin/verifications/documents/${doc.id}/download`).set(auth(admin.token))).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'DOCUMENT_VIEWED', resourceId: doc.id } })).toBe(1);
  });
});

describe('customer roles & developer API', () => {
  it('developer role manages API keys but cannot buy credits; finance role buys but cannot send', async () => {
    const { org } = await createActiveOrg({ credits: 10 });
    const dev = await addMember(org.id, 'CUSTOMER_DEVELOPER');
    const fin = await addMember(org.id, 'CUSTOMER_FINANCE');
    expect((await request(app).post('/api/v1/developer/api-keys').set(auth(dev.token)).send({ name: 'CI key' })).status).toBe(201);
    expect((await request(app).post('/api/v1/payments').set(auth(dev.token)).send({ quantity: 1000, method: 'CARD' })).status).toBe(403);
    expect((await request(app).post('/api/v1/payments').set(auth(fin.token)).send({ quantity: 1000, method: 'CARD' })).status).toBe(201);
    expect((await request(app).post('/api/v1/developer/api-keys').set(auth(fin.token)).send({ name: 'x key' })).status).toBe(403);
  });

  it('accepts {senderId, to}, and disabled keys are refused', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 10 });
    const key = await request(app).post('/api/v1/developer/api-keys').set(auth(token)).send({ name: 'App', environment: 'staging' });
    expect(key.body.data.apiKey).toMatchObject({ environment: 'staging', status: 'ACTIVE' });
    const secret = key.body.data.secret;
    const sent = await request(app).post('/api/v1/public/sms/send').set(auth(secret)).send({ senderId: sender.name, to: ['+250788123456'], message: 'Your order is ready.' });
    expect(sent.status).toBe(201);
    expect(sent.body.messageId).toBeTruthy();
    expect(await balanceOf(org.id)).toBe(9);
    await request(app).post(`/api/v1/developer/api-keys/${key.body.data.apiKey.id}/disable`).set(auth(token)).expect(200);
    const blocked = await request(app).get('/api/v1/public/balance').set(auth(secret));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('API_KEY_DISABLED');
    await request(app).post(`/api/v1/developer/api-keys/${key.body.data.apiKey.id}/enable`).set(auth(token)).expect(200);
    expect((await request(app).get('/api/v1/public/balance').set(auth(secret))).status).toBe(200);
  });

  it('an API key can never reach another organization', async () => {
    const a = await createActiveOrg({ credits: 10 });
    const b = await createActiveOrg({ credits: 10 });
    const key = await request(app).post('/api/v1/developer/api-keys').set(auth(a.token)).send({ name: 'A' });
    const res = await request(app).post('/api/v1/public/sms/send').set(auth(key.body.data.secret)).send({ senderId: b.sender.name, to: '+250788123456', message: 'x' });
    expect(res.body.code).toBe('SENDER_NOT_FOUND');
    const msg = await request(app).post('/api/v1/sms/send').set(auth(b.token)).send({ senderId: b.sender.id, message: 'B only', recipients: ['+250788123456'] });
    const recipient = await prisma.smsRecipient.findFirstOrThrow({ where: { messageId: msg.body.data.id } });
    expect((await request(app).get(`/api/v1/public/sms/${recipient.id}`).set(auth(key.body.data.secret))).status).toBe(404);
  });

  it('enforces the per-organization hourly sending limit', async () => {
    const { token, sender, org } = await createActiveOrg({ credits: 100 });
    await prisma.organization.update({ where: { id: org.id }, data: { smsHourlyLimit: 2 } });
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'x', recipients: ['+250788100001', '+250788100002', '+250788100003'] });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('SMS_RATE_LIMITED');
  });
});

describe('public website', () => {
  it('lists active price ranges without authentication and stores contact inquiries', async () => {
    const pk = await request(app).get('/api/v1/site/pricing');
    expect(pk.status).toBe(200);
    expect(pk.body.data[0]).toMatchObject({ minQuantity: 1, maxQuantity: 1000, unitPrice: '13.00' });
    const c = await request(app).post('/api/v1/site/contact').send({ name: 'Jane', email: 'jane@school.rw', message: 'We would like a quote for 50k SMS.' });
    expect(c.status).toBe(201);
    const support = await createStaff('SUPPORT');
    const list = await request(app).get('/api/v1/admin/inquiries').set(auth(support.token));
    expect(list.body.data.some((i: { email: string }) => i.email === 'jane@school.rw')).toBe(true);
  });
});

describe('purchasing capacity through the service directly', () => {
  it('rejects orders the provider cannot fulfil and records the failure', async () => {
    const mtn = await provider('MTN');
    const p = await purchaseCapacity(mtn.id, { quantity: 6_000_000 }, SYSTEM_ACTOR);
    expect(p.status).toBe('FAILED');
    expect(p.failureReason).toMatch(/ORDER_LIMIT_EXCEEDED/);
    expect((await provider('MTN')).totalPurchased).toBe(mtn.totalPurchased);
  });
});
