import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { signPayload, verifySignature } from '../../utils/crypto';
import { InvalidCallbackSignatureError } from '../sms/SmsProvider';
import type {
  InitializePaymentInput,
  InitializePaymentResult,
  PaymentProvider,
  PaymentWebhookEvent,
  ProviderPaymentState,
  VerifyPaymentResult,
} from './PaymentProvider';

interface SimPayment {
  providerReference: string;
  reference: string;
  amount: string;
  currency: string;
  method: string;
  state: ProviderPaymentState;
  payerPhone?: string | null;
  callbackUrl: string;
  createdAt: number;
  paidAt?: number;
  failureReason?: string;
}

/**
 * Simulated payment gateway (think "mobile money push"). The customer approves or declines
 * the payment on a simulated checkout screen — the equivalent of confirming on their phone.
 * The simulator then sends a signed webhook, exactly like a real gateway would. The platform
 * never trusts the webhook body: it calls `verifyPayment` before crediting anything.
 */
export class SimulationPaymentProvider implements PaymentProvider {
  readonly name = 'simulation';
  readonly isSimulation = true;

  constructor(private readonly opts: { webhookSecret: string; webhooksEnabled: boolean }) {}

  private key(ref: string) {
    return `sim-pay:${ref}`;
  }

  private async load(providerReference: string): Promise<SimPayment | null> {
    const row = await prisma.simulatorRecord.findUnique({ where: { id: this.key(providerReference) } });
    return row ? (row.payload as unknown as SimPayment) : null;
  }

  private async save(p: SimPayment) {
    await prisma.simulatorRecord.upsert({
      where: { id: this.key(p.providerReference) },
      create: { id: this.key(p.providerReference), kind: 'payment', payload: p as unknown as Prisma.InputJsonValue },
      update: { payload: p as unknown as Prisma.InputJsonValue },
    });
  }

  async initializePayment(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    const providerReference = `SIMPAY-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    await this.save({
      providerReference,
      reference: input.reference,
      amount: input.amount,
      currency: input.currency,
      method: input.method,
      state: 'PENDING',
      payerPhone: input.payerPhone,
      callbackUrl: input.callbackUrl,
      createdAt: Date.now(),
    });
    return {
      providerReference,
      state: 'PENDING',
      nextAction: {
        type: 'SIMULATED_CHECKOUT',
        message:
          input.method === 'MOBILE_MONEY'
            ? `A payment request of ${input.amount} ${input.currency} was pushed to ${input.payerPhone ?? 'the payer'} (simulated). Approve or decline it below.`
            : `Complete the simulated ${input.method.toLowerCase().replace('_', ' ')} checkout below.`,
      },
    };
  }

  /** Simulation-only: the payer approves or declines. Triggers an async webhook. */
  async simulatePayerAction(providerReference: string, action: 'APPROVE' | 'DECLINE'): Promise<void> {
    const p = await this.load(providerReference);
    if (!p) throw new Error('Unknown simulated payment');
    if (p.state !== 'PENDING') return;
    if (action === 'APPROVE') {
      p.state = 'SUCCESS';
      p.paidAt = Date.now();
    } else {
      p.state = 'FAILED';
      p.failureReason = 'Payer declined the payment request';
    }
    await this.save(p);
    if (this.opts.webhooksEnabled) {
      const t = setTimeout(() => void this.sendWebhook(p), 1500);
      t.unref?.();
    }
  }

  private async sendWebhook(p: SimPayment) {
    const body = JSON.stringify({
      event_id: `evt_${crypto.randomBytes(8).toString('hex')}`,
      type: p.state === 'SUCCESS' ? 'payment.succeeded' : 'payment.failed',
      data: { transaction_ref: p.providerReference, merchant_ref: p.reference, status: p.state },
    });
    try {
      await fetch(p.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-simpay-signature': signPayload(this.opts.webhookSecret, body) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, providerReference: p.providerReference }, 'Simulated payment webhook failed');
    }
  }

  async verifyPayment(providerReference: string): Promise<VerifyPaymentResult> {
    const p = await this.load(providerReference);
    if (!p) return { providerReference, state: 'FAILED', amount: '0', currency: 'RWF', failureReason: 'Unknown transaction' };
    // Simulated gateway pricing: mobile money 1.5%, card 2.9%, bank transfer flat 0.
    const rate = p.method === 'CARD' ? 0.029 : p.method === 'MOBILE_MONEY' ? 0.015 : 0;
    const fee = p.state === 'SUCCESS' ? (Math.round(Number(p.amount) * rate * 100) / 100).toFixed(2) : '0.00';
    return {
      providerReference,
      state: p.state,
      amount: p.amount,
      currency: p.currency,
      paidAt: p.paidAt ? new Date(p.paidAt) : undefined,
      failureReason: p.failureReason,
      fee,
    };
  }

  async parseWebhook(input: { headers: Record<string, string | string[] | undefined>; rawBody: string }): Promise<PaymentWebhookEvent> {
    const sig = input.headers['x-simpay-signature'];
    if (!verifySignature(this.opts.webhookSecret, input.rawBody, Array.isArray(sig) ? sig[0] : sig)) {
      throw new InvalidCallbackSignatureError();
    }
    const body = JSON.parse(input.rawBody) as { event_id: string; type: string; data: { transaction_ref: string } };
    return { providerEventId: body.event_id, providerReference: body.data.transaction_ref, eventType: body.type, raw: body };
  }
}
