import { get, getPage, http, patch, post, put } from '@/api/client';
import type {
  ApiKey,
  AuditLog,
  Campaign,
  Invoice,
  Organization,
  Payment,
  PermissionDef,
  Role,
  SenderId,
  SeriesPoint,
  SmsPackage,
  SmsRecipient,
  SmsTotals,
  UserStatus,
  VerificationStatus,
  WalletTransaction,
} from '@/api/types';

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

export interface AdminOrgRow extends Organization {
  owner: { fullName: string; email: string } | null;
  balance: number;
  memberCount: number;
  senderCount: number;
}

export interface AdminOrgDetail extends Organization {
  wallet: { id: string; balance: number; lowBalanceThreshold: number } | null;
  members: { id: string; isOwner: boolean; user: { id: string; fullName: string; email: string; status: string; lastLoginAt: string | null }; role: { name: string } }[];
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
  documents: { id: string; documentType: string; originalName: string; mimeType: string; sizeBytes: number; status: string; reviewNote: string | null; createdAt: string }[];
  requirements: { type: string; label: string; required: boolean }[];
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
  packages: () => get<SmsPackage[]>('/admin/billing/packages'),
  createPackage: (body: Record<string, unknown>) => post<SmsPackage>('/admin/billing/packages', body),
  updatePackage: (id: string, body: Record<string, unknown>) => patch<SmsPackage>(`/admin/billing/packages/${id}`, body),
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
  providers: () => get<ProviderStatus>('/admin/settings/providers/status'),

  apiKeys: (params: P) => getPage<ApiKey>('/admin/api-keys', params),
  revokeApiKey: (id: string) => post(`/admin/api-keys/${id}/revoke`),
};
