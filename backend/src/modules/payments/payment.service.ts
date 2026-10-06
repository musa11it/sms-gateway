import crypto from 'crypto';
import { Prisma, type Payment } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { prisma, type Tx } from '../../config/prisma';
import { PaymentProviderFactory } from '../../integrations/payments/PaymentProviderFactory';
import { SimulationPaymentProvider } from '../../integrations/payments/SimulationPaymentProvider';
import type { Actor, RequestMeta } from '../../types/actor';
import { SYSTEM_ACTOR, actorUserId } from '../../types/actor';
import { nextCounterValue } from '../../utils/counter';
import { AppError } from '../../utils/errors';
import { normalizePhone } from '../../utils/phone';
import { audit } from '../audit-logs/audit.service';
import { notifyOrganization } from '../notifications/notification.service';
import { getSetting } from '../settings/settings.service';
import { applyLedgerEntry, isDuplicateReference, scheduleLowBalanceCheck } from '../wallet/wallet.service';
import { emitWebhookEvent } from '../webhooks/webhook.service';
import { platformAverageCost } from '../providers/provider.service';
import { calculateSmsPurchasePrice } from '../pricing/pricing.service';

const FINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED']);

function newReference() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `PAY-${d}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function nextInvoiceNumber(tx: Tx) {
  const year = new Date().getFullYear();
  return `INV-${year}-${String(await nextCounterValue(tx, `invoice:${year}`)).padStart(6, '0')}`;
}

export function serializePayment(p: Payment & { invoice?: { id: string; number: string } | null }) {
  return {
    id: p.id,
    reference: p.reference,
    provider: p.provider,
    providerReference: p.providerReference,
    method: p.method,
    payerPhone: p.payerPhone,
    packageId: p.packageId,
    packageName: p.packageName,
    pricingTierId: p.pricingTierId,
    unitPrice: p.unitPrice?.toFixed(2) ?? null,
    tierMinQuantity: p.tierMinQuantity,
    tierMaxQuantity: p.tierMaxQuantity,
    creditValidityDays: p.creditValidityDays,
    credits: p.credits,
    amount: p.amount.toFixed(2),
    feeAmount: p.feeAmount.toFixed(2),
    currency: p.currency,
    status: p.status,
    failureReason: p.failureReason,
    verifiedAt: p.verifiedAt,
    creditedAt: p.creditedAt,
    refundedAt: p.refundedAt,
    createdAt: p.createdAt,
    invoice: p.invoice ? { id: p.invoice.id, number: p.invoice.number } : null,
  };
}

export async function createPayment(
  organizationId: string,
  input: { quantity: unknown; method: 'MOBILE_MONEY' | 'CARD' | 'BANK_TRANSFER'; payerPhone?: string | null },
  actor: Actor,
  meta?: RequestMeta,
) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  if (org.status === 'SUSPENDED') throw AppError.forbidden('Organization is suspended', 'ORGANIZATION_SUSPENDED');
  if (org.status !== 'ACTIVE') throw AppError.forbidden('Your organization must be approved before buying SMS', 'ORGANIZATION_NOT_APPROVED');

  // What is bought and its price are decided here, on the server — never taken from the client.
  // Customers buy any quantity; the pricing tier containing it sets the price (fixed packages were retired).
  const quote = await calculateSmsPurchasePrice(input.quantity);
  const validity = await getSetting('billing.creditValidityDays');
  const order: Pick<Prisma.PaymentUncheckedCreateInput, 'packageId' | 'packageName' | 'credits' | 'amount' | 'currency' | 'pricingTierId' | 'unitPrice' | 'tierMinQuantity' | 'tierMaxQuantity' | 'creditValidityDays'> = {
    packageId: null,
    packageName: `${quote.quantity.toLocaleString('en-US')} SMS credits`,
    credits: quote.quantity,
    amount: new Prisma.Decimal(quote.total),
    currency: quote.currency,
    pricingTierId: quote.tier.id,
    unitPrice: new Prisma.Decimal(quote.unitPrice),
    tierMinQuantity: quote.tier.minQuantity,
    tierMaxQuantity: quote.tier.maxQuantity,
    creditValidityDays: validity > 0 ? validity : null,
  };

  let payerPhone: string | null = null;
  if (input.method === 'MOBILE_MONEY') {
    payerPhone = input.payerPhone ? normalizePhone(input.payerPhone) : null;
    if (!payerPhone) throw AppError.unprocessable('A valid mobile money number is required', 'INVALID_PHONE', [{ field: 'payerPhone', message: 'Enter a valid phone number' }]);
  }

  const provider = PaymentProviderFactory.getActive();
  const payment = await prisma.payment.create({
    data: {
      organizationId,
      ...order,
      reference: newReference(),
      provider: provider.name,
      method: input.method,
      payerPhone,
      status: 'PENDING',
      createdById: actorUserId(actor),
    },
  });
  await audit({ actor, action: 'PAYMENT_CREATED', resource: 'payment', resourceId: payment.id, organizationId, metadata: { reference: payment.reference, amount: payment.amount.toFixed(2), currency: payment.currency, credits: payment.credits, unitPrice: payment.unitPrice?.toFixed(2) ?? null, pricingTierId: payment.pricingTierId }, meta });

  try {
    const init = await provider.initializePayment({
      reference: payment.reference,
      amount: payment.amount.toFixed(2),
      currency: payment.currency,
      method: input.method,
      payerPhone,
      description: payment.packageId ? `${payment.packageName} (${payment.credits.toLocaleString()} SMS credits)` : payment.packageName,
      callbackUrl: `${env.API_PUBLIC_URL}/api/v1/callbacks/payments/${provider.name}`,
    });
    const updated = await prisma.payment.update({ where: { id: payment.id }, data: { status: 'PROCESSING', providerReference: init.providerReference } });
    return { payment: serializePayment(updated), nextAction: init.nextAction, simulation: provider.isSimulation };
  } catch (err) {
    logger.error({ err, paymentId: payment.id }, 'Payment initialisation failed');
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureReason: 'Payment provider unavailable' } });
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider is unavailable. Please try again.');
  }
}

/**
 * Asks the provider for the authoritative status and applies it. Safe to call any number
 * of times from any source (webhook, polling, manual verify): crediting is idempotent.
 */
export async function verifyAndApply(paymentId: string, actor: Actor = SYSTEM_ACTOR, meta?: RequestMeta) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw AppError.notFound('Payment');
  if (FINAL.has(payment.status) || !payment.providerReference) return payment;

  const provider = PaymentProviderFactory.get(payment.provider);
  const result = await provider.verifyPayment(payment.providerReference);

  if (result.state === 'SUCCESS') {
    const amountMatches = new Prisma.Decimal(result.amount).equals(payment.amount) && result.currency === payment.currency;
    if (!amountMatches) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureReason: `Amount mismatch: provider reported ${result.amount} ${result.currency}` } });
      await audit({ actor, action: 'PAYMENT_AMOUNT_MISMATCH', resource: 'payment', resourceId: payment.id, organizationId: payment.organizationId, metadata: { expected: payment.amount.toFixed(2), reported: result.amount }, meta });
      logger.error({ paymentId: payment.id }, 'Payment amount mismatch — not crediting');
      return prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    }
    const fee = result.fee != null ? new Prisma.Decimal(result.fee) : payment.amount.mul(await getSetting('billing.paymentFeePercent')).div(100).toDecimalPlaces(2);
    await finalizeSuccess(payment, fee, actor, meta);
  } else if (result.state === 'FAILED' || result.state === 'CANCELLED') {
    const claimed = await prisma.payment.updateMany({
      where: { id: payment.id, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: result.state, failureReason: result.failureReason ?? 'Payment was not completed', verifiedAt: new Date() },
    });
    if (claimed.count === 1) {
      await audit({ actor, action: 'PAYMENT_FAILED', resource: 'payment', resourceId: payment.id, organizationId: payment.organizationId, metadata: { reason: result.failureReason }, meta });
      await notifyOrganization(payment.organizationId, { type: 'PAYMENT_FAILED', title: 'Payment failed', body: `${payment.packageName}: ${result.failureReason ?? 'the payment was not completed'}.`, link: '/app/wallet/buy' }, 'wallet.purchase');
      await emitWebhookEvent(payment.organizationId, 'payment.failed', { paymentId: payment.id, reference: payment.reference, amount: payment.amount.toFixed(2), currency: payment.currency, reason: result.failureReason }, `payment.failed:${payment.id}`);
    }
  }
  return prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
}

async function finalizeSuccess(payment: Payment, fee: Prisma.Decimal, actor: Actor, meta?: RequestMeta) {
  // Provider cost of the credits sold: explicit package estimate, else credits × platform WAC per segment.
  const pkg = payment.packageId ? await prisma.smsPackage.findUnique({ where: { id: payment.packageId } }) : null;
  const perSegment = await getSetting('sms.creditsPerSegment');
  const estimatedProviderCost = pkg?.estimatedProviderCost
    ? new Prisma.Decimal(pkg.estimatedProviderCost)
    : (await platformAverageCost()).mul(payment.credits).div(perSegment).toDecimalPlaces(2);
  let credited = false;
  let invoiceNumber = '';
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { id: payment.id, status: { in: ['PENDING', 'PROCESSING'] } },
        data: { status: 'SUCCESS', verifiedAt: new Date(), creditedAt: new Date(), feeAmount: fee },
      });
      if (claimed.count === 0) return; // already finalised by a concurrent webhook/poll
      const entry = await applyLedgerEntry(tx, {
        organizationId: payment.organizationId,
        type: 'PURCHASE',
        amount: payment.credits,
        reference: `payment:${payment.id}`,
        description: payment.unitPrice ? `Purchased ${payment.credits.toLocaleString()} SMS credits at ${payment.currency} ${payment.unitPrice.toFixed(2)}` : `Purchase: ${payment.packageName}`,
        createdById: payment.createdById,
        metadata: { paymentId: payment.id, reference: payment.reference },
        expiresAt: payment.creditValidityDays ? new Date(Date.now() + payment.creditValidityDays * 86_400_000) : null,
      });
      if (entry.duplicate) return;

      const org = await tx.organization.findUniqueOrThrow({ where: { id: payment.organizationId }, include: { members: { where: { isOwner: true }, include: { user: true } } } });
      const taxRate = new Prisma.Decimal(await getSetting('billing.taxRate'));
      const total = payment.amount;
      const subtotal = total.div(taxRate.div(100).plus(1)).toDecimalPlaces(2);
      invoiceNumber = await nextInvoiceNumber(tx);
      await tx.invoice.create({
        data: {
          number: invoiceNumber,
          organizationId: payment.organizationId,
          paymentId: payment.id,
          customerName: org.name,
          customerEmail: org.contactPersonEmail ?? org.members[0]?.user.email ?? null,
          billingAddress: [org.address, org.city, org.country].filter(Boolean).join(', ') || null,
          taxId: org.taxId,
          description: `${payment.packageName} — ${payment.credits.toLocaleString()} SMS credits`,
          quantity: payment.credits,
          unitPrice: subtotal.div(payment.credits).toDecimalPlaces(4),
          subtotal,
          taxRate,
          taxAmount: total.minus(subtotal),
          total,
          currency: payment.currency,
          status: 'PAID',
        },
      });
      // Revenue side of the business: one customer sale per verified payment (unique paymentId).
      await tx.customerPurchase.create({
        data: {
          organizationId: payment.organizationId,
          paymentId: payment.id,
          packageId: payment.packageId,
          packageName: payment.packageName,
          credits: payment.credits,
          revenue: total,
          estimatedProviderCost,
          paymentFee: fee,
          contribution: total.minus(estimatedProviderCost).minus(fee),
          currency: payment.currency,
        },
      });
      await audit({ actor, action: 'SMS_PACKAGE_PURCHASED', resource: 'customer_purchase', resourceId: payment.id, organizationId: payment.organizationId, metadata: { package: payment.packageName, credits: payment.credits, unitPrice: payment.unitPrice?.toFixed(2) ?? null, pricingTierId: payment.pricingTierId, revenue: total.toFixed(2), fee: fee.toFixed(2) }, meta }, tx);
      await audit({ actor, action: 'PAYMENT_VERIFIED', resource: 'payment', resourceId: payment.id, organizationId: payment.organizationId, metadata: { reference: payment.reference, amount: total.toFixed(2), invoice: invoiceNumber }, meta }, tx);
      await audit({ actor, action: 'WALLET_CREDITED', resource: 'wallet', resourceId: entry.transaction.walletId, organizationId: payment.organizationId, metadata: { credits: payment.credits, paymentId: payment.id, balanceAfter: entry.transaction.balanceAfter }, meta }, tx);
      credited = true;
    });
  } catch (err) {
    if (isDuplicateReference(err)) return; // credited by a concurrent finaliser
    throw err;
  }
  if (!credited) return;
  await notifyOrganization(payment.organizationId, {
    type: 'PAYMENT_SUCCESS',
    title: 'Payment successful',
    body: `${payment.credits.toLocaleString()} SMS credits were added to your wallet. Invoice ${invoiceNumber}.`,
    link: '/app/wallet/transactions',
  }, 'wallet.view');
  await emitWebhookEvent(payment.organizationId, 'payment.success', { paymentId: payment.id, reference: payment.reference, amount: payment.amount.toFixed(2), currency: payment.currency, credits: payment.credits, invoice: invoiceNumber }, `payment.success:${payment.id}`);
  await scheduleLowBalanceCheck(payment.organizationId);
}

/** Provider webhook entry point: verify signature, deduplicate the event, then verify with the provider. */
export async function handleProviderWebhook(providerName: string, headers: Record<string, string | string[] | undefined>, rawBody: string) {
  if (!PaymentProviderFactory.has(providerName)) throw AppError.notFound('Provider');
  const provider = PaymentProviderFactory.get(providerName);
  const event = await provider.parseWebhook({ headers, rawBody });
  const payment = await prisma.payment.findUnique({ where: { providerReference: event.providerReference } });
  try {
    await prisma.paymentEvent.create({
      data: { provider: providerName, providerEventId: event.providerEventId, eventType: event.eventType, paymentId: payment?.id, payload: event.raw as Prisma.InputJsonValue },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { duplicate: true };
    throw err;
  }
  if (!payment) {
    logger.warn({ providerName, providerReference: event.providerReference }, 'Webhook for unknown payment');
    return { duplicate: false };
  }
  await verifyAndApply(payment.id, SYSTEM_ACTOR);
  await prisma.paymentEvent.updateMany({ where: { provider: providerName, providerEventId: event.providerEventId }, data: { processedAt: new Date() } });
  return { duplicate: false };
}

/** Simulation only: the payer approves/declines on the simulated checkout. */
export async function simulatePayerAction(organizationId: string, paymentId: string, action: 'APPROVE' | 'DECLINE') {
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, organizationId } });
  if (!payment) throw AppError.notFound('Payment');
  const provider = PaymentProviderFactory.get(payment.provider);
  if (!(provider instanceof SimulationPaymentProvider)) throw AppError.forbidden('Simulation is not available for this payment provider', 'NOT_SIMULATION');
  if (payment.status !== 'PROCESSING' || !payment.providerReference) throw AppError.conflict('This payment is no longer awaiting approval', 'PAYMENT_NOT_PENDING');
  await provider.simulatePayerAction(payment.providerReference, action);
}

export async function cancelPayment(organizationId: string, paymentId: string, actor: Actor, meta?: RequestMeta) {
  const res = await prisma.payment.updateMany({
    where: { id: paymentId, organizationId, status: { in: ['PENDING', 'PROCESSING'] } },
    data: { status: 'CANCELLED', failureReason: 'Cancelled by customer' },
  });
  if (res.count === 0) throw AppError.conflict('This payment can no longer be cancelled', 'PAYMENT_NOT_CANCELLABLE');
  await audit({ actor, action: 'PAYMENT_CANCELLED', resource: 'payment', resourceId: paymentId, organizationId, meta });
}

/**
 * Staff refund: records the refund, reverses the purchased credits (they must still be
 * unused), and marks the invoice refunded. Money is returned through the provider.
 */
export async function refundPayment(paymentId: string, reason: string, actor: Actor, meta?: RequestMeta) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw AppError.notFound('Payment');
  if (payment.status !== 'SUCCESS') throw AppError.conflict('Only successful payments can be refunded', 'PAYMENT_NOT_REFUNDABLE');
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({ where: { id: paymentId, status: 'SUCCESS' }, data: { status: 'REFUNDED', refundedAt: new Date(), failureReason: reason } });
      if (claimed.count === 0) throw AppError.conflict('Payment was already refunded', 'ALREADY_REFUNDED');
      const purchase = await tx.walletTransaction.findUnique({ where: { reference: `payment:${payment.id}` }, select: { id: true } });
      const lot = purchase ? await tx.smsCreditLot.findUnique({ where: { sourceTransactionId: purchase.id }, select: { id: true } }) : null;
      await applyLedgerEntry(tx, {
        organizationId: payment.organizationId,
        type: 'ADJUSTMENT',
        amount: -payment.credits,
        reference: `payment-refund:${payment.id}`,
        preferLotId: lot?.id,
        description: `Payment ${payment.reference} refunded: ${reason}`,
        createdById: actorUserId(actor),
        metadata: { paymentId },
      });
      await tx.invoice.updateMany({ where: { paymentId }, data: { status: 'REFUNDED' } });
      await tx.refund.create({
        data: { organizationId: payment.organizationId, paymentId, amount: payment.amount, currency: payment.currency, creditsReversed: payment.credits, reason, createdById: actorUserId(actor) },
      });
      await audit({ actor, action: 'REFUND_CREATED', resource: 'payment', resourceId: paymentId, organizationId: payment.organizationId, metadata: { reason, amount: payment.amount.toFixed(2), credits: payment.credits }, meta }, tx);
    });
  } catch (err) {
    if (isDuplicateReference(err)) throw AppError.conflict('Payment was already refunded', 'ALREADY_REFUNDED');
    throw err;
  }
}

/** Sweep: reconcile payments whose webhook never arrived. */
export async function reconcilePendingPayments() {
  const pending = await prisma.payment.findMany({
    where: { status: 'PROCESSING', createdAt: { lt: new Date(Date.now() - 30_000), gt: new Date(Date.now() - 7 * 86_400_000) } },
    select: { id: true },
    take: 100,
  });
  for (const p of pending) {
    try {
      await verifyAndApply(p.id);
    } catch (err) {
      logger.warn({ err: (err as Error).message, paymentId: p.id }, 'Payment reconciliation failed');
    }
  }
  // Abandoned checkouts expire after 24h.
  await prisma.payment.updateMany({
    where: { status: { in: ['PENDING', 'PROCESSING'] }, createdAt: { lt: new Date(Date.now() - 86_400_000) } },
    data: { status: 'CANCELLED', failureReason: 'Payment expired' },
  });
}
