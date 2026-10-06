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
  risk: RiskLevel;
  /** `risk` is high or critical: needs an IP allow-list and an expiry on the credential. */
  highRisk?: boolean;
}

const ORGANIZATION: ApiScopeDef[] = [
  { key: 'sms.send', level: 'ORGANIZATION', group: 'Public API', label: 'Send SMS', description: 'Send messages on behalf of the organization (spends its credits).', risk: 'normal' },
  { key: 'sms.read', level: 'ORGANIZATION', group: 'Public API', label: 'Read messages', description: 'Read the status and delivery of the organization’s messages.', risk: 'normal' },
  { key: 'balance.read', level: 'ORGANIZATION', group: 'Public API', label: 'Read balance', description: 'Read the organization’s SMS credit balance.', risk: 'normal' },
];

export type RiskLevel = 'normal' | 'high' | 'critical';

/**
 * A Super Admin may grant a credential any platform permission, but risk decides the extra controls:
 *  - high:     moves money or changes access/configuration → needs an IP allow-list and an expiry.
 *  - critical: can change who holds power (roles, users, credentials) → same controls, and the
 *              credential can never be used to manage other credentials (see `humanOnly`).
 * Everything not listed is `normal`.
 */
const CRITICAL = new Set(['roles.create', 'roles.update', 'roles.delete', 'roles.assign', 'users.create', 'users.update', 'integrations.manage']);
const HIGH = new Set([
  'wallet.adjust', 'wallet.refund', 'payments.refund', 'payments.verify', 'packages.manage', 'settings.update',
  'providers.manage', 'provider_purchases.create', 'expenses.manage', 'users.approve', 'api_keys.revoke',
]);
export const scopeRisk = (key: string): RiskLevel => (CRITICAL.has(key) ? 'critical' : HIGH.has(key) ? 'high' : 'normal');
/** Scopes that require an IP allow-list and an expiry on the credential. */
export const requiresControls = (key: string) => scopeRisk(key) !== 'normal';
export const isHighRiskScope = requiresControls;

const PLATFORM: ApiScopeDef[] = PERMISSIONS.filter((p) => p.scopes.includes('PLATFORM')).map((p) => ({
  key: p.key,
  level: 'PLATFORM',
  group: p.group,
  label: p.key,
  description: p.description,
  risk: scopeRisk(p.key),
  highRisk: requiresControls(p.key),
}));

export const SCOPES: ApiScopeDef[] = [...ORGANIZATION, ...PLATFORM];

const tuple = (level: ScopeLevel) => SCOPES.filter((s) => s.level === level).map((s) => s.key) as [string, ...string[]];
export const ORGANIZATION_SCOPES = tuple('ORGANIZATION');
export const PLATFORM_SCOPES = tuple('PLATFORM');
