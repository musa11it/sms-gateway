import { downloadFile, get, getPage, http, patch, post } from '@/api/client';
import type { CustomerFinanceRow, Paginated } from '@/api/types';

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
  health: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  healthNote: string | null;
  minimumCapacity: number;
  supportsSenderId: boolean;
  servesAllDestinations: boolean;
  usagePercent: number;
  remainingValue: string;
  averageRemainingCost: string | null;
  openLots: number;
  networks: { id: string; code: string; name: string }[];
  routable: boolean;
}

export interface ProviderEconomics {
  messages: number;
  segments: number;
  creditsUsed: number;
  revenuePerCredit: string | null;
  revenue: string | null;
  providerCost: string;
  grossMargin: string | null;
  marginPercent: number | null;
}

export interface ProviderOverview {
  range: { from: string; to: string };
  counts: { providers: number; active: number; routable: number };
  capacity: { purchased: number; used: number; remaining: number; remainingValue: string; averageRemainingCost: string | null };
  economics: ProviderEconomics;
  formula: string;
  providers: Provider[];
}

export interface ProviderLot {
  id: string;
  source: 'OPENING' | 'PURCHASE' | 'ADJUSTMENT' | 'RETURN';
  reference: string;
  providerReference: string | null;
  status: string;
  quantity: number;
  used: number;
  remaining: number;
  unitCost: string;
  totalCost: string;
  remainingValue: string;
  createdAt: string;
}

export interface SmsNetwork {
  id: string;
  code: string;
  name: string;
  countryCode: string;
  countryName: string;
  prefixes: string[];
  isActive: boolean;
  providerCount?: number;
}

export type RoutingStrategy = 'PRIORITY' | 'LOWEST_COST' | 'PRIORITY_THEN_COST';

export interface RoutingRule {
  id: string;
  name: string;
  priority: number;
  countryCode: string | null;
  networkId: string | null;
  destination: string;
  strategy: RoutingStrategy;
  primaryProviderId: string | null;
  primaryProvider: string | null;
  backupProviderIds: string[];
  backupProviders: string[];
  allowedProviderIds: string[];
  allowedProviders: string[];
  minProviderCapacity: number;
  maxCostPerSegment: string | null;
  isActive: boolean;
  description: string | null;
  updatedAt: string;
}

export interface RoutingSimulation {
  message: { encoding: 'GSM7' | 'UCS2'; characterCount: number; segmentsPerRecipient: number; totalSegments: number; creditsPerRecipient: number; totalCredits: number; tooLong: boolean };
  sender: { name: string; known: boolean; approved: boolean } | null;
  destination: { countryCode: string | null; network: { id: string; name: string; code: string } | null };
  rule: { id: string; name: string; priority: number; strategy: RoutingStrategy } | null;
  strategy: RoutingStrategy;
  candidates: { providerId: string; name: string; code: string; role: 'primary' | 'backup' | 'candidate'; eligible: boolean; reasons: string[]; costPerSegment: string; capacity: number; reserve: number; available: number; priority: number; health: Provider['health'] }[];
  selected: { providerId: string; name: string } | null;
  backup: { providerId: string; name: string } | null;
  reason: string;
  allocations: { providerId: string; name: string; recipients: number; segments: number; estimatedCost: string }[];
  unroutedRecipients: number;
  estimate: { providerCost: string; revenue: string | null; revenuePerCredit: string | null; grossMargin: string | null };
}

export interface ProviderDetail extends Provider {
  lots: ProviderLot[];
  costHistory: { at: string; by: string | null; from: string | null; to: string | null; reason: string | null }[];
  rules: { id: string; name: string; priority: number; isActive: boolean; strategy: RoutingStrategy; destination: string; role: string }[];
  usage: { date: string; segments: number }[];
  economics: ProviderEconomics;
  recentActivity: CapacityEntry[];
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
  provider: (id: string, params?: Record<string, unknown>) => get<ProviderDetail>(`/admin/providers/${id}`, params),
  providerOverview: (params: Record<string, unknown>) => get<ProviderOverview>('/admin/providers/overview', params),
  updateProvider: (id: string, body: Record<string, unknown>) => patch<Provider>(`/admin/providers/${id}`, body),
  createProvider: (body: Record<string, unknown>) => post<Provider>('/admin/providers', body),
  purchaseCapacity: (id: string, body: { quantity: number; unitCost?: string; notes?: string }) => post<ProviderPurchase>(`/admin/providers/${id}/purchase`, body),
  adjustCapacity: (id: string, body: { amount: number; reason: string; reference: string; unitCost?: string }) => post(`/admin/providers/${id}/adjust`, body),
  networks: () => get<SmsNetwork[]>('/admin/routing/networks'),
  createNetwork: (body: Record<string, unknown>) => post<SmsNetwork>('/admin/routing/networks', body),
  updateNetwork: (id: string, body: Record<string, unknown>) => patch<SmsNetwork>(`/admin/routing/networks/${id}`, body),
  routingRules: () => get<RoutingRule[]>('/admin/routing/rules'),
  createRoutingRule: (body: Record<string, unknown>) => post<RoutingRule>('/admin/routing/rules', body),
  updateRoutingRule: (id: string, body: Record<string, unknown>) => patch<RoutingRule>(`/admin/routing/rules/${id}`, body),
  reorderRoutingRules: (ids: string[]) => post<RoutingRule[]>('/admin/routing/rules/reorder', { ids }),
  simulateRouting: (body: Record<string, unknown>) => post<RoutingSimulation>('/admin/routing/simulate', body),
  purchases: (params: P) => getPage<ProviderPurchase>('/admin/providers/purchases', params),
  ledger: (params: P) => getPage<CapacityEntry>('/admin/providers/ledger', params),

  finance: (params: { range: string; from?: string; to?: string }) => get<FinanceOverview>('/admin/finance/overview', params),
  customerReport: (params: Record<string, unknown>) =>
    get<{ range: { from: string; to: string; range: string }; canViewProfit: boolean; customers: CustomerFinanceRow[] }>('/admin/finance/customers', params),
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
