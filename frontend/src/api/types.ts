export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  message?: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  success: boolean;
  data: T[];
  pagination: Pagination;
}

export type UserStatus = 'PENDING_EMAIL_VERIFICATION' | 'PENDING_REVIEW' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED' | 'DEACTIVATED';
export type OrganizationStatus = 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED';
export type VerificationStatus = 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'MORE_INFORMATION_REQUIRED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type SenderStatus = 'PENDING' | 'UNDER_REVIEW' | 'NEEDS_INFORMATION' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type RecipientStatus = 'QUEUED' | 'PROCESSING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
export type BatchStatus = 'SCHEDULED' | 'QUEUED' | 'PROCESSING' | 'SENT' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
export type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'PARTIALLY_COMPLETED' | 'FAILED' | 'CANCELLED';
export type PaymentStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
export type TxType = 'PURCHASE' | 'SMS_DEBIT' | 'REFUND' | 'ADMIN_CREDIT' | 'ADMIN_DEBIT' | 'ADJUSTMENT' | 'EXPIRATION';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  statusReason: string | null;
  businessType: string | null;
  country: string | null;
  address: string | null;
  city: string | null;
  registrationNumber: string | null;
  taxId: string | null;
  website: string | null;
  contactPersonName: string | null;
  contactPersonPhone: string | null;
  contactPersonEmail: string | null;
  smsPurpose: string | null;
  expectedMonthlyVolume: number | null;
  timezone: string;
  approvedAt: string | null;
  suspendedAt: string | null;
  createdAt: string;
}

export interface Me {
  user: { id: string; email: string; fullName: string; phone: string | null; phoneVerifiedAt: string | null; status: UserStatus; statusReason: string | null; emailVerifiedAt: string | null; createdAt: string };
  platform: { roles: string[]; permissions: string[] };
  isStaff: boolean;
  memberships: { organizationId: string; organizationName: string; organizationStatus: OrganizationStatus; role: { id: string; code: string; name: string }; isOwner: boolean }[];
  organization:
    | (Organization & {
        verification: { id: string; status: VerificationStatus; reviewNote: string | null; submittedAt: string | null; reviewedAt: string | null } | null;
        role: { id: string; code: string; name: string };
        isOwner: boolean;
      })
    | null;
  orgPermissions: string[];
}

export interface SenderId {
  id: string;
  name: string;
  status: SenderStatus;
  purpose: string;
  sampleMessage: string | null;
  useCase: string | null;
  reviewNote: string | null;
  createdAt: string;
  approvedAt: string | null;
  organization?: { id: string; name: string; status: OrganizationStatus };
}

export interface Wallet {
  balance: number;
  lowBalanceThreshold: number;
  isLow: boolean;
  thisMonth: { purchased: number; consumed: number };
  expiringSoon?: { credits: number; withinDays: number; nextExpiry: { at: string; credits: number } | null };
}

export interface WalletTransaction {
  id: string;
  type: TxType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reference: string;
  description: string;
  createdAt: string;
  createdBy: { fullName: string } | null;
  organization?: { id: string; name: string };
}

export interface SmsPackage {
  id: string;
  name: string;
  description: string | null;
  credits: number;
  price: string;
  currency: string;
  pricePerSms: string;
  validityDays: number | null;
  isPopular: boolean;
  isActive?: boolean;
  sortOrder?: number;
  paymentCount?: number;
}

export interface Payment {
  id: string;
  reference: string;
  provider: string;
  providerReference: string | null;
  method: 'MOBILE_MONEY' | 'CARD' | 'BANK_TRANSFER';
  payerPhone: string | null;
  packageName: string;
  credits: number;
  amount: string;
  feeAmount?: string;
  pricingTierId?: string | null;
  unitPrice?: string | null;
  tierMinQuantity?: number | null;
  tierMaxQuantity?: number | null;
  creditValidityDays?: number | null;
  currency: string;
  status: PaymentStatus;
  failureReason: string | null;
  createdAt: string;
  verifiedAt: string | null;
  invoice: { id: string; number: string } | null;
  organization?: { id: string; name: string };
}

export interface Invoice {
  id: string;
  number: string;
  customerName: string;
  customerEmail: string | null;
  billingAddress: string | null;
  taxId: string | null;
  description: string;
  quantity: number;
  unitPrice: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
  currency: string;
  status: 'PAID' | 'VOID' | 'REFUNDED';
  issuedAt: string;
  payment: { id: string; reference: string; method: string; status: PaymentStatus; packageName: string };
  issuer?: { name: string; address: string };
}

export interface SmsBatch {
  id: string;
  senderName: string;
  body: string;
  source: 'DASHBOARD' | 'API' | 'CAMPAIGN';
  status: BatchStatus;
  segments: number;
  encoding: 'GSM7' | 'UCS2';
  characterCount: number;
  recipientCount: number;
  totalCredits: number;
  scheduledAt: string | null;
  createdAt: string;
  campaign: { id: string; name: string } | null;
  stats?: { delivered: number; failed: number; pending: number; cancelled: number };
  statusBreakdown?: Partial<Record<RecipientStatus, number>>;
}

export interface SmsRecipient {
  id: string;
  messageId: string;
  phone: string;
  status: RecipientStatus;
  credits: number;
  provider: string | null;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  refunded: boolean;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  message: { id: string; body: string; senderName: string; source: string; segments: number; encoding?: string; campaignId?: string | null };
  organization?: { id: string; name: string };
  deliveryReports?: { id: string; status: RecipientStatus; providerStatus: string | null; errorCode: string | null; errorMessage: string | null; source: string; provider: string; occurredAt: string; createdAt: string }[];
}

export interface Quote {
  encoding: 'GSM7' | 'UCS2';
  characterCount: number;
  units: number;
  segments: number;
  perSegment: number;
  remainingInSegment: number;
  segmentationVersion: number;
  recipientCount: number;
  creditsPerRecipient: number;
  totalCredits: number;
  invalid: { field: string; message: string }[];
  duplicates: number;
  optedOut: number;
  balance: number;
  remainingAfterSend: number;
  sufficientBalance: boolean;
}

export interface MessageEstimate {
  encoding: 'GSM7' | 'UCS2';
  characterCount: number;
  units: number;
  segmentCount: number;
  creditsPerRecipient: number;
  charactersPerSingleSegment: number;
  charactersPerMultipartSegment: number;
  remainingInSegment: number;
  maxMessageCharacters: number;
  tooLong: boolean;
  segmentationVersion: number;
}

export interface SegmentationConfig {
  version: number;
  gsm7: { singleSegment: number; multiSegment: number };
  ucs2: { singleSegment: number; multiSegment: number };
  maxMessageCharacters: number;
  reason: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface Contact {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  tags: string[];
  status: 'ACTIVE' | 'UNSUBSCRIBED' | 'BLOCKED';
  createdAt: string;
  groups: { id: string; name: string; color: string | null }[];
}

export interface ContactGroup {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  contactCount: number;
  createdAt: string;
}

export interface CampaignStats {
  recipients: number;
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
  creditsUsed: number;
}

export interface Campaign {
  id: string;
  name: string;
  message: string;
  status: CampaignStatus;
  senderId: string;
  scheduledAt: string | null;
  timezone: string;
  failureReason: string | null;
  launchedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  sender: { id: string; name: string; status: SenderStatus };
  stats: CampaignStats;
  groups?: { id: string; name: string; color: string | null; contactCount: number }[];
  recipients?: { id: string; phone: string; contactId: string | null }[];
  explicitRecipientCount?: number;
  smsMessage?: { id: string; status: BatchStatus; segments: number; encoding: string; totalCredits: number; recipientCount: number } | null;
  organization?: { id: string; name: string };
}

export interface ApiKey {
  id: string;
  name: string;
  maskedKey: string;
  prefix: string;
  scopes: string[];
  allowedIps: string[];
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  usageCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  environment: string;
  isEnabled: boolean;
  rateLimitPerMinute: number | null;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'DISABLED';
  createdAt: string;
  createdBy: string | null;
  organization?: { id: string; name: string };
}

export interface Webhook {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  isActive: boolean;
  createdAt: string;
  stats7d?: { success: number; failed: number; pending: number };
}

export interface WebhookDelivery {
  id: string;
  event: string;
  eventId: string;
  status: 'PENDING' | 'SUCCESS' | 'RETRYING' | 'FAILED';
  attempts: number;
  responseStatus: number | null;
  responseBody: string | null;
  lastError: string | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  payload: unknown;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  actorType: 'USER' | 'API_KEY' | 'SYSTEM';
  actorEmail: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
  actor: { id: string; fullName: string; email: string } | null;
  organization: { id: string; name: string } | null;
}

export interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isCustom: boolean;
  fullAccess: boolean;
  editable: boolean;
  permissions: string[];
  assignedCount: number;
}

export interface PermissionDef {
  key: string;
  group: string;
  description: string;
}

export interface SeriesPoint {
  label: string;
  total: number;
  delivered: number;
  failed: number;
  pending: number;
}

export interface SmsTotals {
  total: number;
  delivered: number;
  failed: number;
  pending: number;
  cancelled: number;
  deliveryRate: number | null;
  deliveryRateBasis: { final: number; total: number };
}

export interface PricingTier {
  id: string;
  name: string | null;
  minQuantity: number;
  maxQuantity: number | null;
  unitPrice: string;
  currency: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  purchaseCount?: number;
}

export interface PriceQuote {
  quantity: number;
  tier: { id: string; name: string | null; minQuantity: number; maxQuantity: number | null; label: string };
  unitPrice: string;
  subtotal: string;
  savings: { comparedToUnitPrice: string; amount: string; percent: number } | null;
  total: string;
  currency: string;
}

export interface SenderAllocation {
  id: string;
  senderId: string;
  allocated: number;
  used: number;
  remaining: number;
  usagePercent: number;
  isActive: boolean;
  alertThresholds: number[];
  lastAlertThreshold: number | null;
  updatedAt: string;
  senderName?: string;
  senderStatus?: SenderStatus;
}

export interface AllocationOverview {
  balance: number;
  reserved: number;
  unallocated: number;
  allocations: SenderAllocation[];
}

export interface CustomerFinanceRow {
  organization: { id: string; name: string };
  smsPurchased: number;
  revenue: string;
  refunds: string;
  smsUsed: number;
  currentBalance: number;
  messagesRouted: number;
  providerUsage: { providerId: string | null; provider: string; messages: number }[];
  providerCost: string;
  grossMargin: string | null;
}
