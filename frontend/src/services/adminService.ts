import { del, get, getPage, http, patch, post, put } from '@/api/client';
import type { ApiKey, AuditLog, Campaign, CatalogNetwork, Invoice, Organization, Payment, PermissionDef, PriceQuote, PricingTier, Role, SegmentationConfig, SenderId, SenderNetworkRow, SeriesPoint, SmsRecipient, SmsTotals, UserStatus, VerificationStatus, WalletTransaction } from '@/api/types';
import type { VerificationItem, VerificationOverview, VerificationRequirement } from '@/services/organizationService';

export interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  status: UserStatus;
  statusReason: string | null;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  roles: { id: string; code: string; name: string }[];
  memberships: { isOwner: boolean; organization: { id: string; name: string; status: string }; role: { name: string } }[];
}

export interface OrganizationProfile {
  businessType?: string;
  country?: string;
  city?: string;
  address?: string;
  registrationNumber?: string;
  taxId?: string;
  website?: string;
  contactPersonName?: string;
  contactPersonPhone?: string;
  contactPersonEmail?: string;
  smsPurpose?: string;
  expectedMonthlyVolume?: number;
}

export interface CreateOrganizationBody extends OrganizationProfile {
  name: string;
  owner: { fullName: string; email: string; phone?: string };
  activate: boolean;
  apiAccess?: { enabled: boolean; allowedScopes: string[] | null };
}

export interface AdminOrgRow extends Organization {
  owner: { fullName: string; email: string } | null;
  balance: number;
  memberCount: number;
  senderCount: number;
}

export interface ApiScope {
  key: string;
  level: 'PLATFORM' | 'ORGANIZATION';
  group: string;
  label: string;
  description: string;
  highRisk?: boolean;
}

export interface IntegrationClient {
  id: string;
  name: string;
  maskedKey: string;
  scopes: string[];
  allowedIps: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  usageCount: number;
  rotatedAt?: string | null;
  previousKeyValidUntil?: string | null;
  status: 'ACTIVE' | 'DISABLED' | 'EXPIRED' | 'REVOKED';
  createdAt: string;
}

export interface IntegrationActivity {
  id: string;
  action: string;
  resourceId: string | null;
  organizationId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface AdminOrgDetail extends Organization {
  apiAccessEnabled: boolean;
  apiAllowedScopes: string[] | null;
  wallet: { id: string; balance: number; lowBalanceThreshold: number } | null;
  members: { id: string; isOwner: boolean; status: 'ACTIVE' | 'DISABLED'; user: { id: string; fullName: string; email: string; status: string; lastLoginAt: string | null }; role: { name: string } }[];
  senders: SenderId[];
  verifications: { id: string; status: VerificationStatus; documents: { id: string; documentType: string; originalName: string; status: string; createdAt: string }[] }[];
  _count: { contacts: number; campaigns: number; apiKeys: number; webhooks: number };
  stats: { smsTotal: number; payments: number; revenue: string };
}

export interface VerificationRow {
  id: string;
  status: VerificationStatus;
  submittedAt: string | null;
  createdAt: string;
  organization: { id: string; name: string; businessType: string | null; country: string | null; status: string };
  _count: { documents: number };
}

export interface VerificationDetail {
  id: string;
  status: VerificationStatus;
  reviewNote: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  organization: Organization & { members: { user: { id: string; fullName: string; email: string; phone: string | null; status: string; emailVerifiedAt: string | null } }[] };
  documents: VerificationItem[];
  requirements: VerificationRequirement[];
  history: { id: string; action: string; createdAt: string; metadata: Record<string, unknown> | null; actor: { fullName: string } | null }[];
  reviews: { id: string; action: string; fromStatus: string | null; toStatus: string | null; note: string | null; createdAt: string }[];
}

export interface AdminDashboard {
  currency: string;
  organizations: { total: number; active: number; suspended: number; pendingReview: number };
  pendingVerification: number;
  pendingSenders: number;
  pendingPayments: number;
  smsToday: SmsTotals;
  revenue30d: { amount: string; creditsSold: number; payments: number };
  series: SeriesPoint[];
  revenueSeries: { label: string; revenue: string; credits: number; payments: number }[];
  growth: { label: string; signups: number; approved: number }[];
  deliveryStatus30d: SmsTotals;
}

export interface AdminOverview {
  range: { from: string; to: string; unit: string };
  currency: string;
  customers: { total: number; active: number };
  sms: SmsTotals & { creditsConsumed: number };
  revenue: { amount: string; creditsSold: number; payments: number };
  series: SeriesPoint[];
  revenueSeries: { label: string; revenue: string; credits: number; payments: number }[];
  growth: { label: string; signups: number; approved: number }[];
  topOrganizations: { id: string; name: string; status: string; messages: number; credits: number }[];
  providers: { provider: string; total: number; delivered: number; failed: number; deliveryRate: number | null; avgDeliveryLatencyMs: number | null }[];
}

export interface Setting {
  key: string;
  value: unknown;
  isDefault: boolean;
  description: string;
}

export interface ProviderStatus {
  sms: { mode: string; isSimulation: boolean; adapters: string[] };
  payments: { mode: string; active: string; isSimulation: boolean; available: string[] };
  queue: string;
  environment: string;
  simulation: { failureRate: number; deliveryDelayMs: [number, number]; rules: string[] } | null;
}

type P = { page: number; limit?: number } & Record<string, unknown>;

export const adminService = {
  dashboard: () => get<AdminDashboard>('/admin/reports/dashboard'),
  overview: (params: { range: string; from?: string; to?: string }) => get<AdminOverview>('/admin/reports/overview', params),

  users: (params: P) => getPage<AdminUser>('/admin/users', params),
  user: (id: string) => get<AdminUser>(`/admin/users/${id}`),
  createStaff: (body: { email: string; fullName: string; password: string; roleIds: string[] }) => post('/admin/users', body),
  setUserRoles: (id: string, roleIds: string[]) => put(`/admin/users/${id}/roles`, { roleIds }),
  setUserStatus: (id: string, action: 'suspend' | 'reactivate' | 'deactivate', reason?: string) => post(`/admin/users/${id}/status`, { action, reason }),

  organizations: (params: P) => getPage<AdminOrgRow>('/admin/organizations', params),
  organization: (id: string) => get<AdminOrgDetail>(`/admin/organizations/${id}`),
  createOrganization: (body: CreateOrganizationBody) => post<{ organization: { id: string; name: string }; owner: { email: string; created: boolean; temporaryPassword: string | null } }>('/admin/organizations', body),
  updateOrganization: (id: string, body: OrganizationProfile & { name?: string }) => patch(`/admin/organizations/${id}`, body),
  orgVerification: (id: string) => get<VerificationOverview>(`/admin/organizations/${id}/verification`),
  uploadOrgDocument: async (id: string, documentType: string, file: File) => {
    const fd = new FormData();
    fd.append('documentType', documentType);
    fd.append('file', file);
    return (await http.post(`/admin/organizations/${id}/documents`, fd)).data.data;
  },
  createOrgSender: (id: string, body: { name: string; purpose: string; sampleMessage?: string; approveNow: boolean; reason: string }) => post<SenderId>(`/admin/organizations/${id}/senders`, body),
  withdrawOrgSender: (id: string, senderId: string, reason: string) => post(`/admin/organizations/${id}/senders/${senderId}/withdraw`, { reason }),
  updateOrgMember: (id: string, memberId: string, body: { roleId?: string; status?: 'ACTIVE' | 'DISABLED'; reason: string }) => patch(`/admin/organizations/${id}/members/${memberId}`, body),
  removeOrgMember: (id: string, memberId: string, reason: string) => post(`/admin/organizations/${id}/members/${memberId}/remove`, { reason }),
  markOrgDocumentOnFile: (id: string, documentType: string, note?: string) => post(`/admin/organizations/${id}/documents/on-file`, { documentType, note }),
  submitOrgDocumentValue: (id: string, documentType: string, value: string) => post(`/admin/organizations/${id}/documents/value`, { documentType, value }),
  deleteOrgDocument: (id: string, documentId: string) => http.delete(`/admin/organizations/${id}/documents/${documentId}`),
  finalizeOrganization: (id: string, body: { outcome: 'SAVE_DRAFT' | 'SUBMIT' | 'APPROVE'; note?: string }) => post<VerificationOverview>(`/admin/organizations/${id}/finalize`, body),
  organizationRoles: (id: string) => get<{ id: string; name: string; description: string | null }[]>(`/admin/organizations/${id}/roles`),
  grantOrganizationAccess: (id: string, body: { person: { fullName: string; email: string; phone?: string }; roleId: string }) => post<{ user: { email: string; created: boolean; temporaryPassword: string | null } }>(`/admin/organizations/${id}/members`, body),
  setOrganizationStatus: (id: string, action: 'suspend' | 'reactivate', reason?: string) => post(`/admin/organizations/${id}/status`, { action, reason }),

  verifications: (params: P) => getPage<VerificationRow>('/admin/verifications', params),
  verification: (id: string) => get<VerificationDetail>(`/admin/verifications/${id}`),
  startReview: (id: string) => post(`/admin/verifications/${id}/start-review`),
  reviewDocument: (id: string, decision: string, note?: string) => post(`/admin/verifications/documents/${id}/review`, { decision, note }),
  decideVerification: (id: string, decision: 'APPROVE' | 'REJECT' | 'REQUEST_INFORMATION', note?: string) => post(`/admin/verifications/${id}/decision`, { decision, note }),

  senders: (params: P) => getPage<SenderId>('/admin/senders', params),
  senderAction: (id: string, action: string, note?: string) => post<SenderId>(`/admin/senders/${id}/${action}`, { note }),

  smsMessages: (params: P) => getPage<SmsRecipient>('/admin/sms/messages', params),
  smsMessage: (id: string) => get<SmsRecipient>(`/admin/sms/messages/${id}`),
  retrySms: (id: string) => post(`/admin/sms/messages/${id}/retry`),
  campaigns: (params: P) => getPage<Campaign>('/admin/sms/campaigns', params),
  cancelCampaign: (id: string) => post(`/admin/sms/campaigns/${id}/cancel`),

  payments: async (params: P) => {
    const r = await http.get('/admin/billing/payments', { params });
    return r.data as { data: Payment[]; pagination: { page: number; limit: number; total: number; totalPages: number }; summary: { status: string; count: number; amount: string }[] };
  },
  verifyPayment: (id: string) => post<Payment>(`/admin/billing/payments/${id}/verify`),
  refundPayment: (id: string, reason: string) => post(`/admin/billing/payments/${id}/refund`, { reason }),
  invoices: (params: P) => getPage<Invoice>('/admin/billing/invoices', params),
  invoice: (id: string) => get<Invoice>(`/admin/billing/invoices/${id}`),
  pricingTiers: () => get<PricingTier[]>('/admin/pricing/tiers'),
  /** Every destination network as customers see it, plus usable provider capacity (providers.view only). */
  pricingNetworks: () => get<(CatalogNetwork & { countryName: string; usableProviderCapacity: number | null })[]>('/admin/pricing/networks'),
  networkInventory: () => get<NetworkInventory>('/admin/pricing/networks/inventory'),
  priceList: (networkId: string | null) => get<PriceListConfig>('/admin/pricing/lists/current', networkId ? { networkId } : {}),
  savePriceList: (body: Record<string, unknown>) => put<PriceListConfig>('/admin/pricing/lists', body),
  /** Replace a price list's prices with a ladder of { minQuantity, unitPrice, name? } steps. */
  savePriceLadder: (body: { networkId: string | null; steps: { minQuantity: number; unitPrice: string; name?: string | null }[] }) => put<PricingTier[]>('/admin/pricing/ladder', body),
  pricingHistory: (params: { page: number; limit?: number; networkId?: string }) => getPage<AuditLog>('/admin/pricing/history', params),
  senderNetworks: (senderId: string) => get<SenderNetworkRow[]>(`/admin/senders/${senderId}/networks`),
  setSenderNetwork: (senderId: string, networkId: string, body: { status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'; note?: string }) => put(`/admin/senders/${senderId}/networks/${networkId}`, body),
  createPricingTier: (body: Record<string, unknown>) => post<PricingTier>('/admin/pricing/tiers', body),
  updatePricingTier: (id: string, body: Record<string, unknown>) => patch<PricingTier>(`/admin/pricing/tiers/${id}`, body),
  deletePricingTier: (id: string) => del(`/admin/pricing/tiers/${id}`),
  pricingQuote: (quantity: number) => get<PriceQuote>('/admin/pricing/quote', { quantity }),
  wallets: (params: P) => getPage<{ id: string; balance: number; lowBalanceThreshold: number; updatedAt: string; organization: { id: string; name: string; status: string } }>('/admin/billing/wallets', params),
  ledger: (params: P) => getPage<WalletTransaction>('/admin/billing/wallet-transactions', params),
  adjustWallet: (organizationId: string, body: { kind: 'CREDIT' | 'DEBIT' | 'REFUND'; amount: number; reason: string; reference: string }) =>
    post<WalletTransaction>(`/admin/billing/wallets/${organizationId}/adjust`, body),

  roles: () => get<Role[]>('/admin/roles'),
  orgRoleTemplates: () => get<Role[]>('/admin/roles/organization-templates'),
  permissions: (scope: 'PLATFORM' | 'ORGANIZATION' = 'PLATFORM') => get<PermissionDef[]>('/admin/roles/permissions', { scope }),
  createRole: (body: { name: string; description?: string; permissions: string[] }) => post<Role>('/admin/roles', body),
  updateRole: (id: string, body: { name?: string; description?: string; permissions?: string[] }) => patch<Role>(`/admin/roles/${id}`, body),
  deleteRole: (id: string) => http.delete(`/admin/roles/${id}`),

  auditLogs: (params: P) => getPage<AuditLog>('/admin/audit-logs', params),
  settings: () => get<Setting[]>('/admin/settings'),
  updateSetting: (key: string, value: unknown) => put(`/admin/settings/${key}`, { value }),
  segmentation: () =>
    get<{
      active: SegmentationConfig;
      versions: SegmentationConfig[];
      limits: Record<'gsm7SingleSegment' | 'gsm7MultiSegment' | 'ucs2SingleSegment' | 'ucs2MultiSegment' | 'maxMessageCharacters', { min: number; max: number }>;
      creditsPerSegment: number;
      maxMessageSegments: number;
    }>('/admin/settings/sms-segmentation'),
  updateSegmentation: (body: Record<string, unknown>) => put<SegmentationConfig>('/admin/settings/sms-segmentation', body),
  providers: () => get<ProviderStatus>('/admin/settings/providers/status'),

  apiKeys: (params: P) => getPage<ApiKey>('/admin/api-keys', params),
  revokeApiKey: (id: string) => post(`/admin/api-keys/${id}/revoke`),
  setApiKeyEnabled: (id: string, enabled: boolean) => post(`/admin/api-keys/${id}/${enabled ? 'enable' : 'disable'}`),
  setOrganizationApiAccess: (id: string, body: { enabled: boolean; allowedScopes: string[] | null }) => put(`/admin/organizations/${id}/api-access`, body),

  apiScopes: () => get<ApiScope[]>('/admin/integrations/scopes'),
  integrations: () => get<IntegrationClient[]>('/admin/integrations'),
  createIntegration: (body: { name: string; scopes: string[]; allowedIps: string[]; expiresAt?: string | null }) => post<{ integration: IntegrationClient; secret: string }>('/admin/integrations', body),
  updateIntegration: (id: string, body: { name?: string; scopes?: string[]; allowedIps?: string[]; expiresAt?: string | null }) => patch<IntegrationClient>(`/admin/integrations/${id}`, body),
  setIntegrationEnabled: (id: string, enabled: boolean) => post(`/admin/integrations/${id}/${enabled ? 'enable' : 'disable'}`),
  revokeIntegration: (id: string) => post(`/admin/integrations/${id}/revoke`),
  rotateIntegration: (id: string, overlapMinutes: number) => post<{ integration: IntegrationClient; secret: string }>(`/admin/integrations/${id}/rotate`, { overlapMinutes }),
  integrationActivity: (id: string) => get<IntegrationActivity[]>(`/admin/integrations/${id}/activity`),
};

export interface NetworkInventory {
  from: string;
  to: string;
  networks: {
    networkId: string;
    name: string;
    code: string;
    countryCode: string;
    status: 'ACTIVE' | 'MAINTENANCE';
    providers: {
      providerId: string;
      name: string;
      type: string;
      status: string;
      health: string;
      capability: 'NETWORK' | 'COUNTRY';
      capacityBalance: number;
      remainingLotCapacity: number;
      averageRemainingCost: string | null;
      currentQuotedCost: string | null;
      consumed: { messages: number; credits: number; providerCost: string | null };
    }[];
  }[];
}

export interface PriceListConfig {
  id: string | null;
  pricingMetric: 'PURCHASE_QUANTITY' | 'MONTHLY_PURCHASE_QUANTITY';
  rateApplication: 'WHOLE_PURCHASE' | 'GRADUATED';
  minPurchaseQuantity: number | null;
  maxPurchaseQuantity: number | null;
  customerNotes: string | null;
  isActive: boolean;
  metricText?: string;
  rateText?: string;
}
