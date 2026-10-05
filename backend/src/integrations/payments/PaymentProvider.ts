/**
 * Contract for payment provider adapters (mobile money, cards, ...). The payments module
 * only talks to this interface through PaymentProviderFactory.
 */

export type ProviderPaymentState = 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

export interface InitializePaymentInput {
  /** Our unique payment reference. */
  reference: string;
  /** Decimal string, e.g. "15000.00". Never a float. */
  amount: string;
  currency: string;
  method: 'MOBILE_MONEY' | 'CARD' | 'BANK_TRANSFER';
  payerPhone?: string | null;
  payerEmail?: string | null;
  description: string;
  callbackUrl: string;
}

export interface NextAction {
  type: 'SIMULATED_CHECKOUT' | 'REDIRECT' | 'USSD_PUSH' | 'NONE';
  url?: string;
  message: string;
}

export interface InitializePaymentResult {
  providerReference: string;
  state: ProviderPaymentState;
  nextAction: NextAction;
  raw?: unknown;
}

export interface VerifyPaymentResult {
  providerReference: string;
  state: ProviderPaymentState;
  amount: string;
  currency: string;
  paidAt?: Date;
  failureReason?: string;
  /** Processing fee charged by the provider (decimal string), when the provider reports it. */
  fee?: string;
  raw?: unknown;
}

export interface PaymentWebhookEvent {
  providerEventId: string;
  providerReference: string;
  eventType: string;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  readonly isSimulation: boolean;
  initializePayment(input: InitializePaymentInput): Promise<InitializePaymentResult>;
  /** Authoritative status lookup. Wallets are only credited after this confirms SUCCESS. */
  verifyPayment(providerReference: string): Promise<VerifyPaymentResult>;
  /** Verify signature and parse a provider webhook. Must throw on invalid signature. */
  parseWebhook(input: { headers: Record<string, string | string[] | undefined>; rawBody: string }): Promise<PaymentWebhookEvent>;
}
