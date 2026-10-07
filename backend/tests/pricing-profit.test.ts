import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { PaymentProviderFactory } from '../src/integrations/payments/PaymentProviderFactory';
import type { SimulationPaymentProvider } from '../src/integrations/payments/SimulationPaymentProvider';
import { verifyAndApply } from '../src/modules/payments/payment.service';
import { app, createActiveOrg, createStaff, resetDatabase } from './helpers';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let sa = '';

beforeAll(async () => {
  await resetDatabase();
  sa = (await createStaff('SUPER_ADMIN')).token;
});

describe('one way to buy: any amount', () => {
  it('refuses package purchases and no longer exposes packages', async () => {
    const { token } = await createActiveOrg();
    const res = await request(app).post('/api/v1/payments').set(auth(token)).send({ packageId: '00000000-0000-0000-0000-000000000000', method: 'CARD' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('no longer sold');
    expect((await request(app).post('/api/v1/payments').set(auth(token)).send({ method: 'CARD' })).status).toBe(422);
    expect((await request(app).get('/api/v1/packages').set(auth(token))).status).toBe(404);
    expect((await request(app).get('/api/v1/admin/billing/packages').set(auth(sa))).status).toBe(404);
    expect((await request(app).get('/api/v1/site/packages')).status).toBe(404);
    const ok = await request(app).post('/api/v1/payments').set(auth(token)).send({ quantity: 2500, method: 'CARD' });
    expect(ok.body.data.payment).toMatchObject({ credits: 2500, unitPrice: '11.00', amount: '27500.00', packageId: null });
  });
});

describe('profit planner', () => {
  it('derives cost, break-even and margin per range from providers and fees', async () => {
    // Providers in the test setup: 100,000 each at 8 (MTN), 8.5 (Airtel) and 11 (aggregator); no payments yet → configured fee 0%.
    const res = await request(app).get('/api/v1/admin/pricing/economics').set(auth(sa));
    expect(res.status).toBe(200);
    const { inputs, tiers } = res.body.data;
    expect(inputs).toMatchObject({ creditsPerSegment: 1, paymentFeePercent: 0, expectedCostPerCredit: '9.1667', worstCaseCostPerCredit: '11.0000', breakEvenPrice: '11.00' });
    const starter = tiers.find((t: { minQuantity: number }) => t.minQuantity === 1);
    expect(starter).toMatchObject({ unitPrice: '13.00', marginPerCredit: '3.8333', marginPercent: 29.5, worstCaseMarginPerCredit: '2.0000', warnings: [] });
    const volume = tiers.find((t: { minQuantity: number }) => t.minQuantity === 10001);
    expect(volume).toMatchObject({ unitPrice: '8.00', marginPerCredit: '-1.1667', warnings: ['Below cost on the most expensive route', 'Below the expected cost'] });
  });

  it('tracks what each range sold and uses actual payment fees once there are sales', async () => {
    const { token } = await createActiveOrg();
    const pay = await request(app).post('/api/v1/payments').set(auth(token)).send({ quantity: 1500, method: 'MOBILE_MONEY', payerPhone: '0788123456' });
    await (PaymentProviderFactory.getActive() as SimulationPaymentProvider).simulatePayerAction(pay.body.data.payment.providerReference, 'APPROVE');
    await verifyAndApply(pay.body.data.payment.id);
    const res = await request(app).get('/api/v1/admin/pricing/economics').set(auth(sa));
    expect(res.body.data.inputs).toMatchObject({ paymentFeePercent: 1.5, paymentFeeSource: 'actual payments' });
    const growth = res.body.data.tiers.find((t: { minQuantity: number }) => t.minQuantity === 1001);
    expect(growth.sales).toMatchObject({ purchases: 1, credits: 1500, revenue: '16500.00', paymentFees: '247.50' });
    // No SMS sent yet → projected with the expected cost: 16,500 − 247.50 − 1,500 × 9.1666… = 2,502.50.
    expect(growth.sales.projectedMargin).toBe('2502.50');
  });

  it('hides costs and margins from staff without profit.view', async () => {
    const support = await createStaff('SUPPORT');
    expect((await request(app).get('/api/v1/admin/pricing/economics').set(auth(support.token))).status).toBe(403);
    const { token } = await createActiveOrg();
    expect((await request(app).get('/api/v1/admin/pricing/economics').set(auth(token))).status).toBe(403);
  });
});

describe('credits sold through each provider', () => {
  it('splits delivered credits, revenue, cost and margin by provider', async () => {
    const { org, token, sender } = await createActiveOrg();
    const pay = await request(app).post('/api/v1/payments').set(auth(token)).send({ quantity: 100, method: 'CARD' });
    await (PaymentProviderFactory.getActive() as SimulationPaymentProvider).simulatePayerAction(pay.body.data.payment.providerReference, 'APPROVE');
    await verifyAndApply(pay.body.data.payment.id);
    // 3 MTN numbers, 2 Airtel numbers, 1 international (aggregator), 2 segments each.
    const res = await request(app)
      .post('/api/v1/sms/send')
      .set(auth(token))
      .send({ senderId: sender.id, message: 'x'.repeat(200), recipients: ['+250788200001', '+250788200002', '+250788200003', '+250728200004', '+250728200005', '+447400123457'] });
    expect(res.status).toBe(201);
    const ov = await request(app).get('/api/v1/admin/providers/overview?range=today').set(auth(sa));
    const by = Object.fromEntries((ov.body.data.byProvider as { code: string; credits: number; providerCost: string; sharePercent: number; revenue: string }[]).map((p) => [p.code, p]));
    expect(by.MTN).toMatchObject({ credits: 6, providerCost: '48.00', sharePercent: 50 });
    expect(by.AIRTEL).toMatchObject({ credits: 4, providerCost: '34.00' });
    expect(by.GENERIC).toMatchObject({ credits: 2, providerCost: '22.00' });
    expect(Number(by.MTN.revenue)).toBeGreaterThan(0);
    expect(await prisma.smsRecipient.count({ where: { organizationId: org.id } })).toBe(6);
  });
});
