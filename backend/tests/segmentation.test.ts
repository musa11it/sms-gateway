import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { dispatchMessage } from '../src/modules/sms/sms.service';
import { applyLedgerEntry } from '../src/modules/wallet/wallet.service';
import { calculateSegments } from '../src/utils/segmentation';
import { app, balanceOf, createActiveOrg, createStaff, resetDatabase } from './helpers';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const DEFAULTS = { gsm7SingleSegment: 160, gsm7MultiSegment: 153, ucs2SingleSegment: 70, ucs2MultiSegment: 67 };
const CONFIG = { ...DEFAULTS, maxMessageCharacters: 1600 };
let superToken = '';

async function credit(organizationId: string, amount: number) {
  await prisma.$transaction((tx) => applyLedgerEntry(tx, { organizationId, type: 'ADMIN_CREDIT', amount, reference: `t:${crypto.randomUUID()}`, description: 'Test credit' }));
}
const putConfig = (body: Record<string, unknown>, token = superToken) => request(app).put('/api/v1/admin/settings/sms-segmentation').set(auth(token)).send({ reason: 'Test change', ...body });

let seq = 3000;
const numbers = (prefix: string, n: number) => Array.from({ length: n }, () => `${prefix}${String(1_000_000 + seq++ * 3).slice(-7).replace(/0000$/, '0003')}`);

beforeAll(async () => {
  await resetDatabase();
  superToken = (await createStaff('SUPER_ADMIN')).token;
});

describe('segmentation rules (pure)', () => {
  it.each([
    [1, 1],
    [152, 1],
    [153, 1],
    [154, 1],
    [160, 1],
    [161, 2],
    [306, 2],
    [307, 3],
  ])('GSM-7 %i characters → %i segment(s)', (n, segments) => {
    expect(calculateSegments('a'.repeat(n), DEFAULTS)).toMatchObject({ encoding: 'GSM7', characterCount: n, units: n, segments });
  });

  it.each([
    [1, 1],
    [66, 1],
    [67, 1],
    [68, 1],
    [70, 1],
    [71, 2],
    [134, 2],
    [135, 3],
  ])('Unicode %i characters → %i segment(s)', (n, segments) => {
    expect(calculateSegments('ą'.repeat(n), DEFAULTS)).toMatchObject({ encoding: 'UCS2', characterCount: n, segments });
  });

  it('detects encoding from the GSM-7 alphabet, not ASCII', () => {
    expect(calculateSegments('Hello, how are you?', DEFAULTS).encoding).toBe('GSM7');
    expect(calculateSegments('Café, señor, Ærø — no', DEFAULTS).encoding).toBe('UCS2'); // em dash is not GSM-7
    expect(calculateSegments('Café, señor, Ærø', DEFAULTS).encoding).toBe('GSM7'); // accented GSM-7 letters
    expect(calculateSegments('Price: 10€ [promo]', DEFAULTS)).toMatchObject({ encoding: 'GSM7', units: 21 }); // € [ ] cost 2 septets
    expect(calculateSegments('Muraho, amakuru?', DEFAULTS).encoding).toBe('GSM7'); // Kinyarwanda
    expect(calculateSegments('Ɛte sɛn?', DEFAULTS).encoding).toBe('UCS2'); // Twi letters
    expect(calculateSegments('مرحبا بك', DEFAULTS)).toMatchObject({ encoding: 'UCS2', characterCount: 8, segments: 1 });
    expect(calculateSegments('您好，欢迎', DEFAULTS)).toMatchObject({ encoding: 'UCS2', characterCount: 5, segments: 1 });
  });

  it('counts emoji and combining characters as people see them, but bills encoding units', () => {
    expect(calculateSegments('👍', DEFAULTS)).toMatchObject({ encoding: 'UCS2', characterCount: 1, units: 2 });
    expect(calculateSegments('👍🏽', DEFAULTS)).toMatchObject({ characterCount: 1, units: 4 }); // skin-tone modifier
    expect(calculateSegments('👨‍👩‍👧', DEFAULTS)).toMatchObject({ characterCount: 1, units: 8 }); // ZWJ family
    expect(calculateSegments('é', DEFAULTS)).toMatchObject({ encoding: 'UCS2', characterCount: 1, units: 2 }); // e + combining acute
    // 66 letters + an emoji = 68 units > 67 per part, and a surrogate pair is never split.
    expect(calculateSegments('ą'.repeat(66) + '👍' + 'ą'.repeat(10), DEFAULTS).segments).toBe(2);
    expect(calculateSegments('😀'.repeat(35), DEFAULTS)).toMatchObject({ characterCount: 35, units: 70, segments: 1 });
    expect(calculateSegments('😀'.repeat(36), DEFAULTS)).toMatchObject({ units: 72, segments: 2 });
  });

  it('handles mixed content, empty and very long messages', () => {
    expect(calculateSegments('Order #123 confirmed ✅', DEFAULTS).encoding).toBe('UCS2');
    expect(calculateSegments('', DEFAULTS)).toMatchObject({ characterCount: 0, segments: 0 });
    expect(calculateSegments('a'.repeat(10_000), DEFAULTS).segments).toBe(Math.ceil(10_000 / 153));
  });

  it('uses whatever limits it is given (no built-in business values)', () => {
    const custom = { gsm7SingleSegment: 150, gsm7MultiSegment: 140, ucs2SingleSegment: 60, ucs2MultiSegment: 50 };
    expect(calculateSegments('a'.repeat(150), custom).segments).toBe(1);
    expect(calculateSegments('a'.repeat(151), custom).segments).toBe(2);
    expect(calculateSegments('a'.repeat(281), custom).segments).toBe(3);
    expect(calculateSegments('ą'.repeat(101), custom).segments).toBe(3);
  });
});

describe('segmentation configuration', () => {
  it('starts at version 1 with the previous fixed values', async () => {
    const res = await request(app).get('/api/v1/admin/settings/sms-segmentation').set(auth(superToken));
    expect(res.status).toBe(200);
    expect(res.body.data.active).toMatchObject({ version: 1, gsm7: { singleSegment: 160, multiSegment: 153 }, ucs2: { singleSegment: 70, multiSegment: 67 }, maxMessageCharacters: 1600 });
  });

  it.each<[Record<string, number>, string]>([
    [{ gsm7SingleSegment: 0 }, 'zero'],
    [{ gsm7MultiSegment: -5 }, 'negative'],
    [{ gsm7SingleSegment: 200 }, 'above the physical GSM-7 limit'],
    [{ ucs2MultiSegment: 68 }, 'above the physical UCS-2 multipart limit'],
    [{ gsm7SingleSegment: 140, gsm7MultiSegment: 150 }, 'multipart larger than single'],
    [{ maxMessageCharacters: 0 }, 'zero maximum length'],
    [{ gsm7SingleSegment: 150.5 }, 'fractional'],
  ])('rejects %o (%s)', async (patch) => {
    const res = await putConfig({ ...CONFIG, ...patch });
    expect(res.status).toBe(422);
  });

  it('requires a reason and settings.update; customers and read-only staff cannot change it', async () => {
    expect((await request(app).put('/api/v1/admin/settings/sms-segmentation').set(auth(superToken)).send({ ...CONFIG, gsm7MultiSegment: 152 })).status).toBe(422);
    const { token } = await createActiveOrg();
    expect((await putConfig({ ...CONFIG, gsm7MultiSegment: 152 }, token)).status).toBe(403);
    const support = await createStaff('SUPPORT');
    expect((await putConfig({ ...CONFIG, gsm7MultiSegment: 152 }, support.token)).status).toBe(403);
    expect((await putConfig(CONFIG)).body.code).toBe('SEGMENTATION_UNCHANGED');
  });

  it('versions every change, keeps history immutable and audits old → new', async () => {
    const { org, token, sender } = await createActiveOrg();
    await credit(org.id, 100);
    // Sent under version 1: 300 GSM-7 chars = 2 segments.
    const before = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'a'.repeat(300), recipients: numbers('+25078', 1) });
    expect(before.body.data.segments).toBe(2);

    const res = await putConfig({ ...CONFIG, gsm7MultiSegment: 140, ucs2MultiSegment: 66, reason: 'Provider changed UDH handling' });
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);

    // Same text now needs 3 segments (300 / 140), the old message still shows 2 under version 1.
    const est = await request(app).post('/api/v1/sms/estimate').set(auth(token)).send({ message: 'a'.repeat(300) });
    expect(est.body.data).toMatchObject({ segmentCount: 3, segmentationVersion: 2, charactersPerMultipartSegment: 140 });
    const old = await prisma.smsMessage.findUniqueOrThrow({ where: { id: before.body.data.id } });
    expect(old).toMatchObject({ segments: 2, characterCount: 300, encoding: 'GSM7', totalCredits: 2, segmentationVersion: 1 });
    const after = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'a'.repeat(300), recipients: numbers('+25078', 1) });
    expect(await prisma.smsMessage.findUniqueOrThrow({ where: { id: after.body.data.id } })).toMatchObject({ segments: 3, totalCredits: 3, segmentationVersion: 2 });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'SMS_SEGMENTATION_CONFIG_UPDATED' }, orderBy: { createdAt: 'desc' } });
    expect(log.metadata).toMatchObject({
      configType: 'SMS_SEGMENTATION',
      fromVersion: 1,
      toVersion: 2,
      reason: 'Provider changed UDH handling',
      changes: { gsm7MultiSegment: { from: 153, to: 140 }, ucs2MultiSegment: { from: 67, to: 66 } },
    });
    await expect(prisma.smsSegmentationConfig.update({ where: { version: 1 }, data: { gsm7MultiSegment: 100 } })).rejects.toThrow(/append-only/);

    // Restore the defaults as version 3 for the tests below.
    expect((await putConfig({ ...CONFIG, reason: 'Back to defaults' })).body.data.version).toBe(3);
  });

  it('enforces the configured maximum message length on every send path', async () => {
    const { org, token, sender } = await createActiveOrg();
    await credit(org.id, 100);
    await putConfig({ ...CONFIG, maxMessageCharacters: 200, reason: 'Shorter messages' }).expect(200);
    const dash = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'a'.repeat(201), recipients: numbers('+25078', 1) });
    expect(dash.body.code).toBe('MESSAGE_TOO_LONG');
    const campaign = await request(app).post('/api/v1/campaigns').set(auth(token)).send({ name: 'Too long', senderId: sender.id, message: 'a'.repeat(201), phones: numbers('+25078', 1) });
    expect(campaign.body.code).toBe('MESSAGE_TOO_LONG');
    const est = await request(app).post('/api/v1/sms/estimate').set(auth(token)).send({ message: 'a'.repeat(201) });
    expect(est.body.data).toMatchObject({ tooLong: true, maxMessageCharacters: 200 });
    expect(await balanceOf(org.id)).toBe(100);
    await putConfig({ ...CONFIG, reason: 'Restore' }).expect(200);
  });
});

describe('billing by segments', () => {
  it('500 recipients × 200 GSM-7 characters = 1,000 credits (balance 10,000 → 9,000)', async () => {
    const { org, token, sender } = await createActiveOrg();
    await credit(org.id, 10_000);
    const recipients = [...numbers('+25078', 300), ...numbers('+25072', 200)];
    const quote = await request(app).post('/api/v1/sms/quote').set(auth(token)).send({ message: 'a'.repeat(200), recipients });
    expect(quote.body.data).toMatchObject({ recipientCount: 500, segments: 2, encoding: 'GSM7', characterCount: 200, totalCredits: 1000, balance: 10_000, remainingAfterSend: 9000 });

    const mtn = await prisma.smsProvider.findUniqueOrThrow({ where: { code: 'MTN' } });
    const airtel = await prisma.smsProvider.findUniqueOrThrow({ where: { code: 'AIRTEL' } });
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'a'.repeat(200), recipients, segments: 1, totalCredits: 500 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ segments: 2, totalCredits: 1000 });
    expect(await balanceOf(org.id)).toBe(9000);

    // Provider capacity is reserved in segments, split by route: MTN 300 × 2, Airtel 200 × 2.
    const ledger = await prisma.providerCapacityLedger.findMany({ where: { reference: { startsWith: `usage:${res.body.data.id}` } } });
    expect(ledger.find((l) => l.providerId === mtn.id)!.amount).toBe(-600);
    expect(ledger.find((l) => l.providerId === airtel.id)!.amount).toBe(-400);
    // Provider cost is snapshotted per recipient as cost per segment × segments.
    const r = await prisma.smsRecipient.findFirstOrThrow({ where: { messageId: res.body.data.id, providerId: mtn.id } });
    expect(r.providerCost!.toFixed(4)).toBe(mtn.totalSpent.div(mtn.totalPurchased).mul(2).toDecimalPlaces(4).toFixed(4));
    await dispatchMessage(res.body.data.id);
    expect(await balanceOf(org.id)).toBe(9000);
  });

  it('Unicode messages are billed with Unicode limits (80 characters = 2 credits)', async () => {
    const { org, token, sender } = await createActiveOrg();
    await credit(org.id, 10);
    const res = await request(app).post('/api/v1/sms/send').set(auth(token)).send({ senderId: sender.id, message: 'ą'.repeat(80), recipients: numbers('+25078', 1) });
    expect(res.body.data).toMatchObject({ encoding: 'UCS2', segments: 2, totalCredits: 2 });
    expect(await balanceOf(org.id)).toBe(8);
  });

  it('the public API recalculates on the server and ignores client segment counts', async () => {
    const { org, token, sender } = await createActiveOrg();
    await credit(org.id, 50);
    const key = await request(app).post('/api/v1/developer/api-keys').set(auth(token)).send({ name: 'Backend' });
    const secret = key.body.data.secret;
    const est = await request(app).post('/api/v1/public/sms/estimate').set(auth(secret)).send({ message: 'a'.repeat(200) });
    expect(est.body.data).toMatchObject({ encoding: 'GSM7', characterCount: 200, segmentCount: 2, creditsPerRecipient: 2 });
    const res = await request(app)
      .post('/api/v1/public/sms/send')
      .set(auth(secret))
      .send({ sender: sender.name, recipients: numbers('+25078', 3), message: 'a'.repeat(200), segments: 1, credits: 1, encoding: 'GSM7' });
    expect(res.status).toBe(201);
    expect(await balanceOf(org.id)).toBe(44);
  });
});
