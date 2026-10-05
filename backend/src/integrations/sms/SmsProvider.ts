/**
 * Contract every upstream SMS provider adapter implements (MTN, Airtel, aggregators…).
 * Business logic resolves adapters through the SmsAdapterRegistry and never depends on a
 * concrete network. Replacing `mtn-simulation` with `mtn-production` is a registry change.
 */

export interface SendSmsRequest {
  /** Approved sender ID (alphanumeric or number). */
  from: string;
  /** E.164 destination. */
  to: string;
  message: string;
  encoding: 'GSM7' | 'UCS2';
  /** Number of segments billed for this message. */
  segments: number;
  /** Our unique id for this message (SmsRecipient.id). Providers use it for idempotency. */
  clientReference: string;
  /** URL the provider should POST delivery reports to. */
  callbackUrl?: string;
}

export type SendSmsResult =
  | { accepted: true; providerMessageId: string; providerStatus: string; route?: string; raw?: unknown }
  | { accepted: false; errorCode: string; errorMessage: string; retryable: boolean; raw?: unknown };

/** Normalised delivery state understood by the platform. */
export type DeliveryState = 'SENT' | 'DELIVERED' | 'FAILED' | 'EXPIRED';

export interface DeliveryStatus {
  providerMessageId: string;
  state: DeliveryState;
  /** Provider's raw status string, stored for diagnostics. */
  providerStatus: string;
  errorCode?: string;
  errorMessage?: string;
  occurredAt: Date;
  raw?: unknown;
}

export interface CallbackInput {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export interface ProviderBalance {
  /** SMS units available at the provider, or null when the provider does not expose it. */
  available: number | null;
  currency: string;
  checkedAt: Date;
}

export interface PurchaseCapacityRequest {
  quantity: number;
  /** Our purchase reference (ProviderPurchase.reference). */
  reference: string;
  /** Decimal string price per SMS we expect to pay. */
  unitCost: string;
}

export type PurchaseCapacityResult =
  | { accepted: true; providerReference: string; unitCost: string; raw?: unknown }
  | { accepted: false; errorCode: string; errorMessage: string; raw?: unknown };

export interface RegisterSenderIdRequest {
  senderId: string;
  organizationName: string;
  purpose: string;
}

export interface RegisterSenderIdResult {
  status: 'REGISTERED' | 'PENDING' | 'REJECTED';
  providerReference?: string;
  message?: string;
}

export interface SmsProviderAdapter {
  /** Registry key, e.g. "mtn-simulation". Stored on each message for callbacks/status checks. */
  readonly key: string;
  /** Human readable network/provider name. */
  readonly network: string;
  /** True for simulators; surfaced in the UI so simulated traffic is never mistaken for real. */
  readonly isSimulation: boolean;

  sendSms(data: SendSmsRequest): Promise<SendSmsResult>;
  getDeliveryStatus(providerMessageId: string): Promise<DeliveryStatus>;
  /** Verify and parse a delivery-report callback. Must throw if the signature is invalid. */
  parseDeliveryCallback(input: CallbackInput): Promise<DeliveryStatus[]>;
  /** Balance as reported by the provider (used for reconciliation against our capacity ledger). */
  getBalance(): Promise<ProviderBalance>;
  /** Buy SMS capacity/credits from the provider. */
  purchaseCapacity(req: PurchaseCapacityRequest): Promise<PurchaseCapacityResult>;
  /** Register an approved sender ID with the network (some networks require pre-registration). */
  registerSenderId(req: RegisterSenderIdRequest): Promise<RegisterSenderIdResult>;
}

export class InvalidCallbackSignatureError extends Error {
  constructor() {
    super('Invalid callback signature');
  }
}
