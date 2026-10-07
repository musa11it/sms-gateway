import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { dispatchMessage, pollPendingDeliveryStatuses, rejectUnacceptedMessages } from '../src/modules/sms/sms.service';
import { applyLedgerEntry } from '../src/modules/wallet/wallet.service';
import { app, balanceOf, createActiveOrg, createStaff, resetDatabase } from './helpers';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let sa = '';
const ids: Record<string, string> = {};

const provider = (code: string) => prisma.smsProvider.findUniqueOrThrow({ where: { code } });
const setProvider = (code: string, data: Record<string, unknown>) => prisma.smsProvider.update({ where: { code }, data });
const simulate = (body: Record<string, unknown>) => request(app).post('/api/v1/admin/routing/simulate').set(auth(sa)).send({ recipients: 1, message: 'Hello', ...body });
const createRule = (body: Record<string, unknown>) => request(app).post('/api/v1/admin/routing/rules').set(auth(sa)).send(body);

async function credit(organizationId: string, amount: number) {
  await prisma.$transaction((tx) => applyLedgerEntry(tx, { organizationId, type: 'ADMIN_CREDIT', amount, reference: `t:${crypto.randomUUID()}`, description: 'Test credit' }));
}

/** Sends to the given numbers as a fresh customer with `credits` credits. */
async function send(recipients: string[], opts: { credits?: number; message?: string } = {}) {
  const { org, token, sender } = await createActiveOrg();
  if (opts.credits !== 0) await credit(org.id, opts.credits ?? 100);
  const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: opts.message ?? 'Hello', recipients });
  return { res, org };
}

const capacities = async () => Object.fromEntries((await prisma.smsProvider.findMany()).map((p) => [p.code, p.capacityBalance]));

beforeAll(async () => {
  await resetDatabase();
  sa = (await createStaff('SUPER_ADMIN')).token;
  for (const c of ['MTN', 'AIRTEL', 'GENERIC']) ids[c] = (await provider(c)).id;
});

beforeEach(async () => {
  await prisma.smsRoutingRule.updateMany({ data: { isActive: false } });
  await setProvider('MTN', { status: 'ACTIVE', health: 'HEALTHY', priority: 10, costPerSms: 8, minimumCapacity: 0, supportsSenderId: true });
  await setProvider('AIRTEL', { status: 'ACTIVE', health: 'HEALTHY', priority: 10, costPerSms: 8.5, minimumCapacity: 0, supportsSenderId: true });
  await setProvider('GENERIC', { status: 'ACTIVE', health: 'HEALTHY', priority: 100, costPerSms: 11, minimumCapacity: 0, supportsSenderId: true });
});

describe('destination validation', () => {
  it('accepts a valid Rwanda MTN number and routes it to MTN', async () => {
    const s = (await simulate({ phone: '+250788123456' })).body.data;
    expect(s).toMatchObject({ outcome: 'ROUTED', validation: { ok: true, phone: '+250788123456' }, destination: { countryCode: 'RW', network: { code: 'RW-MTN' } }, selected: { name: 'MTN Rwanda' } });
  });

  it('accepts a valid Rwanda Airtel number and routes it to Airtel', async () => {
    const s = (await simulate({ phone: '+250722123456' })).body.data;
    expect(s).toMatchObject({ outcome: 'ROUTED', destination: { network: { code: 'RW-AIRTEL' } }, selected: { name: 'Airtel Rwanda' } });
  });

  it('accepts a valid Kenya number on a country without network configuration (country-wide provider)', async () => {
    const s = (await simulate({ phone: '+254712345678' })).body.data;
    expect(s).toMatchObject({ outcome: 'ROUTED', destination: { countryCode: 'KE', countryName: 'Kenya', network: null }, selected: { name: 'Aggregator' } });
  });

  it.each([
    ['too long', '+25478706573423'],
    ['too short', '+2547123456'],
  ])('rejects a Kenya number that is %s before routing, without charging', async (_, phone) => {
    const s = (await simulate({ phone })).body.data;
    expect(s.outcome).toBe('REJECTED_BEFORE_ROUTING');
    expect(s.validation).toMatchObject({ ok: false, code: 'INVALID_NUMBER' });
    expect(s.validation.reason).toMatch(/Invalid destination number: invalid length\/format for Kenya/);
    expect(s.selected).toBeNull();

    const before = await capacities();
    const { res, org } = await send([phone]);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_RECIPIENTS');
    expect(await balanceOf(org.id)).toBe(100);
    expect(await capacities()).toEqual(before);
  });

  it('rejects an invalid country code', async () => {
    const s = (await simulate({ phone: '+999123456789' })).body.data;
    expect(s).toMatchObject({ outcome: 'REJECTED_BEFORE_ROUTING', validation: { ok: false, code: 'INVALID_NUMBER' } });
    const { res } = await send(['+999123456789']);
    expect(res.status).toBe(422);
  });

  it('rejects a valid number in a country that is not configured', async () => {
    const s = (await simulate({ phone: '+256712345678' })).body.data;
    expect(s).toMatchObject({ outcome: 'REJECTED_BEFORE_ROUTING', validation: { ok: false, code: 'UNSUPPORTED_COUNTRY' } });
    expect(s.validation.reason).toMatch(/Uganda \(UG\) is not configured/);
    const { res, org } = await send(['+256712345678']);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Destination not supported/);
    expect(await balanceOf(org.id)).toBe(100);
  });

  it('rejects numbers of an inactive country', async () => {
    const ke = await prisma.smsCountry.findUniqueOrThrow({ where: { isoCode: 'KE' } });
    await request(app).patch(`/api/v1/admin/routing/countries/${ke.id}`).set(auth(sa)).send({ isActive: false }).expect(200);
    try {
      expect((await simulate({ phone: '+254712345678' })).body.data.outcome).toBe('REJECTED_BEFORE_ROUTING');
    } finally {
      await request(app).patch(`/api/v1/admin/routing/countries/${ke.id}`).set(auth(sa)).send({ isActive: true }).expect(200);
    }
  });
});

describe('destination management', () => {
  it('validates countries and networks', async () => {
    expect((await request(app).post('/api/v1/admin/routing/countries').set(auth(sa)).send({ isoCode: 'ZZ' })).status).toBe(422);
    const tz = await request(app).post('/api/v1/admin/routing/countries').set(auth(sa)).send({ isoCode: 'TZ', nationalNumberLengths: [9] });
    expect(tz.status, JSON.stringify(tz.body)).toBe(201);
    expect(tz.body.data).toMatchObject({ isoCode: 'TZ', name: 'Tanzania', callingCode: '255', status: 'NO_PROVIDER' });

    const net = (body: Record<string, unknown>) => request(app).post('/api/v1/admin/routing/networks').set(auth(sa)).send({ code: 'TZ-VOD', name: 'Vodacom Tanzania', countryCode: 'TZ', prefixes: ['+25575'], ...body });
    expect(JSON.stringify((await net({ prefixes: [] })).body)).toMatch(/At least one valid prefix is required/);
    expect((await net({ prefixes: ['+25478'] })).status).toBe(422); // Kenyan prefix in Tanzania
    expect((await net({ countryCode: 'UG' })).status).toBe(422); // country not configured
    expect((await net({ prefixes: ['+25078'], countryCode: 'RW', code: 'RW-DUP' })).body.code).toBe('PREFIX_IN_USE');
    expect((await net({})).status).toBe(201);
  });

  it('deletes a country only when nothing depends on it', async () => {
    const del = (id: string) => request(app).delete(`/api/v1/admin/routing/countries/${id}`).set(auth(sa));
    const zm = await request(app).post('/api/v1/admin/routing/countries').set(auth(sa)).send({ isoCode: 'ZM', providerIds: [ids.GENERIC] });
    expect((await send(['+260971234567'])).res.status).toBe(201);
    expect((await del(zm.body.data.id)).body.code).toBe('COUNTRY_HAS_HISTORY');
    const mz = await request(app).post('/api/v1/admin/routing/countries').set(auth(sa)).send({ isoCode: 'MZ', providerIds: [ids.GENERIC] });
    const vod = await request(app).post('/api/v1/admin/routing/networks').set(auth(sa)).send({ code: 'MZ-VOD', name: 'Vodacom Mozambique', countryCode: 'MZ', prefixes: ['+25884'] });
    await createRule({ name: 'MZ rule', networkId: vod.body.data.id, strategy: 'LOWEST_COST' }).expect(201);
    expect((await del(mz.body.data.id)).body.code).toBe('COUNTRY_IN_USE');
    await prisma.smsRoutingRule.deleteMany({ where: { networkId: vod.body.data.id } });
    expect((await del(mz.body.data.id)).status).toBe(200);
    expect(await prisma.smsCountry.count({ where: { isoCode: 'MZ' } })).toBe(0);
    expect(await prisma.smsNetwork.count({ where: { countryCode: 'MZ' } })).toBe(0);
    expect(await prisma.smsProviderCountry.count({ where: { countryId: mz.body.data.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'ROUTING_COUNTRY_DELETED', resourceId: mz.body.data.id } })).toBe(1);
  });

  it('refuses a configured destination no provider can serve, and charges nothing', async () => {
    const s = (await simulate({ phone: '+255754123456' })).body.data;
    expect(s.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(s.rejected.every((r: { code: string }) => r.code === 'UNSUPPORTED_DESTINATION')).toBe(true);
    expect(s.reason).toMatch(/No provider is configured for this destination/);

    const before = await capacities();
    const { res, org } = await send(['+255754123456']);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DESTINATION_NOT_SUPPORTED');
    expect(await balanceOf(org.id)).toBe(100);
    expect(await capacities()).toEqual(before);
  });

  it('shows only configured destinations with a status in the overview', async () => {
    const rows = (await request(app).get('/api/v1/admin/routing/overview').set(auth(sa))).body.data as { destination: string; status: string }[];
    expect(rows.find((r) => r.destination === 'Rwanda / MTN Rwanda')?.status).toBe('CONFIGURED');
    expect(rows.find((r) => r.destination === 'Kenya')?.status).toBe('CONFIGURED');
    expect(rows.find((r) => r.destination === 'Tanzania / Vodacom Tanzania')?.status).toBe('UNSUPPORTED');
    expect(rows.some((r) => r.destination.includes('Uganda'))).toBe(false);
  });
});

describe('provider eligibility', () => {
  it.each([
    ['inactive', { status: 'INACTIVE' }, 'PROVIDER_INACTIVE'],
    ['unhealthy', { health: 'DOWN' }, 'PROVIDER_DOWN'],
    ['below its reserve', { minimumCapacity: 1_000_000_000 }, 'BELOW_RESERVE'],
    ['without sender ID support', { supportsSenderId: false }, 'SENDER_ID_UNSUPPORTED'],
  ])('skips an %s provider and falls back to another that serves the destination', async (_, data, code) => {
    await setProvider('MTN', data);
    const s = (await simulate({ phone: '+250788123456' })).body.data;
    expect(s.rejected.find((r: { name: string }) => r.name === 'MTN Rwanda')?.code).toBe(code);
    expect(s.selected.name).toBe('Aggregator');
  });

  it('rejects providers above the rule maximum cost', async () => {
    await createRule({ name: 'Cheap only', countryCode: 'RW', strategy: 'LOWEST_COST', maxCostPerSegment: '9' }).expect(201);
    const s = (await simulate({ phone: '+250788123456' })).body.data;
    expect(s.rejected.find((r: { name: string }) => r.name === 'Aggregator')?.code).toBe('COST_ABOVE_MAXIMUM');
    expect(s.selected.name).toBe('MTN Rwanda');
  });

  it('refuses the send when no provider has enough usable capacity, without charging', async () => {
    await setProvider('MTN', { minimumCapacity: 1_000_000_000 });
    await setProvider('GENERIC', { minimumCapacity: 1_000_000_000 });
    const s = (await simulate({ phone: '+250788123456' })).body.data;
    expect(s.outcome).toBe('NO_CAPACITY');
    expect(s.reason).toMatch(/No provider has enough usable capacity/);
    const before = await capacities();
    const { res, org } = await send(['+250788123456']);
    expect(res.status).toBe(503);
    expect(await balanceOf(org.id)).toBe(100);
    expect(await capacities()).toEqual(before);
  });
});

describe('routing strategies', () => {
  it('fails over from primary to backup', async () => {
    await createRule({ name: 'MTN primary', networkId: (await prisma.smsNetwork.findUniqueOrThrow({ where: { code: 'RW-MTN' } })).id, strategy: 'PRIMARY_BACKUP', primaryProviderId: ids.MTN, backupProviderIds: [ids.GENERIC] }).expect(201);
    expect((await simulate({ phone: '+250788123456' })).body.data).toMatchObject({ strategy: 'PRIMARY_BACKUP', selected: { name: 'MTN Rwanda' }, backup: { name: 'Aggregator' } });
    await setProvider('MTN', { health: 'DOWN' });
    const s = (await simulate({ phone: '+250788123456' })).body.data;
    expect(s.selected.name).toBe('Aggregator');
    expect(s.reason).toMatch(/^Backup provider/);
  });

  it('picks the lowest cost eligible provider', async () => {
    await setProvider('MTN', { costPerSms: 12 });
    await createRule({ name: 'Cheapest RW', countryCode: 'RW', strategy: 'LOWEST_COST' }).expect(201);
    const s = (await simulate({ phone: '+250788123456' })).body.data;
    expect(s).toMatchObject({ strategy: 'LOWEST_COST', selected: { name: 'Aggregator' } });
    expect(s.reason).toMatch(/Lowest eligible cost/);
  });

  it('picks the highest priority eligible provider', async () => {
    await setProvider('GENERIC', { priority: 1 });
    await createRule({ name: 'Priority RW', countryCode: 'RW', strategy: 'PRIORITY' }).expect(201);
    expect((await simulate({ phone: '+250788123456' })).body.data).toMatchObject({ strategy: 'PRIORITY', selected: { name: 'Aggregator' } });
  });

  it('routes a real send exactly as the simulator predicts', async () => {
    await setProvider('MTN', { costPerSms: 12 });
    await createRule({ name: 'Cheapest RW', countryCode: 'RW', strategy: 'LOWEST_COST' }).expect(201);
    for (const phone of ['+250788123456', '+250722123456', '+254712345678']) {
      const predicted = (await simulate({ phone })).body.data.selected.providerId;
      const { res } = await send([phone]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const r = await prisma.smsRecipient.findFirstOrThrow({ where: { messageId: res.body.data.id } });
      expect(r.providerId).toBe(predicted);
      expect(r.countryCode).toBe(phone.startsWith('+254') ? 'KE' : 'RW');
    }
  });
});

describe('credits', () => {
  it('reports insufficient credits in the simulator and refuses the real send without charging', async () => {
    const { org } = await createActiveOrg();
    await credit(org.id, 1);
    const s = (await simulate({ phone: '+250788123456', organizationId: org.id, message: 'a'.repeat(200) })).body.data;
    expect(s).toMatchObject({ outcome: 'INSUFFICIENT_CREDITS', customer: { balance: 1, required: 2, sufficient: false } });
    const { res, org: o2 } = await send(['+250788123456'], { credits: 1, message: 'a'.repeat(200) });
    expect(res.status).toBe(402);
    expect(await balanceOf(o2.id)).toBe(1);
  });

  it('charges one credit per segment for multi-segment messages', async () => {
    const s = (await simulate({ phone: '+250788123456', message: 'a'.repeat(200) })).body.data;
    expect(s.message).toMatchObject({ segmentsPerRecipient: 2, totalCredits: 2 });
    const { res, org } = await send(['+250788123456'], { message: 'a'.repeat(200) });
    expect(res.status).toBe(201);
    expect(await balanceOf(org.id)).toBe(98);
  });

  it('refunds a provider rejection (REJECTED) but keeps the charge for an accepted message that fails delivery (FAILED)', async () => {
    const { res, org } = await send(['+250788123456', '+250788120000', '+250788129999']);
    expect(await balanceOf(org.id)).toBe(97);
    await dispatchMessage(res.body.data.id);
    await pollPendingDeliveryStatuses(0);
    const rs = await prisma.smsRecipient.findMany({ where: { messageId: res.body.data.id } });
    const by = (p: string) => rs.find((r) => r.phone === p)!;
    expect(by('+250788123456')).toMatchObject({ status: 'DELIVERED', refunded: false });
    expect(by('+250788120000')).toMatchObject({ status: 'REJECTED', refunded: true });
    expect(by('+250788129999')).toMatchObject({ status: 'FAILED', refunded: false });
    expect(await balanceOf(org.id)).toBe(98);
  });

  it('rejects and refunds messages no provider accepted within the timeout', async () => {
    const { res, org } = await send(['+250788123456']);
    expect(await balanceOf(org.id)).toBe(99);
    await prisma.smsRecipient.updateMany({ where: { messageId: res.body.data.id }, data: { createdAt: new Date(Date.now() - 48 * 3_600_000) } });
    await rejectUnacceptedMessages();
    const r = await prisma.smsRecipient.findFirstOrThrow({ where: { messageId: res.body.data.id } });
    expect(r).toMatchObject({ status: 'REJECTED', errorCode: 'NOT_ACCEPTED', refunded: true });
    expect(await balanceOf(org.id)).toBe(100);
  });

  it('never lets provider capacity go negative', async () => {
    expect(Object.values(await capacities()).every((c) => c >= 0)).toBe(true);
  });
});
