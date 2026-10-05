import { PERMISSIONS } from '../permissions/catalog';

/**
 * Single registry of every scope an API credential can carry.
 *
 *  - ORGANIZATION scopes belong to organization API keys (`sgw_live_…`, the public API). A
 *    platform admin can cap which of them an organization may use.
 *  - PLATFORM scopes are platform permission keys. A platform integration credential
 *    (`sgw_int_…`) holding a permission may call the admin API endpoints that need it, exactly
 *    like a staff member with the same permission — nothing more.
 */
export type ScopeLevel = 'PLATFORM' | 'ORGANIZATION';

export interface ApiScopeDef {
  key: string;
  level: ScopeLevel;
  group: string;
  label: string;
  description: string;
  /** Moves money or changes access: needs an IP allow-list and an expiry on the credential. */
  highRisk?: boolean;
}

const ORGANIZATION: ApiScopeDef[] = [
  { key: 'sms.send', level: 'ORGANIZATION', group: 'Public API', label: 'Send SMS', description: 'Send messages on behalf of the organization (spends its credits).' },
  { key: 'sms.read', level: 'ORGANIZATION', group: 'Public API', label: 'Read messages', description: 'Read the status and delivery of the organization’s messages.' },
  { key: 'balance.read', level: 'ORGANIZATION', group: 'Public API', label: 'Read balance', description: 'Read the organization’s SMS credit balance.' },
];

/**
 * A Super Admin may grant a credential any platform permission. The ones below can move money or
 * change who has access, so a credential holding any of them must also be locked to specific IP
 * addresses and have an expiry date (enforced when the credential is created).
 */
const HIGH_RISK = new Set([
  'wallet.adjust', 'wallet.refund', 'payments.refund', 'payments.verify', 'packages.manage', 'settings.update',
  'providers.manage', 'provider_purchases.create', 'expenses.manage',
  'roles.create', 'roles.update', 'roles.delete', 'roles.assign', 'users.create', 'users.update', 'users.approve',
  'integrations.manage', 'api_keys.revoke',
]);
export const isHighRiskScope = (key: string) => HIGH_RISK.has(key);

const PLATFORM: ApiScopeDef[] = PERMISSIONS.filter((p) => p.scopes.includes('PLATFORM')).map((p) => ({
  key: p.key,
  level: 'PLATFORM',
  group: p.group,
  label: p.key,
  description: p.description,
  highRisk: HIGH_RISK.has(p.key),
}));

export const SCOPES: ApiScopeDef[] = [...ORGANIZATION, ...PLATFORM];

const tuple = (level: ScopeLevel) => SCOPES.filter((s) => s.level === level).map((s) => s.key) as [string, ...string[]];
export const ORGANIZATION_SCOPES = tuple('ORGANIZATION');
export const PLATFORM_SCOPES = tuple('PLATFORM');
