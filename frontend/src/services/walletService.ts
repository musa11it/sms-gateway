import { downloadFile, get, getPage, patch, post } from '@/api/client';
import type { Invoice, Payment, PriceQuote, PricingTier, SmsPackage, Wallet, WalletTransaction } from '@/api/types';

export interface NextAction {
  type: 'SIMULATED_CHECKOUT' | 'REDIRECT' | 'USSD_PUSH' | 'NONE';
  url?: string;
  message: string;
}

export const walletService = {
  wallet: () => get<Wallet>('/wallet'),
  transactions: (params: { page: number; limit?: number; type?: string }) => getPage<WalletTransaction>('/wallet/transactions', params),
  updateThreshold: (lowBalanceThreshold: number) => patch('/wallet/settings', { lowBalanceThreshold }),
  packages: () => get<SmsPackage[]>('/packages'),
  tiers: () => get<PricingTier[]>('/pricing/tiers'),
  quote: (quantity: number) => get<PriceQuote>('/pricing/quote', { quantity }),
};

export const paymentService = {
  list: (params: { page: number; limit?: number; status?: string }) => getPage<Payment>('/payments', params),
  get: (id: string) => get<Payment>(`/payments/${id}`),
  /** Either a package or any quantity; the server sets the price. */
  create: (body: { packageId?: string; quantity?: number; method: string; payerPhone?: string }) =>
    post<{ payment: Payment; nextAction: NextAction; simulation: boolean }>('/payments', body),
  verify: (id: string) => post<Payment>(`/payments/${id}/verify`),
  cancel: (id: string) => post(`/payments/${id}/cancel`),
  simulate: (id: string, action: 'APPROVE' | 'DECLINE') => post(`/payments/${id}/simulate`, { action }),
};

export const invoiceService = {
  list: (params: { page: number; limit?: number }) => getPage<Invoice>('/invoices', params),
  get: (id: string) => get<Invoice>(`/invoices/${id}`),
  downloadPdf: (id: string, number: string) => downloadFile(`/invoices/${id}/pdf`, `${number}.pdf`),
};
