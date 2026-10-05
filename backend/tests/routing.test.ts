import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { dispatchMessage } from '../src/modules/sms/sms.service';
import { applyLedgerEntry } from '../src/modules/wallet/wallet.service';
import { app, balanceOf, createActiveOrg, createStaff, resetDatabase } from './helpers';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let sa = '';
const ids: Record<string, string> = {};
let nets: Record<string, string> = {};

const provider = (code: string) => prisma.smsProvider.findUniqueOrThrow({ where: { code } });
const patchProvider = (code: string, body: Record<string, unknown>) => request(app).patch(`/api/v1/admin/providers/${ids[code]}`).set(auth(sa)).send(body);
const createRule = (body: Record<string, unknown>) => request(app).post('/api/v1/admin/routing/rules').set(auth(sa)).send(body);

let seq = 5000;
const mtnNumbers = (n: number) => Array.from({ length: n }, () => `+25078${String(1_000_000 + seq++ * 7).slice(-7).replace(/0000$/, '0007')}`);

async function credit(organizationId: string, amount: number) {
  await prisma.$transaction((tx) => applyLedgerEntry(tx, { organizationId, type: 'ADMIN_CREDIT', amount, reference: `t:${crypto.randomUUID()}`, description: 'Test credit' }));
}

async function sendAndGetProviders(n: number, message = 'Hello') {
  const { org, token, sender } = await createActiveOrg();
  await credit(org.id, 1000);
  const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message, recipients: mtnNumbers(n) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const recipients = await prisma.smsRecipient.findMany({ where: { messageId: res.body.data.id }, include: { smsProvider: true } });
  return { res, recipients, codes: recipients.map((r) => r.smsProvider!.code), org, token };
}

beforeAll(async () => {
  await resetDatabase();
  sa = (await createStaff('SUPER_ADMIN')).token;
  for (const c of ['MTN', 'AIRTEL', 'GENERIC']) ids[c] = (await provider(c)).id;
  nets = Object.fromEntries((await prisma.smsNetwork.findMany()).map((n) => [n.code, n.id]));
});

// Each test starts from the default configuration: no rules, all providers active/healthy, default priorities/costs/capabilities.
beforeEach(async () => {
  await prisma.smsRoutingRule.updateMany({ data: { isActive: false } });
  await prisma.smsProvider.update({ where: { code: 'MTN' }, data: { status: 'ACTIVE', health: 'HEALTHY', priority: 10, costPerSms: 8, minimumCapacity: 0 } });
  await prisma.smsProvider.update({ where: { code: 'AIRTEL' }, data: { status: 'ACTIVE', health: 'HEALTHY', priority: 10, costPerSms: 8.5, minimumCapacity: 0 } });
  await prisma.smsProvider.update({ where: { code: 'GENERIC' }, data: { status: 'ACTIVE', health: 'HEALTHY', priority: 100, costPerSms: 11, minimumCapacity: 0 } });
});

describe('provider management', () => {
  it('creates and edits providers with destinations, health and reserve; every change is audited', async () => {
    const res = await request(app)
      .post('/api/v1/admin/providers')
      .set(auth(sa))
      .send({ code: 'TIGO', name: 'Tigo Test', type: 'MNO', currency: 'RWF', costPerSms: '7', networkIds: [nets['RW-MTN']], minimumCapacity: 500, priority: 50 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'TIGO', status: 'INACTIVE', health: 'HEALTHY', minimumCapacity: 500, capacityBalance: 0 });
    const id = res.body.data.id;
    const upd = await request(app).patch(`/api/v1/admin/providers/${id}`).set(auth(sa)).send({ costPerSms: '6.5', health: 'DEGRADED', healthNote: 'Slow DLRs', reason: 'New contract' });
    expect(upd.status).toBe(200);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: id, action: 'PROVIDER_PRICING_CHANGED' } });
    expect(log.metadata).toMatchObject({ reason: 'New contract', changes: { costPerSms: { from: '7.0000', to: '6.5000' }, health: { from: 'HEALTHY', to: 'DEGRADED' } } });
    const detail = await request(app).get(`/api/v1/admin/providers/${id}`).set(auth(sa));
    expect(detail.body.data.costHistory[0]).toMatchObject({ from: '7.0000', to: '6.5000', reason: 'New contract' });
    expect(detail.body.data.networks.map((n: { code: string }) => n.code)).toEqual(['RW-MTN']);
    expect((await request(app).patch(`/api/v1/admin/providers/${id}`).set(auth(sa)).send({ networkIds: ['00000000-0000-0000-0000-000000000000'] })).status).toBe(422);
  });

  it('keeps purchase lots at their own cost and consumes them oldest-first', async () => {
    // Leave 10 segments in MTN's first lot (cost 8), then buy a second lot at 5.50.
    const mtn = await provider('MTN');
    await request(app).post(`/api/v1/admin/providers/${mtn.id}/adjust`).set(auth(sa)).send({ amount: -(mtn.capacityBalance - 10), reason: 'Reconcile for test', reference: 'LOT-TEST-1' }).expect(200);
    await request(app).post(`/api/v1/admin/providers/${mtn.id}/purchase`).set(auth(sa)).send({ quantity: 1000, unitCost: '5.5' }).expect(201);
    const lots = await prisma.providerCapacityLot.findMany({ where: { providerId: mtn.id }, orderBy: { createdAt: 'asc' } });
    expect(lots.map((l) => [l.unitCost.toFixed(2), l.remaining])).toEqual([['8.00', 10], ['5.50', 1000]]);

    const { recipients } = await sendAndGetProviders(15);
    // 10 × 8 + 5 × 5.50 = 107.50 over 15 segments.
    expect(recipients.every((r) => r.providerCost!.toFixed(4) === '7.1667')).toBe(true);
    const after = await prisma.providerCapacityLot.findMany({ where: { providerId: mtn.id }, orderBy: { createdAt: 'asc' } });
    expect(after.map((l) => l.remaining)).toEqual([0, 995]);
    expect((await provider('MTN')).capacityBalance).toBe(995);

    // A later configured-price change does not touch lots or past messages.
    await patchProvider('MTN', { costPerSms: '20' }).expect(200);
    expect((await prisma.providerCapacityLot.findFirstOrThrow({ where: { providerId: mtn.id, unitCost: 5.5 } })).unitCost.toFixed(2)).toBe('5.50');
    expect((await prisma.smsRecipient.findUniqueOrThrow({ where: { id: recipients[0].id } })).providerCost!.toFixed(4)).toBe('7.1667');

    const detail = await request(app).get(`/api/v1/admin/providers/${mtn.id}`).set(auth(sa));
    const lot = detail.body.data.lots.find((l: { unitCost: string }) => l.unitCost === '5.5000');
    expect(lot).toMatchObject({ quantity: 1000, used: 5, remaining: 995, totalCost: '5500.00', status: 'SUCCESS' });
  });

  it('returns released capacity to the lot it came from', async () => {
    const mtn = await provider('MTN');
    const { org, token, sender } = await createActiveOrg();
    await credit(org.id, 10);
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'Hi', recipients: ['+250788150000'] }); // rejected by simulator
    const lotsBefore = await prisma.providerCapacityLot.findMany({ where: { providerId: mtn.id } });
    await dispatchMessage(res.body.data.id);
    const lotsAfter = await prisma.providerCapacityLot.findMany({ where: { providerId: mtn.id } });
    expect(lotsAfter.length).toBe(lotsBefore.length); // no new lot: refilled the original
    expect(lotsAfter.reduce((s, l) => s + l.remaining, 0)).toBe(lotsBefore.reduce((s, l) => s + l.remaining, 0) + 1);
    expect((await provider('MTN')).capacityBalance).toBe(lotsAfter.reduce((s, l) => s + l.remaining, 0));
  });

  it('never lets capacity go negative', async () => {
    const generic = await provider('GENERIC');
    const res = await request(app).post(`/api/v1/admin/providers/${generic.id}/adjust`).set(auth(sa)).send({ amount: -(generic.capacityBalance + 1), reason: 'Too much', reference: 'NEG-TEST' });
    expect(res.status).toBe(503);
    await expect(prisma.smsProvider.update({ where: { id: generic.id }, data: { capacityBalance: -1 } })).rejects.toThrow();
  });
});

describe('routing', () => {
  it('default routing: highest-priority provider serving the network', async () => {
    expect(new Set((await sendAndGetProviders(3)).codes)).toEqual(new Set(['MTN']));
  });

  it('primary/backup rule: a provider can serve another network; DOWN or inactive primaries fall back', async () => {
    await patchProvider('AIRTEL', { networkIds: [nets['RW-AIRTEL'], nets['RW-MTN']] }).expect(200);
    const rule = await createRule({ name: 'MTN via Airtel', networkId: nets['RW-MTN'], primaryProviderId: ids.AIRTEL, backupProviderIds: [ids.MTN] });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    expect(rule.body.data).toMatchObject({ countryCode: 'RW', destination: 'MTN Rwanda', primaryProvider: 'Airtel Rwanda', backupProviders: ['MTN Rwanda'] });
    const first = await sendAndGetProviders(2);
    expect(new Set(first.codes)).toEqual(new Set(['AIRTEL']));
    expect(first.recipients[0]).toMatchObject({ routingRuleId: rule.body.data.id, networkId: nets['RW-MTN'] });

    await patchProvider('AIRTEL', { health: 'DOWN' }).expect(200);
    expect(new Set((await sendAndGetProviders(2)).codes)).toEqual(new Set(['MTN']));
    await patchProvider('AIRTEL', { health: 'HEALTHY', status: 'INACTIVE' }).expect(200);
    expect(new Set((await sendAndGetProviders(2)).codes)).toEqual(new Set(['MTN']));
    await patchProvider('AIRTEL', { networkIds: [nets['RW-AIRTEL']] }).expect(200);
  });

  it('lowest-cost strategy picks the cheapest eligible provider', async () => {
    await createRule({ name: 'Cheapest', networkId: nets['RW-MTN'], strategy: 'LOWEST_COST' }).expect(201);
    await patchProvider('MTN', { costPerSms: '12' }).expect(200); // now dearer than GENERIC (11)
    expect(new Set((await sendAndGetProviders(2)).codes)).toEqual(new Set(['GENERIC']));
  });

  it('priority + cost: priority first, cost breaks ties', async () => {
    await patchProvider('AIRTEL', { networkIds: [nets['RW-AIRTEL'], nets['RW-MTN']] }).expect(200);
    await createRule({ name: 'Priority then cost', networkId: nets['RW-MTN'], strategy: 'PRIORITY_THEN_COST' }).expect(201);
    // MTN and AIRTEL share priority 10; AIRTEL becomes cheaper.
    await patchProvider('AIRTEL', { costPerSms: '7.5' }).expect(200);
    expect(new Set((await sendAndGetProviders(2)).codes)).toEqual(new Set(['AIRTEL']));
    await patchProvider('AIRTEL', { networkIds: [nets['RW-AIRTEL']] }).expect(200);
  });

  it('maximum cost excludes providers that are too expensive', async () => {
    await patchProvider('MTN', { costPerSms: '9.5' }).expect(200);
    await createRule({ name: 'Cap at 10', networkId: nets['RW-MTN'], maxCostPerSegment: '10', allowedProviderIds: [ids.MTN, ids.GENERIC], strategy: 'LOWEST_COST' }).expect(201);
    expect(new Set((await sendAndGetProviders(1)).codes)).toEqual(new Set(['MTN']));
    await patchProvider('MTN', { costPerSms: '10.5' }).expect(200); // both above 10 now
    const { org, token, sender } = await createActiveOrg();
    await credit(org.id, 10);
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'Hi', recipients: mtnNumbers(1) });
    expect(res.status).toBe(503);
    expect(await balanceOf(org.id)).toBe(10); // nothing charged
  });

  it('minimum capacity reserve sends traffic to the backup and spills over per recipient', async () => {
    const mtn = await provider('MTN');
    await patchProvider('MTN', { minimumCapacity: mtn.capacityBalance - 3 }).expect(200); // only 3 usable
    const { codes } = await sendAndGetProviders(5);
    expect(codes.filter((c) => c === 'MTN')).toHaveLength(3);
    expect(codes.filter((c) => c === 'GENERIC')).toHaveLength(2);
    expect((await provider('MTN')).capacityBalance).toBe(mtn.capacityBalance - 3);
  });

  it('inactive providers are excluded', async () => {
    await patchProvider('MTN', { status: 'INACTIVE' }).expect(200);
    expect(new Set((await sendAndGetProviders(2)).codes)).toEqual(new Set(['GENERIC']));
  });

  it('customers only see credits used, never providers or costs', async () => {
    const { res, token } = await sendAndGetProviders(2);
    expect(res.body.data).not.toHaveProperty('provider');
    const list = await request(app).get('/api/v1/sms/messages').set(auth(token));
    for (const r of list.body.data) {
      expect(r).not.toHaveProperty('providerCost');
      expect(r).not.toHaveProperty('routingRuleId');
      expect(r).not.toHaveProperty('providerId');
    }
  });
});

describe('routing rules administration', () => {
  it('validates rules, reorders them and audits every change', async () => {
    expect((await createRule({ name: 'Bad', primaryProviderId: ids.MTN, backupProviderIds: [ids.MTN] })).status).toBe(422);
    expect((await createRule({ name: 'Bad', networkId: nets['RW-MTN'], countryCode: 'KE' })).body.code).toBe('COUNTRY_MISMATCH');
    expect((await createRule({ name: 'Bad', primaryProviderId: ids.MTN, allowedProviderIds: [ids.AIRTEL] })).body.code).toBe('PROVIDER_NOT_ALLOWED');
    const a = await createRule({ name: 'Rule A', countryCode: 'RW' });
    const b = await createRule({ name: 'Rule B', countryCode: 'RW' });
    const all = (await request(app).get('/api/v1/admin/routing/rules').set(auth(sa))).body.data as { id: string }[];
    const order = [b.body.data.id, ...all.map((r) => r.id).filter((id) => id !== b.body.data.id)];
    const res = await request(app).post('/api/v1/admin/routing/rules/reorder').set(auth(sa)).send({ ids: order });
    expect(res.body.data[0]).toMatchObject({ id: b.body.data.id, priority: 1 });
    await request(app).patch(`/api/v1/admin/routing/rules/${a.body.data.id}`).set(auth(sa)).send({ isActive: false }).expect(200);
    const actions = (await prisma.auditLog.findMany({ where: { resource: 'sms_routing_rule' }, select: { action: true } })).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['ROUTING_RULE_CREATED', 'ROUTING_RULES_REORDERED', 'ROUTING_RULE_DEACTIVATED']));
    expect((await request(app).post('/api/v1/admin/routing/rules/reorder').set(auth(sa)).send({ ids: [b.body.data.id] })).body.code).toBe('INVALID_ORDER');
  });

  it('manages destination networks without prefix clashes', async () => {
    const ke = await request(app).post('/api/v1/admin/routing/networks').set(auth(sa)).send({ code: 'KE-SAF', name: 'Safaricom Kenya', countryCode: 'KE', countryName: 'Kenya', prefixes: ['+25471', '+25472'] });
    expect(ke.status).toBe(201);
    const clash = await request(app).post('/api/v1/admin/routing/networks').set(auth(sa)).send({ code: 'RW-X', name: 'Clash', countryCode: 'RW', countryName: 'Rwanda', prefixes: ['+25078'] });
    expect(clash.body.code).toBe('PREFIX_IN_USE');
  });
});

describe('routing simulator', () => {
  it('explains the decision without touching capacity or wallets', async () => {
    const capacityBefore = (await prisma.smsProvider.findMany({ select: { capacityBalance: true } })).map((p) => p.capacityBalance);
    const ledgerBefore = await prisma.providerCapacityLedger.count();
    const res = await request(app).post('/api/v1/admin/routing/simulate').set(auth(sa)).send({ networkId: nets['RW-MTN'], recipients: 1000, message: 'a'.repeat(200), senderName: 'NOPE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d.message).toMatchObject({ encoding: 'GSM7', characterCount: 200, segmentsPerRecipient: 2, totalSegments: 2000, totalCredits: 2000 });
    expect(d.destination.network.code).toBe('RW-MTN');
    expect(d.selected.name).toBe('MTN Rwanda');
    expect(d.backup.name).toBe('Aggregator');
    expect(d.reason).toMatch(/Highest-priority eligible provider/);
    expect(d.candidates.find((c: { code: string }) => c.code === 'AIRTEL')).toMatchObject({ eligible: false, reasons: ['Does not serve MTN Rwanda'] });
    expect(d.sender).toMatchObject({ known: false, approved: false });
    expect(Number(d.estimate.providerCost)).toBeGreaterThan(0);
    expect((await prisma.smsProvider.findMany({ select: { capacityBalance: true } })).map((p) => p.capacityBalance)).toEqual(capacityBefore);
    expect(await prisma.providerCapacityLedger.count()).toBe(ledgerBefore);
  });
});

describe('authorization', () => {
  it('only staff with provider permissions can see or change providers and routing', async () => {
    const { token } = await createActiveOrg();
    for (const path of ['/api/v1/admin/providers', '/api/v1/admin/providers/overview', '/api/v1/admin/routing/rules', '/api/v1/admin/routing/networks']) {
      expect((await request(app).get(path).set(auth(token))).status, path).toBe(403);
    }
    expect((await request(app).post('/api/v1/admin/routing/simulate').set(auth(token)).send({ recipients: 1, message: 'x' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/providers/${ids.MTN}`).set(auth(token)).send({ costPerSms: '1' })).status).toBe(403);
    const support = await createStaff('SUPPORT'); // no provider permissions
    expect((await request(app).get('/api/v1/admin/providers').set(auth(support.token))).status).toBe(403);
    const finance = await createStaff('FINANCE'); // providers.view only
    expect((await request(app).get('/api/v1/admin/routing/rules').set(auth(finance.token))).status).toBe(200);
    expect((await request(app).post('/api/v1/admin/routing/rules').set(auth(finance.token)).send({ name: 'Nope' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/providers/${ids.MTN}`).set(auth(finance.token)).send({ priority: 1 })).status).toBe(403);
  });

  it('the overview shows real capacity and margin figures', async () => {
    const res = await request(app).get('/api/v1/admin/providers/overview?range=all').set(auth(sa));
    expect(res.status).toBe(200);
    const sum = (await prisma.smsProvider.aggregate({ _sum: { capacityBalance: true } }))._sum.capacityBalance;
    expect(res.body.data.capacity.remaining).toBe(sum);
    expect(res.body.data.counts.providers).toBeGreaterThanOrEqual(3);
    const cost = (await prisma.smsRecipient.aggregate({ where: { capacityReleased: false }, _sum: { providerCost: true } }))._sum.providerCost!;
    expect(res.body.data.economics.providerCost).toBe(cost.toDecimalPlaces(2).toFixed(2));
  });
});
