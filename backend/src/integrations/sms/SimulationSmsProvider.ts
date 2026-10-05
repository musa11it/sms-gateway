import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { signPayload, verifySignature } from '../../utils/crypto';
import {
  InvalidCallbackSignatureError,
  type CallbackInput,
  type DeliveryState,
  type DeliveryStatus,
  type ProviderBalance,
  type PurchaseCapacityRequest,
  type PurchaseCapacityResult,
  type RegisterSenderIdRequest,
  type RegisterSenderIdResult,
  type SendSmsRequest,
  type SendSmsResult,
  type SmsProviderAdapter,
} from './SmsProvider';

export interface SimulationOptions {
  /** Registry key, e.g. "mtn-simulation". */
  key: string;
  /** Network label, e.g. "MTN Rwanda (simulated)". */
  network: string;
  /** Prefix of generated provider message ids, e.g. "MTN". */
  idPrefix: string;
  /** Route label returned on submission (e.g. "MTN-RW-DIRECT"). */
  route: string;
  failureRate: number;
  minDelayMs: number;
  maxDelayMs: number;
  callbackSecret: string;
  /** When false, no HTTP callbacks are fired (status is still available via polling). */
  callbacksEnabled: boolean;
  currency: string;
  /** Networks that need sender IDs pre-registered return PENDING first. */
  senderRegistrationDelayMs?: number;
}

interface SimRecord {
  providerMessageId: string;
  clientReference: string;
  from: string;
  to: string;
  segments: number;
  submittedAt: number;
  finalAt: number;
  finalState: DeliveryState;
  errorCode?: string;
  errorMessage?: string;
  callbackUrl?: string;
}

/**
 * Stand-in for an upstream network/aggregator. It behaves like a real one:
 *  - keeps its OWN balance of purchased SMS units (independent of our ledger, so the two can be reconciled);
 *  - sells capacity (purchaseCapacity), registers sender IDs;
 *  - accepts or rejects submissions, returns its own message id and a route;
 *  - reports DELIVERED / FAILED / EXPIRED seconds later via a signed HTTP callback and via polling;
 *  - is idempotent on clientReference.
 *
 * Deterministic outcomes for predictable tests/demos:
 *  - number ending in 0000 → rejected at submission (INVALID_DESTINATION)
 *  - number ending in 9999 → accepted, then FAILED (ABSENT_SUBSCRIBER)
 *  - number ending in 8888 → accepted, no delivery report for 2 minutes, then EXPIRED
 *  - otherwise             → DELIVERED, except a deterministic `failureRate` share → FAILED (UNDELIVERED)
 *
 * State lives in `simulator_records`, standing in for the provider's own systems.
 */
export class SimulationSmsProvider implements SmsProviderAdapter {
  readonly isSimulation = true;
  readonly key: string;
  readonly network: string;

  constructor(private readonly opts: SimulationOptions) {
    this.key = opts.key;
    this.network = opts.network;
  }

  private hashUnit(input: string): number {
    const h = crypto.createHash('sha256').update(`${this.key}|${input}`).digest();
    return h.readUInt32BE(0) / 0xffffffff;
  }

  private balanceKey() {
    return `sim-balance:${this.key}`;
  }

  /** Atomically adjust the simulated provider-side balance. Returns false if it would go negative. */
  private async adjustProviderBalance(delta: number): Promise<boolean> {
    const id = this.balanceKey();
    await prisma.simulatorRecord.createMany({ data: [{ id, kind: 'sms-balance', payload: { balance: 0 } }], skipDuplicates: true });
    const rows = await prisma.$executeRaw`
      UPDATE simulator_records
      SET payload = JSON_OBJECT('balance', CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.balance')) AS SIGNED) + ${delta}), updatedAt = ${new Date()}
      WHERE id = ${id} AND CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.balance')) AS SIGNED) + ${delta} >= 0`;
    return rows === 1;
  }

  async getBalance(): Promise<ProviderBalance> {
    const row = await prisma.simulatorRecord.findUnique({ where: { id: this.balanceKey() } });
    return { available: row ? Number((row.payload as { balance: number }).balance) : 0, currency: this.opts.currency, checkedAt: new Date() };
  }

  async purchaseCapacity(req: PurchaseCapacityRequest): Promise<PurchaseCapacityResult> {
    await new Promise((r) => setTimeout(r, 150));
    if (req.quantity > 5_000_000) {
      return { accepted: false, errorCode: 'ORDER_LIMIT_EXCEEDED', errorMessage: 'A single order may not exceed 5,000,000 SMS' };
    }
    const orderKey = `sim-order:${this.key}:${req.reference}`;
    const prior = await prisma.simulatorRecord.findUnique({ where: { id: orderKey } });
    if (prior) return { accepted: true, ...(prior.payload as { providerReference: string; unitCost: string }), raw: { duplicate: true } };
    const providerReference = `${this.opts.idPrefix}-ORD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    await prisma.simulatorRecord.create({ data: { id: orderKey, kind: 'sms-order', payload: { providerReference, unitCost: req.unitCost, quantity: req.quantity } } });
    await this.adjustProviderBalance(req.quantity);
    return { accepted: true, providerReference, unitCost: req.unitCost };
  }

  async registerSenderId(req: RegisterSenderIdRequest): Promise<RegisterSenderIdResult> {
    if (/test|bank|gov/i.test(req.senderId) && this.opts.senderRegistrationDelayMs) {
      return { status: 'PENDING', providerReference: `${this.opts.idPrefix}-SID-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, message: 'Held for manual network review' };
    }
    return { status: 'REGISTERED', providerReference: `${this.opts.idPrefix}-SID-${crypto.randomBytes(3).toString('hex').toUpperCase()}` };
  }

  async sendSms(req: SendSmsRequest): Promise<SendSmsResult> {
    // Simulate network latency to the provider.
    await new Promise((r) => setTimeout(r, 20 + Math.floor(this.hashUnit(`lat:${req.clientReference}`) * 120)));

    const refKey = `sim-sms-ref:${this.key}:${req.clientReference}`;
    const prior = await prisma.simulatorRecord.findUnique({ where: { id: refKey } });
    if (prior) {
      const pid = (prior.payload as { providerMessageId: string }).providerMessageId;
      return { accepted: true, providerMessageId: pid, providerStatus: 'ACCEPTED', route: this.opts.route, raw: { duplicate: true } };
    }

    if (!req.message.trim()) return { accepted: false, errorCode: 'EMPTY_MESSAGE', errorMessage: 'Message body is empty', retryable: false };
    if (req.to.endsWith('0000')) {
      return { accepted: false, errorCode: 'INVALID_DESTINATION', errorMessage: 'Destination number is not reachable on this network', retryable: false };
    }
    if (!(await this.adjustProviderBalance(-req.segments))) {
      return { accepted: false, errorCode: 'INSUFFICIENT_PROVIDER_BALANCE', errorMessage: 'Provider account balance exhausted', retryable: false };
    }

    const providerMessageId = `${this.opts.idPrefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const u = this.hashUnit(`${req.to}|${req.clientReference}`);
    const delay = this.opts.minDelayMs + Math.floor(this.hashUnit(`d:${req.clientReference}`) * Math.max(0, this.opts.maxDelayMs - this.opts.minDelayMs));
    const now = Date.now();

    let finalState: DeliveryState = 'DELIVERED';
    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    let finalAt = now + delay;
    if (req.to.endsWith('9999')) {
      finalState = 'FAILED';
      errorCode = 'ABSENT_SUBSCRIBER';
      errorMessage = 'Handset switched off or out of coverage';
    } else if (req.to.endsWith('8888')) {
      finalState = 'EXPIRED';
      errorCode = 'VALIDITY_EXPIRED';
      errorMessage = 'Message validity period expired before delivery';
      finalAt = now + 120_000;
    } else if (u < this.opts.failureRate) {
      finalState = 'FAILED';
      errorCode = 'UNDELIVERED';
      errorMessage = 'Network reported the message as undeliverable';
    }

    const record: SimRecord = {
      providerMessageId,
      clientReference: req.clientReference,
      from: req.from,
      to: req.to,
      segments: req.segments,
      submittedAt: now,
      finalAt,
      finalState,
      errorCode,
      errorMessage,
      callbackUrl: req.callbackUrl,
    };
    await prisma.simulatorRecord.createMany({
      data: [
        { id: `sim-sms:${providerMessageId}`, kind: 'sms', payload: record as unknown as Prisma.InputJsonValue },
        { id: refKey, kind: 'sms-ref', payload: { providerMessageId } },
      ],
      skipDuplicates: true,
    });

    if (this.opts.callbacksEnabled && req.callbackUrl && finalState !== 'EXPIRED') {
      const t = setTimeout(() => void this.fireCallback(record), finalAt - now);
      t.unref?.();
    }
    return { accepted: true, providerMessageId, providerStatus: 'ACCEPTED', route: this.opts.route };
  }

  private toStatus(rec: SimRecord, at = Date.now()): DeliveryStatus {
    if (at < rec.finalAt) {
      return { providerMessageId: rec.providerMessageId, state: 'SENT', providerStatus: 'ENROUTE', occurredAt: new Date(rec.submittedAt) };
    }
    return {
      providerMessageId: rec.providerMessageId,
      state: rec.finalState,
      providerStatus: rec.finalState === 'DELIVERED' ? 'DELIVRD' : rec.finalState === 'EXPIRED' ? 'EXPIRED' : 'UNDELIV',
      errorCode: rec.errorCode,
      errorMessage: rec.errorMessage,
      occurredAt: new Date(rec.finalAt),
    };
  }

  async getDeliveryStatus(providerMessageId: string): Promise<DeliveryStatus> {
    const row = await prisma.simulatorRecord.findUnique({ where: { id: `sim-sms:${providerMessageId}` } });
    if (!row) {
      return { providerMessageId, state: 'FAILED', providerStatus: 'UNKNOWN', errorCode: 'UNKNOWN_MESSAGE', occurredAt: new Date() };
    }
    return this.toStatus(row.payload as unknown as SimRecord);
  }

  private async fireCallback(rec: SimRecord) {
    const status = this.toStatus(rec, rec.finalAt);
    const body = JSON.stringify({
      message_id: rec.providerMessageId,
      reference: rec.clientReference,
      status: status.providerStatus,
      error_code: status.errorCode ?? null,
      error_description: status.errorMessage ?? null,
      network: this.network,
      done_at: new Date(rec.finalAt).toISOString(),
    });
    try {
      const res = await fetch(rec.callbackUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-simulator-signature': signPayload(this.opts.callbackSecret, body) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) logger.warn({ status: res.status, providerMessageId: rec.providerMessageId }, 'Simulator DLR callback rejected');
    } catch (err) {
      // A real provider would retry; our status poller is the safety net.
      logger.warn({ err: (err as Error).message, providerMessageId: rec.providerMessageId }, 'Simulator DLR callback failed');
    }
  }

  async parseDeliveryCallback(input: CallbackInput): Promise<DeliveryStatus[]> {
    const sig = input.headers['x-simulator-signature'];
    if (!verifySignature(this.opts.callbackSecret, input.rawBody, Array.isArray(sig) ? sig[0] : sig)) {
      throw new InvalidCallbackSignatureError();
    }
    const body = JSON.parse(input.rawBody) as { message_id: string; status: string; error_code: string | null; error_description: string | null; done_at: string };
    const map: Record<string, DeliveryState> = { DELIVRD: 'DELIVERED', UNDELIV: 'FAILED', EXPIRED: 'EXPIRED', ENROUTE: 'SENT' };
    const state = map[body.status];
    if (!state) return [];
    return [
      {
        providerMessageId: body.message_id,
        state,
        providerStatus: body.status,
        errorCode: body.error_code ?? undefined,
        errorMessage: body.error_description ?? undefined,
        occurredAt: new Date(body.done_at),
        raw: body,
      },
    ];
  }
}
