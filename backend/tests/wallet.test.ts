import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { PaymentProviderFactory } from '../src/integrations/payments/PaymentProviderFactory';
import type { SimulationPaymentProvider } from '../src/integrations/payments/SimulationPaymentProvider';
import { handleProviderWebhook, verifyAndApply } from '../src/modules/payments/payment.service';
import { applyLedgerEntry } from '../src/modules/wallet/wallet.service';
import { signPayload } from '../src/utils/crypto';
import { env } from '../src/config/env';
import { app, balanceOf, createActiveOrg, createStaff, resetDatabase } from './helpers';

beforeAll(resetDatabase);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function startPurchase(token: string) {
  const res = await request(app).post('/api/v1/payments').set(auth(token)).send({ quantity: 1000, method: 'MOBILE_MONEY', payerPhone: '0788123456' });
  expect(res.status).toBe(201);
  return res.body.data.payment as { id: string; providerReference: string; amount: string; credits: number };
}

describe('purchase & payment verification', () => {
  it('uses server-side pricing and never trusts client amounts', async () => {
    const { token } = await createActiveOrg();
    const res = await request(app).post('/api/v1/payments').set(auth(token)).send({ quantity: 1000, method: 'MOBILE_MONEY', payerPhone: '0788123456', amount: '1', credits: 999999 });
    expect(res.body.data.payment.amount).toBe('13000.00');
    expect(res.body.data.payment.credits).toBe(1000);
  });

  it('does not credit until the provider confirms, then credits exactly once', async () => {
    const { org, token } = await createActiveOrg();
    const payment = await startPurchase(token);
    await verifyAndApply(payment.id);
    expect(await balanceOf(org.id)).toBe(0);

    const provider = PaymentProviderFactory.getActive() as SimulationPaymentProvider;
    await provider.simulatePayerAction(payment.providerReference, 'APPROVE');
    await Promise.all([verifyAndApply(payment.id), verifyAndApply(payment.id), verifyAndApply(payment.id)]);
    await verifyAndApply(payment.id);

    expect(await balanceOf(org.id)).toBe(1000);
    expect(await prisma.walletTransaction.count({ where: { organizationId: org.id, type: 'PURCHASE' } })).toBe(1);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { paymentId: payment.id } });
    expect(invoice.total.toFixed(2)).toBe('13000.00');
    expect(invoice.number).toMatch(/^INV-\d{4}-\d{6}$/);
  });

  it('deduplicates webhooks and rejects bad signatures', async () => {
    const { org, token } = await createActiveOrg();
    const payment = await startPurchase(token);
    const provider = PaymentProviderFactory.getActive() as SimulationPaymentProvider;
    await provider.simulatePayerAction(payment.providerReference, 'APPROVE');
    const body = JSON.stringify({ event_id: 'evt_dup_1', type: 'payment.succeeded', data: { transaction_ref: payment.providerReference } });
    const headers = { 'x-simpay-signature': signPayload(env.PAYMENT_WEBHOOK_SECRET, body) };
    expect((await handleProviderWebhook('simulation', headers, body)).duplicate).toBe(false);
    expect((await handleProviderWebhook('simulation', headers, body)).duplicate).toBe(true);
    expect(await balanceOf(org.id)).toBe(1000);

    const forged = await request(app).post('/api/v1/callbacks/payments/simulation').set('content-type', 'application/json').set('x-simpay-signature', 't=1,v1=abc').send(body);
    expect(forged.status).toBe(401);
  });

  it('declined payments never credit', async () => {
    const { org, token } = await createActiveOrg();
    const payment = await startPurchase(token);
    await (PaymentProviderFactory.getActive() as SimulationPaymentProvider).simulatePayerAction(payment.providerReference, 'DECLINE');
    const p = await verifyAndApply(payment.id);
    expect(p.status).toBe('FAILED');
    expect(await balanceOf(org.id)).toBe(0);
  });

  it('refunds reverse credits exactly once', async () => {
    const { org, token } = await createActiveOrg();
    const payment = await startPurchase(token);
    await (PaymentProviderFactory.getActive() as SimulationPaymentProvider).simulatePayerAction(payment.providerReference, 'APPROVE');
    await verifyAndApply(payment.id);
    const finance = await createStaff('FINANCE');
    const r1 = await request(app).post(`/api/v1/admin/billing/payments/${payment.id}/refund`).set(auth(finance.token)).send({ reason: 'Customer request' });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/api/v1/admin/billing/payments/${payment.id}/refund`).set(auth(finance.token)).send({ reason: 'Customer request' });
    expect(r2.status).toBe(409);
    expect(await balanceOf(org.id)).toBe(0);
  });
});

describe('ledger', () => {
  it('debits, prevents negative balances and records before/after', async () => {
    const { org } = await createActiveOrg({ credits: 50 });
    const r = await prisma.$transaction((tx) => applyLedgerEntry(tx, { organizationId: org.id, type: 'SMS_DEBIT', amount: -20, reference: 'debit-1', description: 't' }));
    expect(r.transaction).toMatchObject({ balanceBefore: 50, balanceAfter: 30, amount: -20 });
    await expect(prisma.$transaction((tx) => applyLedgerEntry(tx, { organizationId: org.id, type: 'SMS_DEBIT', amount: -31, reference: 'debit-2', description: 't' }))).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    expect(await balanceOf(org.id)).toBe(30);
  });

  it('concurrent debits can never overdraw the wallet', async () => {
    const { org } = await createActiveOrg({ credits: 100 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => prisma.$transaction((tx) => applyLedgerEntry(tx, { organizationId: org.id, type: 'SMS_DEBIT', amount: -30, reference: `c-${org.id}-${i}`, description: 't' }))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(await balanceOf(org.id)).toBe(10);
  });

  it('the same reference is applied only once', async () => {
    const { org } = await createActiveOrg({ credits: 10 });
    const entry = { organizationId: org.id, type: 'REFUND' as const, amount: 5, reference: `refund-x-${org.id}`, description: 't' };
    await prisma.$transaction((tx) => applyLedgerEntry(tx, entry));
    const again = await prisma.$transaction((tx) => applyLedgerEntry(tx, entry));
    expect(again.duplicate).toBe(true);
    expect(await balanceOf(org.id)).toBe(15);
  });

  it('ledger and audit rows are immutable at the database level', async () => {
    const tx = await prisma.walletTransaction.findFirstOrThrow();
    await expect(prisma.walletTransaction.update({ where: { id: tx.id }, data: { amount: 999999 } })).rejects.toThrow(/append-only/);
    await expect(prisma.walletTransaction.delete({ where: { id: tx.id } })).rejects.toThrow(/append-only/);
    const log = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow(/append-only/);
  });

  it('admin adjustments require reason + reference and are audited', async () => {
    const { org } = await createActiveOrg();
    const sa = await createStaff('SUPER_ADMIN');
    const noReason = await request(app).post(`/api/v1/admin/billing/wallets/${org.id}/adjust`).set(auth(sa.token)).send({ kind: 'CREDIT', amount: 100, reference: 'X-1' });
    expect(noReason.status).toBe(422);
    const ok = await request(app).post(`/api/v1/admin/billing/wallets/${org.id}/adjust`).set(auth(sa.token)).send({ kind: 'CREDIT', amount: 100, reason: 'Goodwill credit', reference: 'TKT-42' });
    expect(ok.status).toBe(200);
    const dup = await request(app).post(`/api/v1/admin/billing/wallets/${org.id}/adjust`).set(auth(sa.token)).send({ kind: 'CREDIT', amount: 100, reason: 'Goodwill credit', reference: 'TKT-42' });
    expect(dup.status).toBe(409);
    expect(await balanceOf(org.id)).toBe(100);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: 'WALLET_CREDITED', actorId: sa.user.id } })).toBe(1);
  });
});
