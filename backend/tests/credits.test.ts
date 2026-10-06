import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { PaymentProviderFactory } from '../src/integrations/payments/PaymentProviderFactory';
import type { SimulationPaymentProvider } from '../src/integrations/payments/SimulationPaymentProvider';
import { handleProviderWebhook, verifyAndApply } from '../src/modules/payments/payment.service';
import { dispatchMessage } from '../src/modules/sms/sms.service';
import { applyLedgerEntry, expireCreditLots } from '../src/modules/wallet/wallet.service';
import { env } from '../src/config/env';
import { signPayload } from '../src/utils/crypto';
import { addMember, app, balanceOf, createActiveOrg, createStaff, resetDatabase } from './helpers';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const simulator = () => PaymentProviderFactory.getActive() as SimulationPaymentProvider;
let superToken = '';
const tierIds: Record<string, string> = {};

async function credit(organizationId: string, amount: number) {
  await prisma.$transaction((tx) => applyLedgerEntry(tx, { organizationId, type: 'ADMIN_CREDIT', amount, reference: `t:${crypto.randomUUID()}`, description: 'Test credit' }));
}

async function sumLots(organizationId: string) {
  return (await prisma.smsCreditLot.aggregate({ where: { organizationId }, _sum: { remaining: true } }))._sum.remaining ?? 0;
}

let phoneSeq = 1000;
/** Fresh valid MTN numbers (never ending in 0000/8888/9999, which the simulator treats specially). */
const phones = (n: number) => Array.from({ length: n }, () => `+25078${String(1_000_000 + phoneSeq++ * 7).slice(-7).replace(/0000$/, '0001')}`);

async function approvedSender(organizationId: string, name: string) {
  const owner = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId, isOwner: true } });
  return prisma.senderId.create({ data: { organizationId, name, purpose: 'Testing purposes', status: 'APPROVED', requestedById: owner.userId } });
}

const send = (token: string, senderId: string, recipients: string[], message = 'Hello') => request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId, message, recipients });

beforeAll(async () => {
  await resetDatabase();
  superToken = (await createStaff('SUPER_ADMIN')).token;
  // resetDatabase creates the default ranges (13 / 11 / 9 / 8).
  const tiers = await request(app).get('/api/v1/admin/pricing/tiers').set(auth(superToken));
  for (const t of tiers.body.data as { id: string; name: string }[]) tierIds[t.name] = t.id;
  expect(Object.keys(tierIds)).toEqual(['Starter', 'Growth', 'Business', 'Volume']);
});

describe('pricing engine', () => {
  it.each([
    [1, '13.00', '13.00', '1–1,000'],
    [500, '13.00', '6500.00', '1–1,000'],
    [1000, '13.00', '13000.00', '1–1,000'],
    [1001, '11.00', '11011.00', '1,001–5,000'],
    [2000, '11.00', '22000.00', '1,001–5,000'],
    [5000, '11.00', '55000.00', '1,001–5,000'],
    [5001, '9.00', '45009.00', '5,001–10,000'],
    [7500, '9.00', '67500.00', '5,001–10,000'],
    [10000, '9.00', '90000.00', '5,001–10,000'],
    [10001, '8.00', '80008.00', '10,001+'],
    [50000, '8.00', '400000.00', '10,001+'],
  ])('%i SMS → RWF %s each, total %s (tier %s)', async (quantity, unit, total, label) => {
    const { token } = await createActiveOrg();
    const res = await request(app).get(`/api/v1/pricing/quote?quantity=${quantity}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ quantity, unitPrice: unit, total, currency: 'RWF', tier: { label } });
  });

  it('reports savings against the highest tier price', async () => {
    const { token } = await createActiveOrg();
    const res = await request(app).get('/api/v1/pricing/quote?quantity=7500').set(auth(token));
    expect(res.body.data.savings).toEqual({ comparedToUnitPrice: '13.00', amount: '30000.00', percent: 30.8 });
    expect((await request(app).get('/api/v1/pricing/quote?quantity=10').set(auth(token))).body.data.savings).toBeNull();
  });

  it.each(['0', '-5', '1.5', 'abc', '200000000'])('rejects quantity %s', async (q) => {
    const { token } = await createActiveOrg();
    const res = await request(app).get(`/api/v1/pricing/quote?quantity=${q}`).set(auth(token));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_QUANTITY');
  });
});

describe('pricing tier administration', () => {
  it('prevents overlapping active tiers and invalid ranges', async () => {
    const overlap = await request(app).post('/api/v1/admin/pricing/tiers').set(auth(superToken)).send({ minQuantity: 900, maxQuantity: 1200, unitPrice: '12' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('TIER_OVERLAP');
    const inverted = await request(app).post('/api/v1/admin/pricing/tiers').set(auth(superToken)).send({ minQuantity: 50, maxQuantity: 10, unitPrice: '12', isActive: false });
    expect(inverted.status).toBe(422);
    // An inactive overlapping tier is allowed (drafting a new price list), activating it is not.
    const draft = await request(app).post('/api/v1/admin/pricing/tiers').set(auth(superToken)).send({ minQuantity: 900, maxQuantity: 1200, unitPrice: '12', isActive: false });
    expect(draft.status).toBe(201);
    expect((await request(app).patch(`/api/v1/admin/pricing/tiers/${draft.body.data.id}`).set(auth(superToken)).send({ isActive: true })).body.code).toBe('TIER_OVERLAP');
    expect((await request(app).delete(`/api/v1/admin/pricing/tiers/${draft.body.data.id}`).set(auth(superToken))).status).toBe(200);
  });

  it('only staff with packages.manage can change pricing; customers cannot reach admin pricing', async () => {
    const { token } = await createActiveOrg();
    expect((await request(app).get('/api/v1/admin/pricing/tiers').set(auth(token))).status).toBe(403);
    expect((await request(app).post('/api/v1/admin/pricing/tiers').set(auth(token)).send({ minQuantity: 1, unitPrice: '1' })).status).toBe(403);
    const finance = await createStaff('FINANCE');
    expect((await request(app).get('/api/v1/admin/pricing/tiers').set(auth(finance.token))).status).toBe(200);
    expect((await request(app).patch(`/api/v1/admin/pricing/tiers/${tierIds.Starter}`).set(auth(finance.token)).send({ unitPrice: '1' })).status).toBe(403);
  });
});

describe('buying any quantity', () => {
  async function buy(token: string, quantity: number, extra: Record<string, unknown> = {}) {
    const res = await request(app).post('/api/v1/payments').set(auth(token)).send({ quantity, method: 'MOBILE_MONEY', payerPhone: '0788123456', ...extra });
    expect(res.status).toBe(201);
    return res.body.data.payment as { id: string; providerReference: string; amount: string; credits: number; unitPrice: string; tierMinQuantity: number; tierMaxQuantity: number | null };
  }

  it('prices on the server, ignores client prices and snapshots the tier', async () => {
    const { token } = await createActiveOrg();
    const p = await buy(token, 7500, { price: 1, amount: '1', unitPrice: '0.01', credits: 999999 });
    expect(p).toMatchObject({ amount: '67500.00', credits: 7500, unitPrice: '9.00', tierMinQuantity: 5001, tierMaxQuantity: 10000 });
  });

  it('pending and failed payments credit nothing; success credits once, even with duplicate webhooks', async () => {
    const { org, token } = await createActiveOrg();
    const pending = await buy(token, 2000);
    await verifyAndApply(pending.id);
    expect(await balanceOf(org.id)).toBe(0);

    const failed = await buy(token, 300);
    await simulator().simulatePayerAction(failed.providerReference, 'DECLINE');
    await verifyAndApply(failed.id);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('FAILED');
    expect(await balanceOf(org.id)).toBe(0);

    await simulator().simulatePayerAction(pending.providerReference, 'APPROVE');
    const body = JSON.stringify({ event_id: `evt_${pending.id}`, type: 'payment.succeeded', data: { transaction_ref: pending.providerReference } });
    const headers = { 'x-simpay-signature': signPayload(env.PAYMENT_WEBHOOK_SECRET, body) };
    await Promise.all([handleProviderWebhook('simulation', headers, body), verifyAndApply(pending.id), verifyAndApply(pending.id)]);
    await handleProviderWebhook('simulation', headers, body);
    expect(await balanceOf(org.id)).toBe(2000);

    const ledger = await prisma.walletTransaction.findMany({ where: { organizationId: org.id, type: 'PURCHASE' } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: 2000, balanceAfter: 2000, description: 'Purchased 2,000 SMS credits at RWF 11.00' });
    const lot = await prisma.smsCreditLot.findUniqueOrThrow({ where: { sourceTransactionId: ledger[0].id } });
    expect(lot).toMatchObject({ credits: 2000, remaining: 2000 });
    expect(Math.round((lot.expiresAt!.getTime() - Date.now()) / 86_400_000)).toBe(365);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { paymentId: pending.id } });
    expect(invoice.total.toFixed(2)).toBe('22000.00');
    const sale = await prisma.customerPurchase.findUniqueOrThrow({ where: { paymentId: pending.id } });
    expect(sale.revenue.toFixed(2)).toBe('22000.00');
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: 'SMS_PACKAGE_PURCHASED' } })).toBe(1);
  });

  it('keeps the historical price when the tier price changes later', async () => {
    const { token } = await createActiveOrg();
    const p = await buy(token, 6000);
    await simulator().simulatePayerAction(p.providerReference, 'APPROVE');
    await verifyAndApply(p.id);
    expect((await request(app).patch(`/api/v1/admin/pricing/tiers/${tierIds.Business}`).set(auth(superToken)).send({ unitPrice: '8.50' })).status).toBe(200);
    const after = await request(app).get(`/api/v1/payments/${p.id}`).set(auth(token));
    expect(after.body.data).toMatchObject({ unitPrice: '9.00', amount: '54000.00' });
    expect((await request(app).get('/api/v1/pricing/quote?quantity=6000').set(auth(token))).body.data.total).toBe('51000.00');
    // A tier used by purchases cannot be deleted, only deactivated.
    expect((await request(app).delete(`/api/v1/admin/pricing/tiers/${tierIds.Business}`).set(auth(superToken))).body.code).toBe('TIER_IN_USE');
    await request(app).patch(`/api/v1/admin/pricing/tiers/${tierIds.Business}`).set(auth(superToken)).send({ unitPrice: '9' }).expect(200);
  });

  it('customers only see their own purchases', async () => {
    const a = await createActiveOrg();
    const b = await createActiveOrg();
    const p = await buy(a.token, 100);
    expect((await request(app).get(`/api/v1/payments/${p.id}`).set(auth(b.token))).status).toBe(404);
    expect((await request(app).get('/api/v1/payments').set(auth(b.token))).body.data).toHaveLength(0);
  });
});

describe('credit lots (FEFO and expiry)', () => {
  it('consumes the soonest-expiring credits first and keeps balance = Σ lots', async () => {
    const { org, token, sender } = await createActiveOrg();
    await credit(org.id, 50); // non-expiring
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: org.id } });
    const soon = await prisma.$transaction((tx) =>
      applyLedgerEntry(tx, { organizationId: org.id, type: 'PURCHASE', amount: 30, reference: `t:soon:${org.id}`, description: 'Soon', expiresAt: new Date(Date.now() + 5 * 86_400_000) }),
    );
    await send(token, sender.id, phones(40)).expect(201);
    const lots = await prisma.smsCreditLot.findMany({ where: { walletId: wallet.id } });
    expect(lots.find((l) => l.sourceTransactionId === soon.transaction.id)!.remaining).toBe(0);
    expect(lots.find((l) => l.expiresAt === null)!.remaining).toBe(40);
    expect(await balanceOf(org.id)).toBe(40);
    expect(await sumLots(org.id)).toBe(40);

    const wallet2 = await request(app).get('/api/v1/wallet').set(auth(token));
    expect(wallet2.body.data.expiringSoon.credits).toBe(0);
  });

  it('expires lots with an EXPIRATION ledger entry, without deleting history', async () => {
    const { org, token } = await createActiveOrg();
    await credit(org.id, 10);
    const r = await prisma.$transaction((tx) =>
      applyLedgerEntry(tx, { organizationId: org.id, type: 'PURCHASE', amount: 25, reference: `t:exp:${org.id}`, description: 'Old', expiresAt: new Date(Date.now() + 86_400_000) }),
    );
    expect((await request(app).get('/api/v1/wallet').set(auth(token))).body.data.expiringSoon.credits).toBe(25);
    await prisma.smsCreditLot.update({ where: { sourceTransactionId: r.transaction.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireCreditLots();
    await expireCreditLots(); // idempotent
    expect(await balanceOf(org.id)).toBe(10);
    const exp = await prisma.walletTransaction.findMany({ where: { organizationId: org.id, type: 'EXPIRATION' } });
    expect(exp).toHaveLength(1);
    expect(exp[0].amount).toBe(-25);
    const lot = await prisma.smsCreditLot.findUniqueOrThrow({ where: { sourceTransactionId: r.transaction.id } });
    expect(lot).toMatchObject({ credits: 25, remaining: 0 });
    expect(lot.expiredAt).not.toBeNull();
    expect(await sumLots(org.id)).toBe(10);
    expect(await prisma.notification.count({ where: { organizationId: org.id, type: 'CREDITS_EXPIRED' } })).toBeGreaterThan(0);
  });

  it('a refund returns credits to the lot they came from', async () => {
    const { org, token, sender } = await createActiveOrg();
    const r = await prisma.$transaction((tx) =>
      applyLedgerEntry(tx, { organizationId: org.id, type: 'PURCHASE', amount: 10, reference: `t:ref:${org.id}`, description: 'Lot', expiresAt: new Date(Date.now() + 9 * 86_400_000) }),
    );
    const res = await send(token, sender.id, ['+250788130000', ...phones(1)]).expect(201); // …0000 is rejected by the simulator
    await dispatchMessage(res.body.data.id);
    expect(await balanceOf(org.id)).toBe(9);
    const lot = await prisma.smsCreditLot.findUniqueOrThrow({ where: { sourceTransactionId: r.transaction.id } });
    expect(lot.remaining).toBe(9);
    expect(await prisma.smsCreditLot.count({ where: { organizationId: org.id } })).toBe(1);
  });
});

describe('sender ID allocations', () => {
  it('reserves real wallet credits and never allows more than the balance', async () => {
    const { org, token } = await createActiveOrg();
    await credit(org.id, 10_000);
    const study = await approvedSender(org.id, `STUDY${phoneSeq}`);
    const promo = await approvedSender(org.id, `PROMO${phoneSeq}`);
    const alerts = await approvedSender(org.id, `ALERT${phoneSeq}`);
    const put = (id: string, allocated: number) => request(app).put(`/api/v1/senders/${id}/allocation`).set(auth(token)).send({ allocated });
    expect((await put(study.id, 5000)).status).toBe(200);
    expect((await put(promo.id, 3000)).status).toBe(200);
    const tooMuch = await put(alerts.id, 3000);
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.code).toBe('ALLOCATION_EXCEEDS_BALANCE');
    expect((await put(promo.id, 8000)).body.code).toBe('ALLOCATION_EXCEEDS_BALANCE');
    expect((await put(alerts.id, 2000)).status).toBe(200);
    const overview = await request(app).get('/api/v1/senders/allocations').set(auth(token));
    expect(overview.body.data).toMatchObject({ balance: 10_000, reserved: 10_000, unallocated: 0 });
    expect(await balanceOf(org.id)).toBe(10_000); // no credits created
  });

  it('draws allocated sends from the allocation and the wallet once; unallocated sends use only free credits', async () => {
    const { org, token, sender: free } = await createActiveOrg();
    await credit(org.id, 1000);
    const study = await approvedSender(org.id, `STU${phoneSeq}`);
    await request(app).put(`/api/v1/senders/${study.id}/allocation`).set(auth(token)).send({ allocated: 900 }).expect(200);

    await send(token, study.id, phones(100), 'x'.repeat(200)).expect(201); // 100 × 2 segments
    expect(await balanceOf(org.id)).toBe(800);
    const a = await prisma.senderIdAllocation.findUniqueOrThrow({ where: { senderId: study.id } });
    expect(a).toMatchObject({ allocated: 900, used: 200 });

    // 1000 − 200 used = 800 in the wallet; 700 still reserved for the allocation → 100 free.
    const blocked = await send(token, free.id, phones(101));
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe('INSUFFICIENT_CREDITS');
    await send(token, free.id, phones(100)).expect(201);
    expect(await balanceOf(org.id)).toBe(700);

    const exhausted = await send(token, study.id, phones(701));
    expect(exhausted.status).toBe(402);
    expect(exhausted.body.code).toBe('ALLOCATION_EXHAUSTED');
    expect(await balanceOf(org.id)).toBe(700);
  });

  it('refunded messages give credits back to the allocation', async () => {
    const { org, token } = await createActiveOrg();
    await credit(org.id, 100);
    const s = await approvedSender(org.id, `REF${phoneSeq}`);
    await request(app).put(`/api/v1/senders/${s.id}/allocation`).set(auth(token)).send({ allocated: 50 }).expect(200);
    const res = await send(token, s.id, ['+250788140000', ...phones(2)]).expect(201);
    await dispatchMessage(res.body.data.id);
    expect((await prisma.senderIdAllocation.findUniqueOrThrow({ where: { senderId: s.id } })).used).toBe(2);
    expect(await balanceOf(org.id)).toBe(98);
  });

  it('sends one reminder per threshold crossed, and re-arms after a top-up', async () => {
    const { org, token } = await createActiveOrg();
    await credit(org.id, 1000);
    const s = await approvedSender(org.id, `LOW${phoneSeq}`);
    await request(app).put(`/api/v1/senders/${s.id}/allocation`).set(auth(token)).send({ allocated: 100, alertThresholds: [50, 20] }).expect(200);
    const count = () => prisma.notification.count({ where: { organizationId: org.id, type: 'SENDER_ALLOCATION_LOW' } });
    await send(token, s.id, phones(40)).expect(201); // 60% left
    expect(await count()).toBe(0);
    await send(token, s.id, phones(15)).expect(201); // 45% → 50% reminder
    expect(await count()).toBe(1);
    await send(token, s.id, phones(1)).expect(201); // 44% → nothing new
    await send(token, s.id, phones(1)).expect(201);
    expect(await count()).toBe(1);
    await send(token, s.id, phones(30)).expect(201); // 13% → 20% reminder
    expect(await count()).toBe(2);
    const n = await prisma.notification.findFirstOrThrow({ where: { organizationId: org.id, type: 'SENDER_ALLOCATION_LOW' }, orderBy: { createdAt: 'desc' } });
    expect(n.body).toContain('You have 13 SMS credits remaining');
    // Top-up re-arms; the next dip notifies again.
    await request(app).put(`/api/v1/senders/${s.id}/allocation`).set(auth(token)).send({ allocated: 300 }).expect(200);
    expect(await count()).toBe(2);
    expect((await prisma.senderIdAllocation.findUniqueOrThrow({ where: { senderId: s.id } })).lastAlertThreshold).toBeNull();
  });

  it('removing an allocation releases its reservation but keeps history', async () => {
    const { org, token, sender: free } = await createActiveOrg();
    await credit(org.id, 100);
    const s = await approvedSender(org.id, `RM${phoneSeq}`);
    await request(app).put(`/api/v1/senders/${s.id}/allocation`).set(auth(token)).send({ allocated: 100 }).expect(200);
    expect((await send(token, free.id, phones(1))).status).toBe(402);
    await request(app).delete(`/api/v1/senders/${s.id}/allocation`).set(auth(token)).expect(200);
    await send(token, free.id, phones(1)).expect(201);
    expect(await prisma.senderIdAllocation.findUniqueOrThrow({ where: { senderId: s.id } })).toMatchObject({ isActive: false, allocated: 100 });
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: { in: ['SENDER_ALLOCATION_SET', 'SENDER_ALLOCATION_REMOVED'] } } })).toBe(2);
  });

  it('is tenant-isolated and permission-checked', async () => {
    const a = await createActiveOrg();
    const b = await createActiveOrg();
    await credit(a.org.id, 100);
    await credit(b.org.id, 100);
    const res = await request(app).put(`/api/v1/senders/${a.sender.id}/allocation`).set(auth(b.token)).send({ allocated: 10 });
    expect(res.status).toBe(404);
    expect((await request(app).delete(`/api/v1/senders/${a.sender.id}/allocation`).set(auth(b.token))).status).toBe(404);
    await request(app).put(`/api/v1/senders/${a.sender.id}/allocation`).set(auth(a.token)).send({ allocated: 10 }).expect(200);
    expect((await request(app).get('/api/v1/senders/allocations').set(auth(b.token))).body.data.allocations).toHaveLength(0);
    const staff = await addMember(a.org.id, 'CUSTOMER_STAFF');
    expect((await request(app).put(`/api/v1/senders/${a.sender.id}/allocation`).set(auth(staff.token)).send({ allocated: 20 })).status).toBe(403);
    // Unapproved sender IDs cannot receive allocations.
    const pending = await prisma.senderId.update({ where: { id: a.sender.id }, data: { status: 'PENDING' } });
    expect((await request(app).put(`/api/v1/senders/${pending.id}/allocation`).set(auth(a.token)).send({ allocated: 20 })).body.code).toBe('SENDER_NOT_APPROVED');
  });
});

describe('providers', () => {
  it('only providers.manage can create providers; new providers start inactive', async () => {
    const body = { code: 'TIGO', name: 'Tigo Test', type: 'MNO', currency: 'RWF', costPerSms: '7' };
    const { token } = await createActiveOrg();
    expect((await request(app).post('/api/v1/admin/providers').set(auth(token)).send(body)).status).toBe(403);
    const finance = await createStaff('FINANCE');
    expect((await request(app).post('/api/v1/admin/providers').set(auth(finance.token)).send(body)).status).toBe(403);
    const res = await request(app).post('/api/v1/admin/providers').set(auth(superToken)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'TIGO', status: 'INACTIVE', capacityBalance: 0, adapterInstalled: false });
    expect((await request(app).post('/api/v1/admin/providers').set(auth(superToken)).send(body)).status).toBe(409);
    expect((await request(app).get('/api/v1/admin/providers').set(auth(token))).status).toBe(403);
  });

  it('keeps the provider cost of sent messages when provider prices change', async () => {
    const { org, token, sender } = await createActiveOrg();
    await credit(org.id, 10);
    const res = await send(token, sender.id, phones(1)).expect(201);
    const before = await prisma.smsRecipient.findFirstOrThrow({ where: { messageId: res.body.data.id } });
    const mtn = await prisma.smsProvider.findUniqueOrThrow({ where: { code: 'MTN' } });
    await request(app).post(`/api/v1/admin/providers/${mtn.id}/purchase`).set(auth(superToken)).send({ quantity: 100_000, unitCost: '20' }).expect(201);
    await request(app).patch(`/api/v1/admin/providers/${mtn.id}`).set(auth(superToken)).send({ costPerSms: '25' }).expect(200);
    const after = await prisma.smsRecipient.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.providerCost!.toFixed(4)).toBe(before.providerCost!.toFixed(4));
  });

  it('per-customer finance report uses stored ledger data', async () => {
    const { org, token, sender } = await createActiveOrg();
    const pay = await request(app).post('/api/v1/payments').set(auth(token)).send({ quantity: 1500, method: 'MOBILE_MONEY', payerPhone: '0788123456' });
    await simulator().simulatePayerAction(pay.body.data.payment.providerReference, 'APPROVE');
    await verifyAndApply(pay.body.data.payment.id);
    await send(token, sender.id, phones(10)).expect(201);
    const rep = await request(app).get('/api/v1/admin/finance/customers?range=today').set(auth(superToken));
    expect(rep.status).toBe(200);
    const row = rep.body.data.customers.find((c: { organization: { id: string } }) => c.organization.id === org.id);
    const cost = (await prisma.smsRecipient.aggregate({ where: { organizationId: org.id }, _sum: { providerCost: true } }))._sum.providerCost!.toDecimalPlaces(2);
    expect(row).toMatchObject({ smsPurchased: 1500, revenue: '16500.00', smsUsed: 10, currentBalance: 1490, messagesRouted: 10, providerCost: cost.toFixed(2) });
    expect(row.grossMargin).toBe((16500 - Number(cost)).toFixed(2));
    expect((await request(app).get('/api/v1/admin/finance/customers').set(auth(token))).status).toBe(403);
  });
});
