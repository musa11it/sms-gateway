import request from 'supertest';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { PaymentProviderFactory } from '../src/integrations/payments/PaymentProviderFactory';
import type { SimulationPaymentProvider } from '../src/integrations/payments/SimulationPaymentProvider';
import { figures, marginPercent } from '../src/modules/finance/smsFinancials.service';
import { verifyAndApply } from '../src/modules/payments/payment.service';
import { dispatchMessage, pollPendingDeliveryStatuses, sendSms } from '../src/modules/sms/sms.service';
import { app, balanceOf, createActiveOrg, createStaff, resetDatabase } from './helpers';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let sa = '';

const provider = (code: string) => prisma.smsProvider.findUniqueOrThrow({ where: { code } });
let seq = 0;
/** Valid Rwanda numbers; the simulator rejects …0000 and fails delivery for …9999, so these avoid both. */
const mtn = (n: number) => Array.from({ length: n }, () => `+25078${String(2_000_001 + seq++)}`);
const airtel = (n: number) => Array.from({ length: n }, () => `+25072${String(3_000_001 + seq++)}`);
const kenya = (n: number) => Array.from({ length: n }, () => `+25471${String(2_000_001 + seq++)}`);

/** Customer buys `quantity` credits through the real payment flow (price from the active ranges). */
async function buy(token: string, quantity: number) {
  const pay = await request(app).post('/api/v1/payments').set(auth(token)).send({ quantity, method: 'CARD' });
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  await (PaymentProviderFactory.getActive() as SimulationPaymentProvider).simulatePayerAction(pay.body.data.payment.providerReference, 'APPROVE');
  await verifyAndApply(pay.body.data.payment.id);
  return pay.body.data.payment.id as string;
}

/** Send and let the providers accept it (→ realized). */
async function sendAccepted(token: string, senderId: string, recipients: string[], message = 'Hello') {
  const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId, message, recipients });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await dispatchMessage(res.body.data.id);
  return { messageId: res.body.data.id as string, recipients: await prisma.smsRecipient.findMany({ where: { messageId: res.body.data.id }, include: { smsProvider: true } }) };
}

/** Make `code`'s stock a single fresh lot of `quantity` at `unitCost` (older lots written off). */
async function restock(code: string, quantity: number, unitCost: string) {
  const p = await provider(code);
  if (p.capacityBalance > 0) {
    await request(app).post(`/api/v1/admin/providers/${p.id}/adjust`).set(auth(sa)).send({ amount: -p.capacityBalance, reason: 'Test restock', reference: `RS-${code}-${seq++}` }).expect(200);
  }
  await request(app).post(`/api/v1/admin/providers/${p.id}/purchase`).set(auth(sa)).send({ quantity, unitCost }).expect(201);
}

const sms = async (id: string) => (await request(app).get(`/api/v1/admin/finance/sms/${id}`).set(auth(sa))).body.data;
const profit = async (query: string) => (await request(app).get(`/api/v1/admin/finance/profit?range=all&${query}`).set(auth(sa))).body.data;

beforeAll(async () => {
  await resetDatabase();
  sa = (await createStaff('SUPER_ADMIN')).token;
});

beforeEach(async () => {
  await prisma.smsRoutingRule.updateMany({ data: { isActive: false } });
});

describe('per-segment gross profit', () => {
  it('one SMS at RWF 13 through MTN at RWF 6 → gross profit 7', async () => {
    await restock('MTN', 1000, '6');
    const { token, sender } = await createActiveOrg();
    await buy(token, 100); // 1–1,000 range: RWF 13
    const { recipients } = await sendAccepted(token, sender.id, mtn(1));
    expect(await sms(recipients[0].id)).toMatchObject({
      provider: { code: 'MTN' },
      segments: 1,
      customerPricePerCredit: '13.0000',
      providerCostPerSegment: '6.0000',
      revenue: '13.00',
      providerCost: '6.00',
      grossProfit: '7.00',
      grossMarginPercent: 53.85,
      realized: true,
    });
  });

  it('one SMS at RWF 9 through Airtel at RWF 8.50 → gross profit 0.50 (5.56%)', async () => {
    await restock('AIRTEL', 1000, '8.5');
    const { token, sender } = await createActiveOrg();
    await buy(token, 10_000); // 5,001–10,000 range: RWF 9
    const { recipients } = await sendAccepted(token, sender.id, airtel(1));
    expect(await sms(recipients[0].id)).toMatchObject({ provider: { code: 'AIRTEL' }, revenue: '9.00', providerCost: '8.50', grossProfit: '0.50', grossMarginPercent: 5.56 });
  });

  it('a 2-segment SMS is 2 × price against 2 × cost', async () => {
    await restock('MTN', 1000, '6');
    const { token, sender } = await createActiveOrg();
    await buy(token, 10_000);
    const { recipients } = await sendAccepted(token, sender.id, mtn(1), 'x'.repeat(200));
    expect(await sms(recipients[0].id)).toMatchObject({ segments: 2, credits: 2, revenue: '18.00', providerCost: '12.00', grossProfit: '6.00' });
  });

  it('shows negative margin as a loss, never zero', async () => {
    const { token, sender } = await createActiveOrg();
    await buy(token, 10_000);
    const { recipients } = await sendAccepted(token, sender.id, kenya(1)); // only the aggregator serves Kenya, at RWF 11
    expect(await sms(recipients[0].id)).toMatchObject({ provider: { code: 'GENERIC' }, revenue: '9.00', providerCost: '11.00', grossProfit: '-2.00', grossMarginPercent: -22.22 });
  });
});

describe('the required example: 10,000 credits at RWF 9, 1,000 segments (700 MTN @ 6, 300 Airtel @ 8.50)', () => {
  let org = '';
  let purchaseId = '';
  it('produces revenue 9,000, cost 6,750, gross profit 2,250, margin 25% — and every view reconciles', async () => {
    await restock('MTN', 700, '6');
    await restock('AIRTEL', 300, '8.5');
    const c = await createActiveOrg();
    org = c.org.id;
    await buy(c.token, 10_000);
    await sendAccepted(c.token, c.sender.id, [...mtn(700), ...airtel(300)]);

    const expected = { segments: 1000, credits: 1000, revenue: '9000.00', providerCost: '6750.00', grossProfit: '2250.00', grossMarginPercent: 25 };
    const byProvider = await profit(`groupBy=provider&organizationId=${org}`);
    expect(byProvider.totals).toMatchObject(expected);
    const rows = Object.fromEntries(byProvider.rows.map((r: { label: string }) => [r.label, r]));
    expect(rows['MTN Rwanda']).toMatchObject({ segments: 700, revenue: '6300.00', providerCost: '4200.00', grossProfit: '2100.00' });
    expect(rows['Airtel Rwanda']).toMatchObject({ segments: 300, revenue: '2700.00', providerCost: '2550.00', grossProfit: '150.00' });

    // Customer report, per-day view and the purchase view give the same numbers.
    const customers = (await request(app).get('/api/v1/admin/finance/customers?range=all').set(auth(sa))).body.data.customers;
    expect(customers.find((r: { organization: { id: string } }) => r.organization.id === org)).toMatchObject({ smsPurchased: 10_000, smsUsed: 1000, smsRevenue: '9000.00', providerCost: '6750.00', grossProfit: '2250.00', grossMarginPercent: 25 });
    const days = await profit(`groupBy=day&organizationId=${org}`);
    expect(days.rows).toHaveLength(1);
    expect(days.rows[0]).toMatchObject(expected);
    const months = await profit(`groupBy=month&organizationId=${org}`);
    expect(months.rows[0]).toMatchObject(expected);

    const sales = (await request(app).get(`/api/v1/admin/finance/sales?organizationId=${org}`).set(auth(sa))).body.data;
    purchaseId = sales[0].id;
    expect(sales[0]).toMatchObject({ credits: 10_000, revenue: '90000.00' });
    expect(sales[0].usage).toMatchObject({ unitPrice: '9.0000', creditsUsed: 1000, creditsRemaining: 9000, revenueUsed: '9000.00', providerCost: '6750.00', grossProfit: '2250.00' });
  });

  it('unused credits are sales, not SMS revenue, and carry no provider cost', async () => {
    const sales = (await request(app).get(`/api/v1/admin/finance/sales?organizationId=${org}`).set(auth(sa))).body.data;
    const p = sales.find((s: { id: string }) => s.id === purchaseId);
    // 90,000 sold, but only the 1,000 used credits (9,000) are realized revenue; 9,000 credits remain without cost.
    expect(Number(p.revenue)).toBe(90_000);
    expect(p.usage.revenueUsed).toBe('9000.00');
    expect(p.usage.creditsRemaining).toBe(9000);
    expect(await balanceOf(org)).toBe(9000);
  });
});

describe('historical prices and costs', () => {
  it('consumes provider lots oldest-first, each SMS at its own lot cost', async () => {
    await restock('MTN', 100, '6');
    const p = await provider('MTN');
    // Leave 3 segments in the RWF 6 lot, then buy a newer lot at RWF 5.50.
    await request(app).post(`/api/v1/admin/providers/${p.id}/adjust`).set(auth(sa)).send({ amount: -97, reason: 'Leave three in the lot', reference: `RS-LEFT3-${seq++}` }).expect(200);
    await request(app).post(`/api/v1/admin/providers/${p.id}/purchase`).set(auth(sa)).send({ quantity: 100, unitCost: '5.5' }).expect(201);
    const { token, sender } = await createActiveOrg();
    await buy(token, 10_000);
    const { recipients } = await sendAccepted(token, sender.id, mtn(5));
    expect(recipients.map((r) => r.providerCost!.toFixed(2)).sort()).toEqual(['5.50', '5.50', '6.00', '6.00', '6.00']);

    const lots = (await request(app).get(`/api/v1/admin/providers/${p.id}`).set(auth(sa))).body.data.lots as { unitCost: string; consumed: number; consumedCost: string; remaining: number; writtenOff: number }[];
    // The RWF 6 lot: 3 used by SMS (18.00), 97 written off by the adjustment — reported separately.
    expect(lots.find((l) => l.unitCost === '6.0000' && l.consumed === 3)).toMatchObject({ remaining: 0, consumedCost: '18.00', writtenOff: 97 });
    expect(lots.find((l) => l.unitCost === '5.5000')).toMatchObject({ consumed: 2, remaining: 98, consumedCost: '11.00' });
  });

  it('never re-values past SMS when customer prices or provider costs change', async () => {
    await restock('MTN', 100, '6');
    const { token, sender } = await createActiveOrg();
    await buy(token, 10_000); // RWF 9 per credit, frozen on the credit lot
    const first = (await sendAccepted(token, sender.id, mtn(1))).recipients[0];

    // The admin raises the customer price and the provider cost.
    await prisma.smsPricingTier.updateMany({ where: { minQuantity: 5001 }, data: { unitPrice: new Prisma.Decimal('14') } });
    const mtnRow = await provider('MTN');
    await request(app).patch(`/api/v1/admin/providers/${mtnRow.id}`).set(auth(sa)).send({ costPerSms: '20', reason: 'New contract' }).expect(200);
    try {
      // Old SMS unchanged; a new SMS still uses the credits bought at 9 and the stock bought at 6.
      expect(await sms(first.id)).toMatchObject({ revenue: '9.00', providerCost: '6.00', grossProfit: '3.00' });
      const next = (await sendAccepted(token, sender.id, mtn(1))).recipients[0];
      expect(await sms(next.id)).toMatchObject({ revenue: '9.00', providerCost: '6.00', grossProfit: '3.00' });
    } finally {
      await prisma.smsPricingTier.updateMany({ where: { minQuantity: 5001 }, data: { unitPrice: new Prisma.Decimal('9') } });
      await prisma.smsProvider.update({ where: { code: 'MTN' }, data: { costPerSms: 8 } });
    }
  });
});

describe('failed and rejected SMS', () => {
  it('a provider rejection is refunded, gives the credits back to the same lot and creates no revenue or cost', async () => {
    await restock('MTN', 100, '6');
    const { org, token, sender } = await createActiveOrg();
    await buy(token, 10_000);
    const { recipients } = await sendAccepted(token, sender.id, ['+250788120000']); // simulator rejects …0000
    expect(recipients[0]).toMatchObject({ status: 'REJECTED', refunded: true });
    expect(await sms(recipients[0].id)).toMatchObject({ realized: false, state: 'NOT_CHARGED' });
    expect((await profit(`organizationId=${org.id}`)).totals).toMatchObject({ messages: 0, revenue: '0.00', providerCost: '0.00', grossProfit: '0.00' });
    expect(await balanceOf(org.id)).toBe(10_000);
    const lot = await prisma.smsCreditLot.findFirstOrThrow({ where: { organizationId: org.id, sourceType: 'PURCHASE' } });
    expect(lot.remaining).toBe(10_000);
  });

  it('an accepted SMS that later fails delivery stays charged and counted', async () => {
    await restock('MTN', 100, '6');
    const { org, token, sender } = await createActiveOrg();
    await buy(token, 10_000);
    const { recipients } = await sendAccepted(token, sender.id, ['+250788129999']); // accepted, then fails delivery
    await pollPendingDeliveryStatuses(0, 10_000);
    expect((await prisma.smsRecipient.findUniqueOrThrow({ where: { id: recipients[0].id } })).status).toBe('FAILED');
    expect((await profit(`organizationId=${org.id}`)).totals).toMatchObject({ messages: 1, revenue: '9.00', providerCost: '6.00', grossProfit: '3.00' });
  });

  it('queued (not yet accepted) SMS are pending, not realized', async () => {
    await restock('MTN', 100, '6');
    const { org, token, sender } = await createActiveOrg();
    await buy(token, 10_000);
    await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'Hi', recipients: mtn(2) }).expect(201);
    const t = (await profit(`organizationId=${org.id}`)).totals;
    expect(t).toMatchObject({ messages: 0, revenue: '0.00' });
    expect(t.pending).toMatchObject({ messages: 2, credits: 2, revenue: '18.00', providerCost: '12.00' });
  });
});

describe('aggregation', () => {
  it('aggregates a campaign across providers from the same per-SMS records', async () => {
    await restock('MTN', 100, '6');
    await restock('AIRTEL', 100, '8.5');
    const { org, user, token, sender } = await createActiveOrg();
    await buy(token, 10_000);
    const campaign = await prisma.campaign.create({ data: { organizationId: org.id, name: 'Launch', senderId: sender.id, message: 'Hi', createdById: user.id, status: 'PROCESSING' } });
    const { message } = await sendSms({ organizationId: org.id, actor: { type: 'USER', userId: user.id, email: user.email }, senderId: sender.id, recipients: [...mtn(4), ...airtel(2), ...kenya(1)], message: 'Hi', source: 'CAMPAIGN', campaignId: campaign.id });
    await dispatchMessage(message.id);
    const byCampaign = await profit(`groupBy=campaign&organizationId=${org.id}`);
    // 7 × 9 = 63 revenue; 4 × 6 + 2 × 8.5 + 1 × 11 = 52 cost; 11 gross profit.
    expect(byCampaign.rows).toEqual([expect.objectContaining({ label: 'Launch', segments: 7, revenue: '63.00', providerCost: '52.00', grossProfit: '11.00', grossMarginPercent: 17.46 })]);
    const perProvider = await profit(`groupBy=provider&campaignId=${campaign.id}`);
    expect(perProvider.rows.map((r: { label: string; grossProfit: string }) => [r.label, r.grossProfit]).sort()).toEqual([
      ['Aggregator', '-2.00'],
      ['Airtel Rwanda', '1.00'],
      ['MTN Rwanda', '12.00'],
    ]);
    const byCountry = await profit(`groupBy=country&campaignId=${campaign.id}`);
    expect(byCountry.rows.map((r: { label: string; revenue: string }) => [r.label, r.revenue]).sort()).toEqual([
      ['Kenya', '9.00'],
      ['Rwanda', '54.00'],
    ]);
  });

  it('platform totals = Σ providers = Σ customers = Σ days, and revenue − cost = gross profit everywhere', async () => {
    const all = await profit('groupBy=provider');
    const sum = (rows: { revenue: string; providerCost: string; grossProfit: string }[], k: 'revenue' | 'providerCost' | 'grossProfit') => rows.reduce((s, r) => s.plus(r[k]), new Prisma.Decimal(0)).toFixed(2);
    for (const g of ['provider', 'organization', 'day', 'month', 'campaign', 'country']) {
      const rows = (await profit(`groupBy=${g}`)).rows;
      expect(sum(rows, 'revenue')).toBe(all.totals.revenue);
      expect(sum(rows, 'providerCost')).toBe(all.totals.providerCost);
      for (const r of rows) expect(new Prisma.Decimal(r.revenue).minus(r.providerCost).toFixed(2)).toBe(r.grossProfit);
    }
    const db = await prisma.smsRecipient.aggregate({ where: { status: { in: ['SENT', 'DELIVERED', 'FAILED', 'EXPIRED'] }, refunded: false }, _sum: { revenue: true, providerCost: true } });
    expect(all.totals.revenue).toBe(db._sum.revenue!.toDecimalPlaces(2).toFixed(2));
    expect(all.totals.providerCost).toBe(db._sum.providerCost!.toDecimalPlaces(2).toFixed(2));
    const overview = (await request(app).get('/api/v1/admin/finance/overview?range=all').set(auth(sa))).body.data;
    expect(overview.smsProfit).toMatchObject({ revenue: all.totals.revenue, providerCost: all.totals.providerCost, grossProfit: all.totals.grossProfit });
    const providers = (await request(app).get('/api/v1/admin/providers/overview?range=all').set(auth(sa))).body.data;
    expect(providers.economics).toMatchObject({ revenue: all.totals.revenue, providerCost: all.totals.providerCost, grossProfit: all.totals.grossProfit });
  });
});

describe('edge cases', () => {
  it('rounds for display and always reconciles', () => {
    expect(figures({ revenue: '4.49995', providerCost: '1.00004' })).toMatchObject({ revenue: '4.50', providerCost: '1.00', grossProfit: '3.50' });
    expect(figures({ revenue: '10', providerCost: '3.3333' })).toMatchObject({ revenue: '10.00', providerCost: '3.33', grossProfit: '6.67', grossMarginPercent: 66.7 });
  });

  it('free (admin-credited) credits have zero revenue and a 0% margin, never NaN', async () => {
    expect(marginPercent(0, -5)).toBe(0);
    await restock('MTN', 100, '6');
    const { org, token, sender } = await createActiveOrg({ credits: 10 });
    const { recipients } = await sendAccepted(token, sender.id, mtn(1));
    expect(await sms(recipients[0].id)).toMatchObject({ revenue: '0.00', providerCost: '6.00', grossProfit: '-6.00', grossMarginPercent: 0 });
    expect((await profit(`organizationId=${org.id}`)).totals.grossMarginPercent).toBe(0);
  });

  it('the simulator shows expected gross profit and changes nothing', async () => {
    await restock('AIRTEL', 100, '8.5');
    const { org, token } = await createActiveOrg();
    await buy(token, 10_000);
    const snapshot = async () => ({
      wallet: await balanceOf(org.id),
      lots: (await prisma.smsCreditLot.findMany({ where: { organizationId: org.id } })).map((l) => l.remaining),
      capacity: (await prisma.smsProvider.findMany({ orderBy: { code: 'asc' } })).map((p) => p.capacityBalance),
      providerLots: await prisma.providerCapacityLot.aggregate({ _sum: { remaining: true } }),
      recipients: await prisma.smsRecipient.count(),
      ledger: await prisma.walletTransaction.count(),
      capacityLedger: await prisma.providerCapacityLedger.count(),
    });
    const before = await snapshot();
    const s = (await request(app).post('/api/v1/admin/routing/simulate').set(auth(sa)).send({ phone: airtel(1)[0], organizationId: org.id, recipients: 1, message: 'Hi' })).body.data;
    expect(s.selected.name).toBe('Airtel Rwanda');
    expect(s.estimate).toMatchObject({ revenue: '9.00', revenuePerCredit: '9.0000', priceSource: 'CUSTOMER_LOTS', providerCost: '8.50', grossProfit: '0.50', grossMarginPercent: 5.56 });
    expect(await snapshot()).toEqual(before);
  });

  it('never shows provider cost, stock lots, routing notes or revenue accounting to customers', async () => {
    await restock('MTN', 100, '6');
    const { token, sender } = await createActiveOrg();
    await buy(token, 100);
    const { recipients } = await sendAccepted(token, sender.id, mtn(1));
    const list = (await request(app).get('/api/v1/sms/messages').set(auth(token))).body.data[0];
    const one = (await request(app).get(`/api/v1/sms/messages/${recipients[0].id}`).set(auth(token))).body.data;
    for (const r of [list, one]) {
      expect(r.id).toBe(recipients[0].id);
      for (const k of ['providerCost', 'costLots', 'revenue', 'revenueLots', 'routingNote', 'providerId', 'routingRuleId', 'networkId', 'capacityReleased']) expect(r).not.toHaveProperty(k);
    }
  });

  it('keeps profit figures away from staff without profit.view', async () => {
    const support = await createStaff('SUPPORT');
    expect((await request(app).get('/api/v1/admin/finance/profit').set(auth(support.token))).status).toBe(403);
    const { token } = await createActiveOrg();
    expect((await request(app).get('/api/v1/admin/finance/profit').set(auth(token))).status).toBe(403);
  });
});
