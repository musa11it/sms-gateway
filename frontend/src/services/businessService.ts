import { downloadFile, get, getPage, http, patch, post } from '@/api/client';
import type { Paginated } from '@/api/types';

/** Supply side, finance and platform-owner business data (Super Admin console). */

export interface Provider {
  id: string;
  code: string;
  name: string;
  type: 'MNO' | 'AGGREGATOR';
  mode: 'SIMULATION' | 'PRODUCTION';
  effectiveMode: 'SIMULATION' | 'PRODUCTION';
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  currency: string;
  costPerSms: string;
  averageCost: string;
  routePrefixes: string[];
  priority: number;
  capacityBalance: number;
  totalPurchased: number;
  totalUsed: number;
  totalSpent: string;
  allowOverdraft: boolean;
  overdraftLimit: number;
  lowCapacityThreshold: number;
  capacityState: 'OK' | 'LOW' | 'EMPTY';
  adapterKey: string;
  adapterInstalled: boolean;
  apiConfigured: boolean;
  notes: string | null;
  lastTransactionAt: string | null;
  lastPurchaseAt?: string | null;
  createdAt: string;
}

export interface ProviderDetail extends Provider {
  network: string | null;
  reportedBalance: { available: number | null; currency: string; checkedAt: string } | null;
  reportedBalanceError: string | null;
  reconciliationDifference: number | null;
  traffic24h: { status: string; count: number }[];
}

export interface ProviderPurchase {
  id: string;
  reference: string;
  providerId: string;
  provider: { code: string; name: string };
  quantity: number;
  unitCost: string;
  totalCost: string;
  currency: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  providerReference: string | null;
  failureReason: string | null;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CapacityEntry {
  id: string;
  type: 'PURCHASE' | 'USAGE' | 'RELEASE' | 'ADJUSTMENT';
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reference: string;
  description: string;
  unitCost: string | null;
  createdAt: string;
  provider: { code: string; name: string };
}

export interface FinanceOverview {
  range: { from: string; to: string; unit: string; range: string };
  currency: string;
  canViewProfit: boolean;
  money: { revenue: string; providerSpend: string; grossMargin: string | null; refunds: string; paymentFees: string; otherExpenses: string; netProfit: string | null; netMarginPercent: number | null };
  unitEconomics: { salesRevenue: string; estimatedProviderCostOfSales: string; paymentFeesOnSales: string; salesContribution: string | null; costOfSmsDelivered: string };
  sms: {
    purchasedFromProviders: number;
    soldToCustomers: number;
    refundedCredits: number;
    usedByCustomers: number;
    segmentsThroughProviders: number;
    providerCapacityRemaining: number;
    customerCreditsOutstanding: number;
  };
  counts: { payments: number; providerPurchases: number; refunds: number; expenses: number; sales: number };
  formula: Record<string, string>;
  series: { label: string; revenue: string; providerSpend: string; costs: string; profit: string | null; smsSold: number; smsPurchased: number; smsUsed: number }[];
  providers: { id: string; code: string; name: string; status: string; purchased: number; spend: string; used: number; remaining: number; lowCapacityThreshold: number }[];
  recentPayments: { id: string; reference: string; organization: { id: string; name: string }; amount: string; fee: string; currency: string; status: string; createdAt: string }[];
  recentProviderPurchases: { id: string; reference: string; provider: { code: string; name: string }; quantity: number; totalCost: string; currency: string; status: string; createdAt: string }[];
  recentSales: { id: string; organization: { id: string; name: string }; packageName: string; credits: number; revenue: string; contribution: string; createdAt: string }[];
  topCustomersByUsage: { id: string; name: string; messages: number; credits: number }[];
  topCustomersByRevenue: { id: string; name: string; revenue: string; credits: number }[];
  failedTransactions: { id: string; kind: 'CUSTOMER_PAYMENT' | 'PROVIDER_PURCHASE'; reference: string; party: string; amount: string; reason: string | null; createdAt: string }[];
}

export interface CustomerSale {
  id: string;
  organization: { id: string; name: string };
  payment: { reference: string; method: string; status: string };
  packageName: string;
  credits: number;
  revenue: string;
  estimatedProviderCost: string;
  paymentFee: string;
  contribution: string;
  currency: string;
  createdAt: string;
}

export interface Expense {
  id: string;
  category: string;
  description: string;
  vendor: string | null;
  reference: string | null;
  amount: string;
  currency: string;
  incurredAt: string;
  createdAt: string;
}

export interface Inquiry {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  message: string;
  status: 'NEW' | 'HANDLED';
  createdAt: string;
  handledAt: string | null;
}

type P = { page: number; limit?: number } & Record<string, unknown>;

export const businessService = {
  providers: () => get<Provider[]>('/admin/providers'),
  provider: (id: string) => get<ProviderDetail>(`/admin/providers/${id}`),
  updateProvider: (id: string, body: Partial<Omit<Provider, 'id'>>) => patch<Provider>(`/admin/providers/${id}`, body),
  purchaseCapacity: (id: string, body: { quantity: number; unitCost?: string; notes?: string }) => post<ProviderPurchase>(`/admin/providers/${id}/purchase`, body),
  adjustCapacity: (id: string, body: { amount: number; reason: string; reference: string }) => post(`/admin/providers/${id}/adjust`, body),
  purchases: (params: P) => getPage<ProviderPurchase>('/admin/providers/purchases', params),
  ledger: (params: P) => getPage<CapacityEntry>('/admin/providers/ledger', params),

  finance: (params: { range: string; from?: string; to?: string }) => get<FinanceOverview>('/admin/finance/overview', params),
  sales: async (params: P) => {
    const r = await http.get('/admin/finance/sales', { params });
    return r.data as Paginated<CustomerSale> & { totals: { credits: number; revenue: string; estimatedProviderCost: string; paymentFees: string; contribution: string } };
  },
  refunds: (params: P) => getPage<{ id: string; amount: string; currency: string; creditsReversed: number; reason: string; createdAt: string; organization: { id: string; name: string }; payment: { reference: string } }>('/admin/finance/refunds', params),
  expenses: async (params: P) => {
    const r = await http.get('/admin/finance/expenses', { params });
    return r.data as Paginated<Expense> & { total: string };
  },
  createExpense: (body: Record<string, unknown>) => post<Expense>('/admin/finance/expenses', body),
  updateExpense: (id: string, body: Record<string, unknown>) => patch<Expense>(`/admin/finance/expenses/${id}`, body),
  deleteExpense: (id: string) => http.delete(`/admin/finance/expenses/${id}`),

  inquiries: (params: P) => getPage<Inquiry>('/admin/inquiries', params),
  handleInquiry: (id: string) => post(`/admin/inquiries/${id}/handle`),

  apiLogs: (params: P) =>
    getPage<{ id: string; method: string; path: string; statusCode: number; durationMs: number; errorCode: string | null; requestId: string | null; ipAddress: string | null; createdAt: string; apiKey: { name: string; prefix: string } | null; organization: { id: string; name: string } }>(
      '/admin/developer/api-logs',
      params,
    ),
  apiUsage: () => get<{ last24h: { requests: number; errors: number }; topOrganizations: { id: string; name: string; requests: number }[] }>('/admin/developer/usage'),
  webhookDeliveries: (params: P) =>
    getPage<{ id: string; event: string; status: string; attempts: number; responseStatus: number | null; lastError: string | null; createdAt: string; deliveredAt: string | null; nextAttemptAt: string | null; webhook: { url: string; organization: { id: string; name: string } } }>(
      '/admin/developer/webhooks',
      params,
    ),
  invoicePdf: (id: string, number: string) => downloadFile(`/admin/billing/invoices/${id}/pdf`, `${number}.pdf`),
};

export const siteService = {
  packages: () =>
    get<{ id: string; name: string; description: string | null; credits: number; price: string; currency: string; pricePerSms: string; validityDays: number | null; isPopular: boolean }[]>('/site/packages'),
  contact: (body: { name: string; email: string; phone?: string; company?: string; message: string; website?: string }) => post<{ id: string }>('/site/contact', body),
};
