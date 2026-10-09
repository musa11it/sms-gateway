import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { PaymentProviderFactory } from '../src/integrations/payments/PaymentProviderFactory';
import type { SimulationPaymentProvider } from '../src/integrations/payments/SimulationPaymentProvider';
import { verifyAndApply } from '../src/modules/payments/payment.service';
import { invalidateSettingsCache } from '../src/modules/settings/settings.service';
import { dispatchMessage, sendSms } from '../src/modules/sms/sms.service';
import { SYSTEM_ACTOR } from '../src/types/actor';
import { app, balanceOf, createActiveOrg, createStaff, resetDatabase } from './helpers';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let sa = '';
let MTN = '';
let AIRTEL = '';

let seq = 0;
const mtn = (n: number) => Array.from({ length: n }, () => `+25078${String(4_000_001 + seq++)}`);
const airtel = (n: number) => Array.from({ length: n }, () => `+25072${String(5_000_001 + seq++)}`);

const network = (code: string) => prisma.smsNetwork.findUniqueOrThrow({ where: { code } });
const provider = (code: string) => prisma.smsProvider.findUniqueOrThrow({ where: { code } });
const lotsOf = (organizationId: string) => prisma.smsCreditLot.findMany({ where: { organizationId, remaining: { gt: 0 } } });

async function price(networkId: string, ranges: [number, number | null, string][]) {
  for (const [minQuantity, maxQuantity, unitPrice] of ranges) {
    const res = await request(app).post('/api/v1/admin/pricing/tiers').set(auth(sa)).send({ networkId, minQuantity, maxQuantity, unitPrice });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
}

/** Buy SMS for networks through the real payment flow (simulated payer approves). */
async function buyNetworks(token: string, items: { networkId: string; quantity: number }[]) {
  const pay = await request(app).post('/api/v1/payments').set(auth(token)).send({ items, method: 'CARD' });
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  await (PaymentProviderFactory.getActive() as SimulationPaymentProvider).simulatePayerAction(pay.body.data.payment.providerReference, 'APPROVE');
  await verifyAndApply(pay.body.data.payment.id);
  return pay.body.data.payment as { id: string; items: { networkId: string; quantity: number; unitPrice: string; subtotal: string }[]; amount: string };
}

const send = (token: string, body: Record<string, unknown>) => request(app).post('/api/v1/sms/send').set(auth(token)).send({ message: 'Hello', ...body });

beforeAll(async () => {
  await resetDatabase();
  sa = (await createStaff('SUPER_ADMIN')).token;
  MTN = (await network('RW-MTN')).id;
  AIRTEL = (await network('RW-AIRTEL')).id;
  // Independent price lists: MTN 12 → 10 from 1,001; Airtel 14 flat.
  await price(MTN, [
    [100, 1000, '12'],
    [1001, null, '10'],
  ]);
  await price(AIRTEL, [[50, null, '14']]);
});

beforeEach(async () => {
  await prisma.smsRoutingRule.updateMany({ data: { isActive: false } });
  await prisma.smsNetwork.updateMany({ data: { isActive: true, inMaintenance: false, requiresSenderRegistration: false } });
  await prisma.smsProvider.updateMany({ data: { status: 'ACTIVE', health: 'HEALTHY' } });
});

describe('destination catalog', () => {
  it('lists Rwanda with only its active, configured networks and their own prices', async () => {
    const res = await request(app).get('/api/v1/pricing/destinations').set(auth((await createActiveOrg()).token));
    expect(res.status).toBe(200);
    const rw = res.body.data.countries.find((c: { isoCode: string }) => c.isoCode === 'RW');
    expect(rw.networks.map((n: { code: string }) => n.code).sort()).toEqual(['RW-AIRTEL', 'RW-MTN']);
    const m = rw.networks.find((n: { code: string }) => n.code === 'RW-MTN');
    const a = rw.networks.find((n: { code: string }) => n.code === 'RW-AIRTEL');
    expect(m).toMatchObject({ available: true, availability: 'AVAILABLE', fromPrice: '10.00', minQuantity: 100, currency: 'RWF' });
    expect(a).toMatchObject({ available: true, fromPrice: '14.00', minQuantity: 50 });
    // Kenya and the UK have no priced network: not offered at all.
    expect(res.body.data.countries.map((c: { isoCode: string }) => c.isoCode)).toEqual(['RW']);
    // Never leaks provider data.
    expect(JSON.stringify(res.body)).not.toMatch(/capacity|costPerSms|providerId/i);

    await prisma.smsNetwork.update({ where: { id: AIRTEL }, data: { isActive: false } });
    const after = await request(app).get('/api/v1/pricing/destinations').set(auth((await createActiveOrg()).token));
    expect(after.body.data.countries[0].networks.map((n: { code: string }) => n.code)).toEqual(['RW-MTN']);
  });

  it('a country and network added in the admin API become purchasable without code changes', async () => {
    const ke = await prisma.smsCountry.findUniqueOrThrow({ where: { isoCode: 'KE' } });
    const created = await request(app)
      .post('/api/v1/admin/routing/networks')
      .set(auth(sa))
      .send({ code: 'KE-SAF', name: 'Safaricom Kenya', countryCode: 'KE', prefixes: ['+25471', '+25472'], providerIds: [(await provider('GENERIC')).id] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await price(created.body.data.id, [[1, null, '25']]);
    const { token } = await createActiveOrg();
    const country = await request(app).get('/api/v1/pricing/destinations/KE').set(auth(token));
    expect(country.status).toBe(200);
    expect(country.body.data.networks).toEqual([expect.objectContaining({ code: 'KE-SAF', available: true, fromPrice: '25.00' })]);
    const quote = await request(app).post('/api/v1/pricing/network-quote').set(auth(token)).send({ items: [{ networkId: created.body.data.id, quantity: 10 }] });
    expect(quote.body.data).toMatchObject({ total: '250.00', currency: 'RWF' });
  });
});

describe('buying SMS per network', () => {
  it('MTN only, Airtel only and both — each line priced by its own network', async () => {
    const { token, org } = await createActiveOrg();
    const onlyMtn = await buyNetworks(token, [{ networkId: MTN, quantity: 1000 }]);
    expect(onlyMtn.items).toEqual([expect.objectContaining({ networkId: MTN, quantity: 1000, unitPrice: '12.00', subtotal: '12000.00' })]);
    const onlyAirtel = await buyNetworks(token, [{ networkId: AIRTEL, quantity: 100 }]);
    expect(onlyAirtel.amount).toBe('1400.00');

    const both = await request(app).post('/api/v1/pricing/network-quote').set(auth(token)).send({ items: [{ networkId: MTN, quantity: 1000 }, { networkId: AIRTEL, quantity: 2000 }] });
    expect(both.body.data.items.map((i: { subtotal: string }) => i.subtotal)).toEqual(['12000.00', '28000.00']);
    expect(both.body.data.total).toBe('40000.00');
    const paid = await buyNetworks(token, [{ networkId: MTN, quantity: 1000 }, { networkId: AIRTEL, quantity: 2000 }]);
    expect(paid.amount).toBe('40000.00');

    expect(await balanceOf(org.id)).toBe(1000 + 100 + 3000);
    const balances = (await request(app).get('/api/v1/wallet/balances').set(auth(token))).body.data;
    expect(balances.general.credits).toBe(0);
    expect(balances.networks.map((n: { code: string; credits: number }) => [n.code, n.credits])).toEqual([
      ['RW-AIRTEL', 2100],
      ['RW-MTN', 2000],
    ]);
    // Reconciles with the wallet ledger: Σ lots = wallet balance = Σ purchases.
    const lots = await lotsOf(org.id);
    expect(lots.reduce((s, l) => s + l.remaining, 0)).toBe(balances.total);
    const purchases = await prisma.walletTransaction.aggregate({ where: { organizationId: org.id, type: 'PURCHASE' }, _sum: { amount: true } });
    expect(purchases._sum.amount).toBe(balances.total);
    expect(lots.every((l) => l.networkId && l.unitPrice)).toBe(true);
  });

  it('rejects tampered prices and unknown fields; the server price is the only price', async () => {
    const { token } = await createActiveOrg();
    const tampered = await request(app).post('/api/v1/payments').set(auth(token)).send({ items: [{ networkId: MTN, quantity: 100 }], method: 'CARD', amount: '1', total: '1' });
    expect(tampered.status).toBe(422);
    const lineTampered = await request(app).post('/api/v1/payments').set(auth(token)).send({ items: [{ networkId: MTN, quantity: 100, unitPrice: '0.01' }], method: 'CARD' });
    expect(lineTampered.status).toBe(422);
    expect(lineTampered.body.code).toBe('INVALID_PURCHASE_ITEMS');
    const fake = await request(app).post('/api/v1/payments').set(auth(token)).send({ items: [{ networkId: '00000000-0000-4000-8000-000000000000', quantity: 100 }], method: 'CARD' });
    expect(fake.body.code).toBe('NETWORK_NOT_AVAILABLE');
    expect(await prisma.payment.count({ where: { organization: { members: { some: {} } }, amount: { lt: 2 } } })).toBe(0);
  });

  it('refuses inactive, maintenance and unpriced networks and out-of-range quantities without creating a payment', async () => {
    const { token, org } = await createActiveOrg();
    const ke = await prisma.smsNetwork.create({ data: { code: 'KE-AIRTEL', name: 'Airtel Kenya', countryCode: 'KE', countryName: 'Kenya', prefixes: ['+25473'] } });
    const buy = (networkId: string, quantity = 200) => request(app).post('/api/v1/payments').set(auth(token)).send({ items: [{ networkId, quantity }], method: 'CARD' });

    expect((await buy(ke.id)).body.code).toBe('NETWORK_NOT_PRICED');
    await prisma.smsNetwork.update({ where: { id: MTN }, data: { inMaintenance: true, maintenanceNote: 'Operator upgrade' } });
    const maint = await buy(MTN);
    expect(maint.body.code).toBe('NETWORK_MAINTENANCE');
    expect(maint.body.message).toMatch(/maintenance/i);
    await prisma.smsNetwork.update({ where: { id: MTN }, data: { inMaintenance: false, isActive: false } });
    expect((await buy(MTN)).body.code).toBe('NETWORK_NOT_AVAILABLE');
    await prisma.smsNetwork.update({ where: { id: MTN }, data: { isActive: true } });
    expect((await buy(MTN, 99)).body.code).toBe('QUANTITY_BELOW_MINIMUM');
    expect(await prisma.payment.count({ where: { organizationId: org.id } })).toBe(0);
  });

  it('refuses a purchase larger than the provider capacity able to reach the network', async () => {
    const { token } = await createActiveOrg();
    const res = await request(app).post('/api/v1/pricing/network-quote').set(auth(token)).send({ items: [{ networkId: AIRTEL, quantity: 50_000_000 }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NETWORK_INSUFFICIENT_STOCK');
    // The stock level is not disclosed.
    expect(JSON.stringify({ message: res.body.message, errors: res.body.errors })).not.toMatch(/\d{4,}/);
  });

  it('keeps purchase prices and lot prices when the admin changes today’s price', async () => {
    const { token, org } = await createActiveOrg();
    const paid = await buyNetworks(token, [{ networkId: AIRTEL, quantity: 100 }]);
    const tier = await prisma.smsPricingTier.findFirstOrThrow({ where: { networkId: AIRTEL, isActive: true } });
    await request(app).patch(`/api/v1/admin/pricing/tiers/${tier.id}`).set(auth(sa)).send({ unitPrice: '20' }).expect(200);
    const item = await prisma.paymentItem.findFirstOrThrow({ where: { paymentId: paid.id } });
    expect(item.unitPrice.toFixed(2)).toBe('14.00');
    const [lot] = await lotsOf(org.id);
    expect(lot.unitPrice!.toFixed(2)).toBe('14.00');
    expect((await request(app).post('/api/v1/pricing/network-quote').set(auth(token)).send({ items: [{ networkId: AIRTEL, quantity: 100 }] })).body.data.total).toBe('2000.00');
    await request(app).patch(`/api/v1/admin/pricing/tiers/${tier.id}`).set(auth(sa)).send({ unitPrice: '14' }).expect(200);
  });

  it('a scheduled price takes over at its effective date without overlapping the current one', async () => {
    const tier = await prisma.smsPricingTier.findFirstOrThrow({ where: { networkId: AIRTEL, isActive: true } });
    const next = new Date(Date.now() + 86_400_000);
    // Same range, open-ended in both: refused.
    expect((await request(app).post('/api/v1/admin/pricing/tiers').set(auth(sa)).send({ networkId: AIRTEL, minQuantity: 50, unitPrice: '13' })).body.code).toBe('TIER_OVERLAP');
    await request(app).patch(`/api/v1/admin/pricing/tiers/${tier.id}`).set(auth(sa)).send({ effectiveTo: next.toISOString() }).expect(200);
    const scheduled = await request(app).post('/api/v1/admin/pricing/tiers').set(auth(sa)).send({ networkId: AIRTEL, minQuantity: 50, unitPrice: '13', effectiveFrom: next.toISOString() });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
    const { token } = await createActiveOrg();
    expect((await request(app).post('/api/v1/pricing/network-quote').set(auth(token)).send({ items: [{ networkId: AIRTEL, quantity: 100 }] })).body.data.total).toBe('1400.00');
    await prisma.smsPricingTier.delete({ where: { id: scheduled.body.data.id } });
    await prisma.smsPricingTier.update({ where: { id: tier.id }, data: { effectiveTo: null } });
  });
});

describe('spending network credits', () => {
  it('MTN credits cannot pay for Airtel traffic; nothing is charged or reserved', async () => {
    const { token, org, sender } = await createActiveOrg();
    await buyNetworks(token, [{ networkId: MTN, quantity: 100 }]);
    const capacityBefore = (await provider('AIRTEL')).capacityBalance;
    const res = await send(token, { senderId: sender.id, recipients: airtel(1) });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_NETWORK_CREDITS');
    expect(await balanceOf(org.id)).toBe(100);
    expect((await provider('AIRTEL')).capacityBalance).toBe(capacityBefore);
    expect(await prisma.smsMessage.count({ where: { organizationId: org.id } })).toBe(0);

    const ok = await send(token, { senderId: sender.id, recipients: mtn(2) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await balanceOf(org.id)).toBe(98);
  });

  it('general credits pay for any network, after the network’s own credits', async () => {
    const { token, org, sender } = await createActiveOrg({ credits: 10 });
    await buyNetworks(token, [{ networkId: MTN, quantity: 100 }]);
    const res = await send(token, { senderId: sender.id, recipients: [...mtn(3), ...airtel(2)] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const lots = await prisma.smsCreditLot.findMany({ where: { organizationId: org.id } });
    expect(lots.find((l) => l.networkId === MTN)!.remaining).toBe(97);
    expect(lots.find((l) => l.networkId === null)!.remaining).toBe(8);
    // Revenue follows the lot each recipient was paid from.
    const recipients = await prisma.smsRecipient.findMany({ where: { messageId: res.body.data.id } });
    for (const r of recipients) expect(r.revenue!.toFixed(2)).toBe(r.networkId === MTN ? '12.00' : '0.00');
  });

  it('multi-segment messages charge every recipient per segment, per network', async () => {
    const { token, org, sender } = await createActiveOrg();
    await buyNetworks(token, [{ networkId: MTN, quantity: 100 }, { networkId: AIRTEL, quantity: 50 }]);
    const long = 'x'.repeat(161); // 2 GSM-7 segments
    const quote = await request(app).post('/api/v1/sms/quote').set(auth(token)).send({ message: long, recipients: [...mtn(3), ...airtel(2)], senderId: sender.id });
    expect(quote.body.data.byNetwork.map((n: { networkName: string; recipients: number; credits: number; sufficientCredits: boolean }) => [n.networkName, n.recipients, n.credits, n.sufficientCredits])).toEqual([
      ['Airtel Rwanda', 2, 4, true],
      ['MTN Rwanda', 3, 6, true],
    ]);
    const res = await send(token, { senderId: sender.id, recipients: [...mtn(3), ...airtel(2)], message: long });
    expect(res.body.data).toMatchObject({ segments: 2, totalCredits: 10 });
    const lots = await lotsOf(org.id);
    expect(lots.find((l) => l.networkId === MTN)!.remaining).toBe(94);
    expect(lots.find((l) => l.networkId === AIRTEL)!.remaining).toBe(46);
  });

  it('a rejected submission refunds into the network lot it was paid from', async () => {
    const { token, org, sender } = await createActiveOrg();
    await buyNetworks(token, [{ networkId: MTN, quantity: 100 }]);
    const res = await send(token, { senderId: sender.id, recipients: ['+250788120000'] }); // simulator rejects …0000
    await dispatchMessage(res.body.data.id);
    const r = await prisma.smsRecipient.findFirstOrThrow({ where: { messageId: res.body.data.id } });
    expect(r).toMatchObject({ status: 'REJECTED', refunded: true });
    const lots = await lotsOf(org.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ networkId: MTN, remaining: 100 });
  });

  it('concurrent sends can never overspend a network balance', async () => {
    const { org, sender, user } = await createActiveOrg();
    await prisma.$transaction(async (tx) => {
      const { applyLedgerEntry } = await import('../src/modules/wallet/wallet.service');
      await applyLedgerEntry(tx, { organizationId: org.id, type: 'ADMIN_CREDIT', amount: 5, reference: `t:${org.id}`, description: 'MTN credits', networkId: MTN });
    });
    const attempt = () => sendSms({ organizationId: org.id, actor: { type: 'USER', userId: user.id }, senderId: sender.id, recipients: mtn(3), message: 'Hi', source: 'DASHBOARD' });
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(org.id)).toBe(2);
    expect((await lotsOf(org.id))[0].remaining).toBe(2);
  });

  it('retries with the same idempotency key never charge twice', async () => {
    const { token, org, sender } = await createActiveOrg();
    await buyNetworks(token, [{ networkId: MTN, quantity: 100 }]);
    const body = { senderId: sender.id, recipients: mtn(2), idempotencyKey: `idem-${seq++}-network` };
    const [a, b] = await Promise.all([send(token, body), send(token, body)]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(await balanceOf(org.id)).toBe(98);
  });

  it('a duplicate payment confirmation credits each network line once', async () => {
    const { token, org } = await createActiveOrg();
    const p = await buyNetworks(token, [{ networkId: MTN, quantity: 100 }, { networkId: AIRTEL, quantity: 50 }]);
    await verifyAndApply(p.id);
    await verifyAndApply(p.id, SYSTEM_ACTOR);
    expect(await balanceOf(org.id)).toBe(150);
    expect(await prisma.walletTransaction.count({ where: { organizationId: org.id, type: 'PURCHASE' } })).toBe(2);
  });

  it('a refund reverses each network line', async () => {
    const { token, org } = await createActiveOrg();
    const p = await buyNetworks(token, [{ networkId: MTN, quantity: 100 }, { networkId: AIRTEL, quantity: 50 }]);
    const res = await request(app).post(`/api/v1/admin/billing/payments/${p.id}/refund`).set(auth(sa)).send({ reason: 'Customer request' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await balanceOf(org.id)).toBe(0);
  });
});

describe('selected destination networks', () => {
  it('refuses recipients outside the selected networks', async () => {
    const { token, sender } = await createActiveOrg({ credits: 100 });
    const res = await send(token, { senderId: sender.id, recipients: [...mtn(1), ...airtel(1)], networkIds: [MTN] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_RECIPIENTS');
    expect(JSON.stringify(res.body.errors)).toMatch(/not one of the selected networks/);
    const ok = await send(token, { senderId: sender.id, recipients: mtn(2), networkIds: [MTN] });
    expect(ok.status).toBe(201);
  });

  it('refuses invalid numbers and numbers of a network in maintenance', async () => {
    const { token, org, sender } = await createActiveOrg({ credits: 100 });
    expect((await send(token, { senderId: sender.id, recipients: ['+25078123'] })).body.code).toBe('INVALID_RECIPIENTS');
    await prisma.smsNetwork.update({ where: { id: AIRTEL }, data: { inMaintenance: true } });
    const res = await send(token, { senderId: sender.id, recipients: airtel(1) });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/maintenance/i);
    expect(await balanceOf(org.id)).toBe(100);
  });

  it('detects the network by the longest matching prefix', async () => {
    const special = await prisma.smsNetwork.create({ data: { code: 'RW-MTN-M2M', name: 'MTN Rwanda M2M', countryCode: 'RW', countryName: 'Rwanda', prefixes: ['+250789'], providers: { create: [{ providerId: (await provider('MTN')).id }] } } });
    const { token, sender } = await createActiveOrg({ credits: 100 });
    const res = await send(token, { senderId: sender.id, recipients: ['+250789123456', '+250788123457'] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const rows = await prisma.smsRecipient.findMany({ where: { messageId: res.body.data.id } });
    expect(rows.find((r) => r.phone === '+250789123456')!.networkId).toBe(special.id);
    expect(rows.find((r) => r.phone === '+250788123457')!.networkId).toBe(MTN);
    await prisma.smsRecipient.deleteMany({ where: { networkId: special.id } });
    await prisma.smsNetwork.delete({ where: { id: special.id } });
  });

  it('a deactivated network’s numbers are refused, never re-routed through a country-wide provider', async () => {
    const { token, org, sender } = await createActiveOrg({ credits: 100 });
    await prisma.smsNetwork.update({ where: { id: AIRTEL }, data: { isActive: false } });
    const res = await send(token, { senderId: sender.id, recipients: airtel(1) });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/not currently offered/);
    expect(await balanceOf(org.id)).toBe(100);
  });
});

describe('sender ID compatibility per network', () => {
  it('an MTN-only sender ID cannot send to Airtel; one approved on both can', async () => {
    await prisma.smsNetwork.updateMany({ where: { id: { in: [MTN, AIRTEL] } }, data: { requiresSenderRegistration: true } });
    const { token, org, sender } = await createActiveOrg({ credits: 100 });
    const approve = (networkId: string) => request(app).put(`/api/v1/admin/senders/${sender.id}/networks/${networkId}`).set(auth(sa)).send({ status: 'APPROVED' });
    expect((await approve(MTN)).status).toBe(200);

    const eligible = await request(app).get(`/api/v1/senders/eligible?networkIds=${MTN},${AIRTEL}`).set(auth(token));
    expect(eligible.body.data[0]).toMatchObject({ id: sender.id, compatible: false });
    expect(eligible.body.data[0].networks.find((n: { networkId: string }) => n.networkId === AIRTEL)).toMatchObject({ status: 'NOT_REGISTERED', compatible: false });

    const blocked = await send(token, { senderId: sender.id, recipients: airtel(1) });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('SENDER_NOT_APPROVED_FOR_NETWORK');
    const mixed = await send(token, { senderId: sender.id, recipients: [...mtn(1), ...airtel(1)] });
    expect(mixed.body.code).toBe('SENDER_NOT_APPROVED_FOR_NETWORK');
    expect(await balanceOf(org.id)).toBe(100);
    expect((await send(token, { senderId: sender.id, recipients: mtn(1) })).status).toBe(201);

    // A pending registration does not count; only an explicit approval does.
    await request(app).post(`/api/v1/senders/${sender.id}/networks`).set(auth(token)).send({ networkIds: [AIRTEL] }).expect(200);
    expect((await send(token, { senderId: sender.id, recipients: airtel(1) })).body.code).toBe('SENDER_NOT_APPROVED_FOR_NETWORK');
    expect((await approve(AIRTEL)).status).toBe(200);
    expect((await send(token, { senderId: sender.id, recipients: [...mtn(1), ...airtel(1)] })).status).toBe(201);

    // Suspension on one network blocks that network only.
    await request(app).put(`/api/v1/admin/senders/${sender.id}/networks/${AIRTEL}`).set(auth(sa)).send({ status: 'SUSPENDED', note: 'Complaint' }).expect(200);
    expect((await send(token, { senderId: sender.id, recipients: airtel(1) })).body.code).toBe('SENDER_NOT_APPROVED_FOR_NETWORK');
    expect((await send(token, { senderId: sender.id, recipients: mtn(1) })).status).toBe(201);
  });

  it('staff need the matching sender permission to change a network approval', async () => {
    const support = await createStaff('SUPPORT');
    const { sender } = await createActiveOrg();
    const res = await request(app).put(`/api/v1/admin/senders/${sender.id}/networks/${MTN}`).set(auth(support.token)).send({ status: 'APPROVED' });
    expect(res.status).toBe(403);
  });
});

describe('routing honours the destination network', () => {
  it('a provider that does not serve the network is never selected', async () => {
    const { token, org, sender } = await createActiveOrg({ credits: 100 });
    await prisma.smsProvider.updateMany({ where: { code: { in: ['AIRTEL', 'GENERIC'] } }, data: { status: 'INACTIVE' } });
    const mtnBefore = (await provider('MTN')).capacityBalance;
    const res = await send(token, { senderId: sender.id, recipients: airtel(1) });
    // Airtel's own providers exist but are switched off: temporarily unavailable — MTN is never a fallback.
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PROVIDER_CAPACITY_UNAVAILABLE');
    expect((await provider('MTN')).capacityBalance).toBe(mtnBefore);
    expect(await prisma.smsRecipient.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await balanceOf(org.id)).toBe(100);
  });

  it('an aggregator carries traffic only for destinations it is explicitly configured for', async () => {
    const generic = await provider('GENERIC');
    const rw = await prisma.smsCountry.findUniqueOrThrow({ where: { isoCode: 'RW' } });
    await prisma.smsProviderCountry.delete({ where: { providerId_countryId: { providerId: generic.id, countryId: rw.id } } });
    await prisma.smsProviderNetwork.create({ data: { providerId: generic.id, networkId: MTN } });
    await prisma.smsProvider.updateMany({ where: { code: { in: ['MTN', 'AIRTEL'] } }, data: { status: 'INACTIVE' } });
    const { token, sender } = await createActiveOrg({ credits: 100 });

    const toMtn = await send(token, { senderId: sender.id, recipients: mtn(1) });
    expect(toMtn.status, JSON.stringify(toMtn.body)).toBe(201);
    const r = await prisma.smsRecipient.findFirstOrThrow({ where: { messageId: toMtn.body.data.id } });
    expect(r.providerId).toBe(generic.id);
    const genericBefore = (await provider('GENERIC')).capacityBalance;
    const toAirtel = await send(token, { senderId: sender.id, recipients: airtel(1) });
    expect(toAirtel.status).toBe(503); // only the (inactive) Airtel provider serves Airtel; the aggregator is not configured for it
    expect((await provider('GENERIC')).capacityBalance).toBe(genericBefore);

    await prisma.smsProviderNetwork.delete({ where: { providerId_networkId: { providerId: generic.id, networkId: MTN } } });
    await prisma.smsProviderCountry.create({ data: { providerId: generic.id, countryId: rw.id } });
  });

  it('refuses safely when no provider has capacity: nothing charged, capacity never negative', async () => {
    const { token, org, sender } = await createActiveOrg({ credits: 100 });
    await prisma.smsProvider.updateMany({ where: { code: { in: ['AIRTEL', 'GENERIC'] } }, data: { status: 'INACTIVE' } });
    const mtnP = await provider('MTN');
    await prisma.smsProvider.update({ where: { id: mtnP.id }, data: { minimumCapacity: mtnP.capacityBalance } });
    const res = await send(token, { senderId: sender.id, recipients: mtn(1) });
    expect(res.status).toBe(503);
    expect(await balanceOf(org.id)).toBe(100);
    expect((await provider('MTN')).capacityBalance).toBe(mtnP.capacityBalance);
    await prisma.smsProvider.update({ where: { id: mtnP.id }, data: { minimumCapacity: 0 } });
  });
});

describe('access control', () => {
  it('customers only see their own network balances', async () => {
    const a = await createActiveOrg();
    const b = await createActiveOrg();
    await buyNetworks(a.token, [{ networkId: MTN, quantity: 100 }]);
    const res = await request(app).get('/api/v1/wallet/balances').set(auth(b.token));
    expect(res.body.data).toMatchObject({ total: 0, networks: [] });
  });

  it('only pricing managers can change network prices; customers cannot reach admin pricing', async () => {
    const { token } = await createActiveOrg();
    expect((await request(app).post('/api/v1/admin/pricing/tiers').set(auth(token)).send({ networkId: MTN, minQuantity: 1, unitPrice: '1' })).status).toBe(403);
    const support = await createStaff('SUPPORT');
    expect((await request(app).post('/api/v1/admin/pricing/tiers').set(auth(support.token)).send({ networkId: MTN, minQuantity: 1, unitPrice: '1' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/routing/networks/${MTN}`).set(auth(support.token)).send({ inMaintenance: true })).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/pricing/networks/inventory').set(auth(token))).status).toBe(403);
  });

  it('network configuration changes are audited', async () => {
    await request(app).patch(`/api/v1/admin/routing/networks/${AIRTEL}`).set(auth(sa)).send({ inMaintenance: true, maintenanceNote: 'Upgrade' }).expect(200);
    expect(await prisma.auditLog.count({ where: { action: 'ROUTING_NETWORK_MAINTENANCE_STARTED', resourceId: AIRTEL } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'PRICING_TIER_CREATED' } })).toBeGreaterThan(0);
    invalidateSettingsCache();
  });
});

describe('pricing configurations', () => {
  let NET = '';
  const putList = (body: Record<string, unknown>, token = sa) => request(app).put('/api/v1/admin/pricing/lists').set(auth(token)).send({ networkId: NET, ...body });
  const publicQuote = (quantity: number) => request(app).post('/api/v1/site/quote').send({ items: [{ networkId: NET, quantity }] });

  beforeAll(async () => {
    const created = await request(app).post('/api/v1/admin/routing/networks').set(auth(sa)).send({ code: 'RW-TESTNET', name: 'Test Telecom Rwanda', countryCode: 'RW', prefixes: ['+25075'] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    NET = created.body.data.id;
    await price(NET, [
      [1, 100, '10'],
      [101, 1000, '8'],
      [1001, null, '6'],
    ]);
  });

  it('whole-purchase vs graduated rates, with no fees', async () => {
    expect((await publicQuote(150)).body.data.items[0]).toMatchObject({ unitPrice: '8.00', subtotal: '1200.00', total: '1200.00' });
    await putList({ rateApplication: 'GRADUATED' }).expect(200);
    const q = (await publicQuote(150)).body.data;
    expect(q.items[0]).toMatchObject({ unitPrice: '9.3333', subtotal: '1400.00', total: '1400.00' });
    expect(q.items[0].pricing.breakdown.map((b: { units: number; unitPrice: string }) => [b.units, b.unitPrice])).toEqual([
      [100, '10.0000'],
      [50, '8.0000'],
    ]);
    expect(q).toMatchObject({ subtotal: '1400.00', total: '1400.00' });
    expect(q).not.toHaveProperty('fees');
    // Boundaries: 100 is all in the first tier, 101 crosses into the second.
    expect((await publicQuote(100)).body.data.items[0].subtotal).toBe('1000.00');
    expect((await publicQuote(101)).body.data.items[0].subtotal).toBe('1008.00');
    await putList({ rateApplication: 'WHOLE_PURCHASE' }).expect(200);
  });

  it('a graduated purchase freezes its rule and split; later configuration changes do not touch it', async () => {
    await putList({ rateApplication: 'GRADUATED' }).expect(200);
    const { token, org } = await createActiveOrg();
    const paid = await buyNetworks(token, [{ networkId: NET, quantity: 150 }]);
    expect(paid.amount).toBe('1400.00');
    await putList({ rateApplication: 'WHOLE_PURCHASE' }).expect(200);
    const item = await prisma.paymentItem.findFirstOrThrow({ where: { paymentId: paid.id } });
    expect(item).toMatchObject({ rateApplication: 'GRADUATED', quantity: 150 });
    expect(item.subtotal.toFixed(2)).toBe('1400.00');
    expect(item.unitPrice.toFixed(4)).toBe('9.3333');
    const [lot] = await lotsOf(org.id);
    expect(lot).toMatchObject({ networkId: NET, remaining: 150 });
    expect(lot.unitPrice!.toFixed(4)).toBe('9.3333');
  });

  it('monthly-volume tiers count the organization purchases this month', async () => {
    await putList({ pricingMetric: 'MONTHLY_PURCHASE_QUANTITY' }).expect(200);
    const { token } = await createActiveOrg();
    await buyNetworks(token, [{ networkId: NET, quantity: 90 }]); // 90 × 10
    const mine = await request(app).post('/api/v1/payments/quote').set(auth(token)).send({ items: [{ networkId: NET, quantity: 20 }] });
    expect(mine.body.data.items[0]).toMatchObject({ unitPrice: '8.00', subtotal: '160.00', pricing: { volumeBefore: 90, metric: 'MONTHLY_PURCHASE_QUANTITY' } });
    // An anonymous estimate has no history: first tier.
    expect((await publicQuote(20)).body.data.items[0].subtotal).toBe('200.00');
    const paid = await buyNetworks(token, [{ networkId: NET, quantity: 20 }]);
    expect(paid.amount).toBe('160.00');
    await putList({ pricingMetric: 'PURCHASE_QUANTITY' }).expect(200);
  });

  it('limits and an inactive configuration are enforced', async () => {
    await putList({ minPurchaseQuantity: 50, maxPurchaseQuantity: 500 }).expect(200);
    expect((await publicQuote(10)).body.code).toBe('QUANTITY_BELOW_MINIMUM');
    expect((await publicQuote(600)).body.code).toBe('QUANTITY_ABOVE_MAXIMUM');
    await putList({ minPurchaseQuantity: null, maxPurchaseQuantity: null, isActive: false }).expect(200);
    const { token } = await createActiveOrg();
    expect((await request(app).post('/api/v1/payments').set(auth(token)).send({ items: [{ networkId: NET, quantity: 100 }], method: 'CARD' })).body.code).toBe('NETWORK_NOT_PRICED');
    const country = (await request(app).get('/api/v1/site/destinations')).body.data.countries.find((c: { isoCode: string }) => c.isoCode === 'RW');
    expect(country.networks.find((n: { id: string }) => n.id === NET)).toMatchObject({ available: false, availability: 'NO_PRICE' });
    await putList({ isActive: true }).expect(200);
    expect((await putList({ minPurchaseQuantity: 10, maxPurchaseQuantity: 5 })).body.code).toBe('INVALID_LIMITS');
  });

  it('incoming prices stay separate and are never offered while inbound SMS is not a service', async () => {
    expect((await putList({ direction: 'INBOUND' })).body.code).toBe('INBOUND_NOT_SUPPORTED');
    await prisma.smsNetwork.update({ where: { id: NET }, data: { supportsInbound: true } });
    await putList({ direction: 'INBOUND' }).expect(200);
    await request(app).post('/api/v1/admin/pricing/tiers').set(auth(sa)).send({ networkId: NET, direction: 'INBOUND', minQuantity: 1, unitPrice: '3' }).expect(201);
    const country = (await request(app).get('/api/v1/site/destinations')).body.data.countries.find((c: { isoCode: string }) => c.isoCode === 'RW');
    expect(country.services).toEqual([expect.objectContaining({ key: 'BULK_SMS', direction: 'OUTBOUND' })]);
    const n = country.networks.find((x: { id: string }) => x.id === NET);
    expect(n.tiers.map((t: { unitPrice: string }) => t.unitPrice)).toEqual(['10.00', '8.00', '6.00']);
    expect(n.directions).toEqual({ outbound: true, inbound: false });
    expect((await publicQuote(150)).body.data.items[0].unitPrice).toBe('8.00');
  });

  it('the public pricing API needs no login and exposes no provider data; general prices exclude network tiers', async () => {
    const res = await request(app).get('/api/v1/site/destinations');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/capacity|costPerSms|providerId|usableProvider/i);
    const general = (await request(app).get('/api/v1/site/pricing')).body.data;
    expect(general.map((t: { unitPrice: string }) => t.unitPrice)).toEqual(['13.00', '11.00', '9.00', '8.00']);
    const tampered = await request(app).post('/api/v1/site/quote').send({ items: [{ networkId: NET, quantity: 10, unitPrice: '0.01' }] });
    expect(tampered.body.code).toBe('INVALID_PURCHASE_ITEMS');
  });

  it('price history is audited and only pricing managers can change configurations', async () => {
    const history = await request(app).get(`/api/v1/admin/pricing/history?networkId=${NET}`).set(auth(sa));
    expect(history.body.data.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['PRICE_LIST_UPDATED', 'PRICE_LIST_CREATED', 'PRICING_TIER_CREATED']));
    const support = await createStaff('SUPPORT');
    expect((await putList({ isActive: false }, support.token)).status).toBe(403);
    const { token } = await createActiveOrg();
    expect((await putList({ isActive: false }, token)).status).toBe(403);
  });
});

describe('price ladder, country directory and telecom-specific sender IDs', () => {
  it('a ladder replaces the prices with contiguous ranges, keeping sold prices for history', async () => {
    const net = await prisma.smsNetwork.create({ data: { code: 'RW-LADDER', name: 'Ladder Telecom', countryCode: 'RW', countryName: 'Rwanda', prefixes: ['+25074'], providers: { create: [{ providerId: (await provider('GENERIC')).id }] } } });
    const save = (steps: { minQuantity: number; unitPrice: string; name?: string }[]) => request(app).put('/api/v1/admin/pricing/ladder').set(auth(sa)).send({ networkId: net.id, steps });
    const first = await save([
      { minQuantity: 1, unitPrice: '12', name: 'Basic' },
      { minQuantity: 1001, unitPrice: '11' },
      { minQuantity: 5001, unitPrice: '10' },
    ]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.map((t: { minQuantity: number; maxQuantity: number | null; unitPrice: string }) => [t.minQuantity, t.maxQuantity, t.unitPrice])).toEqual([
      [1, 1000, '12.00'],
      [1001, 5000, '11.00'],
      [5001, null, '10.00'],
    ]);
    const { token } = await createActiveOrg();
    await buyNetworks(token, [{ networkId: net.id, quantity: 2000 }]); // 2,000 × 11
    expect((await save([{ minQuantity: 1, unitPrice: '9' }])).status).toBe(200);
    const tiers = await prisma.smsPricingTier.findMany({ where: { networkId: net.id } });
    expect(tiers.filter((t) => t.isActive).map((t) => t.unitPrice.toFixed(2))).toEqual(['9.00']);
    // The sold 11.00 price is kept (inactive) for history; unused ones were removed.
    expect(tiers.filter((t) => !t.isActive).map((t) => t.unitPrice.toFixed(2))).toEqual(['11.00']);
    expect((await save([{ minQuantity: 1, unitPrice: '9' }, { minQuantity: 1, unitPrice: '8' }])).body.code).toBe('DUPLICATE_STEP');
    const support = await createStaff('SUPPORT');
    expect((await request(app).put('/api/v1/admin/pricing/ladder').set(auth(support.token)).send({ networkId: net.id, steps: [{ minQuantity: 1, unitPrice: '1' }] })).status).toBe(403);
  });

  it('countries load light and searchable; the home country opens first', async () => {
    const all = (await request(app).get('/api/v1/site/countries')).body.data;
    expect(all.defaultIsoCode).toBe('RW');
    const rwRow = all.countries.find((c: { isoCode: string }) => c.isoCode === 'RW');
    expect(rwRow).toMatchObject({ available: true, networksOnSale: expect.any(Number) });
    expect(rwRow).not.toHaveProperty('networks');
    expect((await request(app).get('/api/v1/site/countries?prefer=Kenya')).body.data.defaultIsoCode).toBe('KE');
    expect((await request(app).get('/api/v1/site/countries?search=ken')).body.data.countries.map((c: { isoCode: string }) => c.isoCode)).toEqual(['KE']);
    expect((await request(app).get('/api/v1/site/countries?search=%2B250')).body.data.countries.map((c: { isoCode: string }) => c.isoCode)).toEqual(['RW']);
    const rw = (await request(app).get('/api/v1/site/countries/RW')).body.data;
    expect(rw.networks.map((n: { code: string }) => n.code)).toEqual(expect.arrayContaining(['RW-MTN', 'RW-AIRTEL']));
  });

  it('a sender ID requested for Airtel only sends to Airtel; one requested for both sends to both', async () => {
    const { token, org } = await createActiveOrg({ credits: 100 });
    const requestSender = (name: string, networkIds: string[]) => request(app).post('/api/v1/senders').set(auth(token)).send({ name, purpose: 'Customer notifications', networkIds });
    const airtelOnly = await requestSender('AIRONLY', [AIRTEL]);
    expect(airtelOnly.status, JSON.stringify(airtelOnly.body)).toBe(201);
    const both = await requestSender('BOTHNETS', [MTN, AIRTEL]);
    for (const s of [airtelOnly, both]) await request(app).post(`/api/v1/admin/senders/${s.body.data.id}/approve`).set(auth(sa)).send({}).expect(200);

    // Approving the sender ID approves the telecoms it was requested for.
    expect(await prisma.senderIdNetwork.count({ where: { senderId: both.body.data.id, status: 'APPROVED' } })).toBe(2);
    expect((await send(token, { senderId: airtelOnly.body.data.id, recipients: mtn(1) })).body.code).toBe('SENDER_NOT_APPROVED_FOR_NETWORK');
    expect((await send(token, { senderId: airtelOnly.body.data.id, recipients: airtel(1) })).status).toBe(201);
    expect((await send(token, { senderId: both.body.data.id, recipients: [...mtn(1), ...airtel(1)] })).status).toBe(201);
    expect(await balanceOf(org.id)).toBe(97);

    // A sender ID requested without telecoms keeps working everywhere (the original behaviour).
    const { sender, token: t2 } = await createActiveOrg({ credits: 10 });
    expect((await send(t2, { senderId: sender.id, recipients: [...mtn(1), ...airtel(1)] })).status).toBe(201);
  });
});
