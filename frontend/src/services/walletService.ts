import { downloadFile, get, getPage, patch, post } from '@/api/client';
import type { DestinationCountry, Invoice, NetworkBalances, NetworkQuote, Payment, PriceQuote, PricingTier, Wallet, WalletTransaction } from '@/api/types';

export interface NextAction {
  type: 'SIMULATED_CHECKOUT' | 'REDIRECT' | 'USSD_PUSH' | 'NONE';
  url?: string;
  message: string;
}

export const walletService = {
  wallet: () => get<Wallet>('/wallet'),
  transactions: (params: { page: number; limit?: number; type?: string }) => getPage<WalletTransaction>('/wallet/transactions', params),
  updateThreshold: (lowBalanceThreshold: number) => patch('/wallet/settings', { lowBalanceThreshold }),
  tiers: () => get<PricingTier[]>('/pricing/tiers'),
  quote: (quantity: number) => get<PriceQuote>('/pricing/quote', { quantity }),
  /** Countries and networks with their own prices and availability (server-computed). */
  destinations: () => get<{ countries: DestinationCountry[]; currency: string }>('/pricing/destinations'),
  /** Authoritative price of a purchase for one or more networks. */
  networkQuote: (items: { networkId: string; quantity: number }[]) => post<NetworkQuote>('/pricing/network-quote', { items }),
  balances: () => get<NetworkBalances>('/wallet/balances'),
};

export const paymentService = {
  list: (params: { page: number; limit?: number; status?: string }) => getPage<Payment>('/payments', params),
  get: (id: string) => get<Payment>(`/payments/${id}`),
  /** General credits (`quantity`) or SMS per destination network (`items`); the server sets every price. */
  create: (body: { quantity?: number; items?: { networkId: string; quantity: number }[]; method: string; payerPhone?: string }) =>
    post<{ payment: Payment; nextAction: NextAction; simulation: boolean }>('/payments', body),
  /** The exact quote checkout will charge this organization (counts its monthly volume). */
  quote: (items: { networkId: string; quantity: number }[]) => post<NetworkQuote>('/payments/quote', { items }),
  verify: (id: string) => post<Payment>(`/payments/${id}/verify`),
  cancel: (id: string) => post(`/payments/${id}/cancel`),
  simulate: (id: string, action: 'APPROVE' | 'DECLINE') => post(`/payments/${id}/simulate`, { action }),
};

export const invoiceService = {
  list: (params: { page: number; limit?: number }) => getPage<Invoice>('/invoices', params),
  get: (id: string) => get<Invoice>(`/invoices/${id}`),
  downloadPdf: (id: string, number: string) => downloadFile(`/invoices/${id}/pdf`, `${number}.pdf`),
};
