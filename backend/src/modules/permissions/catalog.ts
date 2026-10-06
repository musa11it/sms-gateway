/**
 * Permission catalog.
 *
 * Permissions exist in two scopes:
 *  - PLATFORM: granted to staff through platform roles (UserRole). Guards admin APIs.
 *  - ORGANIZATION: granted to organization members through their member role. Guards tenant APIs.
 *
 * The same key (e.g. "sms.view") can exist in both scopes with different meaning:
 * platform "sms.view" = monitor all traffic; organization "sms.view" = view own org's messages.
 */

export type Scope = 'PLATFORM' | 'ORGANIZATION';

interface PermissionDef {
  key: string;
  group: string;
  description: string;
  scopes: Scope[];
}

const P = (key: string, group: string, description: string, scopes: Scope[]): PermissionDef => ({
  key,
  group,
  description,
  scopes,
});
const BOTH: Scope[] = ['PLATFORM', 'ORGANIZATION'];
const PLAT: Scope[] = ['PLATFORM'];
const ORG: Scope[] = ['ORGANIZATION'];

export const PERMISSIONS: PermissionDef[] = [
  P('dashboard.view', 'Dashboard', 'View dashboard', BOTH),

  P('users.view', 'Users', 'View platform users', PLAT),
  P('users.create', 'Users', 'Create platform users', PLAT),
  P('users.update', 'Users', 'Update platform users', PLAT),
  P('users.suspend', 'Users', 'Suspend or reactivate users', PLAT),
  P('users.approve', 'Users', 'Approve or reject user accounts', PLAT),

  P('organizations.view', 'Organizations', 'View organization details', BOTH),
  P('organizations.create', 'Organizations', 'Create organizations and give users access to them', PLAT),
  P('organizations.update', 'Organizations', 'Update organization profile', BOTH),
  P('organizations.suspend', 'Organizations', 'Suspend or reactivate organizations', PLAT),

  P('team.view', 'Team', 'View team members and invitations', ORG),
  P('team.invite', 'Team', 'Invite team members', ORG),
  P('team.manage', 'Team', 'Change member roles, disable or remove members', ORG),

  P('verification.view', 'Verification', 'View verification submissions and documents', BOTH),
  P('verification.submit', 'Verification', 'Upload documents and submit verification', ORG),
  P('verification.review', 'Verification', 'Start reviewing and request changes', PLAT),
  P('verification.approve', 'Verification', 'Approve verification', PLAT),
  P('verification.reject', 'Verification', 'Reject verification', PLAT),

  P('senders.view', 'Sender IDs', 'View sender IDs', BOTH),
  P('senders.request', 'Sender IDs', 'Request sender IDs', ORG),
  P('senders.allocate', 'Sender IDs', 'Allocate wallet credits to sender IDs and set their alerts', ORG),
  P('senders.review', 'Sender IDs', 'Review sender ID requests', PLAT),
  P('senders.approve', 'Sender IDs', 'Approve sender IDs', PLAT),
  P('senders.reject', 'Sender IDs', 'Reject sender IDs', PLAT),
  P('senders.suspend', 'Sender IDs', 'Suspend sender IDs', PLAT),

  P('wallet.view', 'Wallet', 'View wallet balance and transactions', BOTH),
  P('wallet.purchase', 'Wallet', 'Buy SMS credits', ORG),
  P('wallet.adjust', 'Wallet', 'Manually credit or debit wallets', PLAT),
  P('wallet.refund', 'Wallet', 'Refund credits to wallets', PLAT),

  P('sms.view', 'SMS', 'View SMS messages and delivery reports', BOTH),
  P('sms.send', 'SMS', 'Send SMS', ORG),
  P('sms.cancel', 'SMS', 'Cancel scheduled SMS', BOTH),
  P('sms.retry', 'SMS', 'Retry failed SMS', PLAT),

  P('campaigns.view', 'Campaigns', 'View campaigns', BOTH),
  P('campaigns.create', 'Campaigns', 'Create campaigns', ORG),
  P('campaigns.update', 'Campaigns', 'Edit draft campaigns', ORG),
  P('campaigns.delete', 'Campaigns', 'Delete draft campaigns', ORG),
  P('campaigns.send', 'Campaigns', 'Launch campaigns immediately', ORG),
  P('campaigns.schedule', 'Campaigns', 'Schedule campaigns', ORG),
  P('campaigns.cancel', 'Campaigns', 'Cancel scheduled campaigns', BOTH),

  P('contacts.view', 'Contacts', 'View and export contacts', ORG),
  P('contacts.create', 'Contacts', 'Create contacts and groups', ORG),
  P('contacts.update', 'Contacts', 'Update contacts and groups', ORG),
  P('contacts.delete', 'Contacts', 'Delete contacts and groups', ORG),
  P('contacts.import', 'Contacts', 'Import contacts from CSV', ORG),

  P('packages.view', 'Pricing', 'View SMS pricing ranges and profit planning', PLAT),
  P('packages.manage', 'Pricing', 'Create and edit SMS pricing ranges', PLAT),

  P('payments.view', 'Payments', 'View payments', BOTH),
  P('payments.create', 'Payments', 'Create payments', ORG),
  P('payments.refund', 'Payments', 'Refund payments', PLAT),
  P('payments.verify', 'Payments', 'Re-verify payments with the provider', PLAT),

  P('invoices.view', 'Invoices', 'View invoices', BOTH),

  P('api_keys.view', 'API Keys', 'View API keys and API logs', BOTH),
  P('api_keys.create', 'API Keys', 'Create and regenerate API keys', ORG),
  P('api_keys.revoke', 'API Keys', 'Revoke API keys', BOTH),

  P('webhooks.view', 'Webhooks', 'View webhooks and deliveries', BOTH),
  P('webhooks.create', 'Webhooks', 'Create webhooks', ORG),
  P('webhooks.update', 'Webhooks', 'Update webhooks', ORG),
  P('webhooks.delete', 'Webhooks', 'Delete webhooks', ORG),

  P('reports.view', 'Reports', 'View reports and analytics', BOTH),
  P('audit_logs.view', 'Audit Logs', 'View audit logs', BOTH),

  P('settings.view', 'Settings', 'View settings', BOTH),
  P('settings.update', 'Settings', 'Update settings', BOTH),
  P('providers.view', 'Providers', 'View SMS providers, capacity and configuration', PLAT),
  P('providers.manage', 'Providers', 'Configure SMS providers, routes and capacity adjustments', PLAT),
  P('provider_purchases.view', 'Providers', 'View purchases of SMS capacity from providers', PLAT),
  P('provider_purchases.create', 'Providers', 'Purchase SMS capacity from providers', PLAT),

  P('finance.view', 'Finance', 'View revenue, costs, sales and financial reports', PLAT),
  P('profit.view', 'Finance', 'View margin and profit calculations', PLAT),
  P('expenses.view', 'Finance', 'View operating expenses', PLAT),
  P('expenses.manage', 'Finance', 'Record and edit operating expenses', PLAT),

  P('integrations.view', 'Integrations', 'View external system credentials and their activity', PLAT),
  P('integrations.manage', 'Integrations', 'Issue, restrict, disable and revoke credentials for external systems', PLAT),

  P('inquiries.view', 'Support', 'View and handle contact inquiries from the website', PLAT),

  P('roles.view', 'Roles', 'View roles', BOTH),
  P('roles.create', 'Roles', 'Create roles', BOTH),
  P('roles.update', 'Roles', 'Update roles and their permissions', BOTH),
  P('roles.delete', 'Roles', 'Delete custom roles', BOTH),
  P('roles.assign', 'Roles', 'Assign platform roles to staff', PLAT),
  P('permissions.view', 'Roles', 'View the permission catalog', BOTH),
];

export const platformKeys = PERMISSIONS.filter((p) => p.scopes.includes('PLATFORM')).map((p) => p.key);
export const orgKeys = PERMISSIONS.filter((p) => p.scopes.includes('ORGANIZATION')).map((p) => p.key);

interface RoleDef {
  code: string;
  name: string;
  description: string;
  scope: Scope;
  permissions: string[] | '*';
}

const pick = (keys: string[], prefixes: string[]) => keys.filter((k) => prefixes.some((p) => k === p || k.startsWith(`${p}.`)));

export const SYSTEM_ROLES: RoleDef[] = [
  {
    code: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Unrestricted platform access. Always holds every platform permission.',
    scope: 'PLATFORM',
    permissions: '*',
  },
  {
    code: 'ADMIN',
    name: 'Admin',
    description: 'Platform administrator. Permissions controlled by Super Admin.',
    scope: 'PLATFORM',
    permissions: [
      'dashboard.view',
      ...pick(platformKeys, ['users', 'organizations', 'verification', 'senders', 'sms', 'campaigns', 'payments', 'invoices']),
      'wallet.view',
      'packages.view',
      'api_keys.view',
      'webhooks.view',
      'reports.view',
      'audit_logs.view',
      'settings.view',
      'providers.view',
      'providers.manage',
      'provider_purchases.view',
      'finance.view',
      'inquiries.view',
      'roles.view',
      'permissions.view',
    ].filter((k) => k !== 'users.create' && k !== 'payments.refund'),
  },
  {
    code: 'SUPPORT',
    name: 'Support',
    description: 'Customer support: read-only visibility into customers and their messaging.',
    scope: 'PLATFORM',
    permissions: [
      'dashboard.view',
      'users.view',
      'organizations.view',
      'verification.view',
      'senders.view',
      'sms.view',
      'campaigns.view',
      'wallet.view',
      'payments.view',
      'invoices.view',
      'reports.view',
      'inquiries.view',
    ],
  },
  {
    code: 'FINANCE',
    name: 'Finance',
    description: 'Payments, invoices, refunds and wallet ledger.',
    scope: 'PLATFORM',
    permissions: [
      'dashboard.view',
      'organizations.view',
      'payments.view',
      'payments.verify',
      'payments.refund',
      'invoices.view',
      'wallet.view',
      'wallet.refund',
      'packages.view',
      'reports.view',
      'finance.view',
      'profit.view',
      'expenses.view',
      'expenses.manage',
      'provider_purchases.view',
      'providers.view',
    ],
  },
  {
    code: 'SMS_OPERATOR',
    name: 'SMS Operator',
    description: 'Monitors SMS traffic and delivery, retries failures, reviews sender IDs.',
    scope: 'PLATFORM',
    permissions: [
      'dashboard.view',
      'organizations.view',
      'sms.view',
      'sms.retry',
      'sms.cancel',
      'campaigns.view',
      'campaigns.cancel',
      'senders.view',
      'senders.review',
      'reports.view',
      'providers.view',
      'provider_purchases.view',
    ],
  },
  {
    code: 'CUSTOMER_OWNER',
    name: 'Owner',
    description: 'Organization owner with full access to the organization.',
    scope: 'ORGANIZATION',
    permissions: '*',
  },
  {
    code: 'CUSTOMER_MANAGER',
    name: 'Manager',
    description: 'Runs day-to-day messaging, contacts, campaigns and billing.',
    scope: 'ORGANIZATION',
    permissions: orgKeys.filter(
      (k) =>
        !k.startsWith('roles.') &&
        k !== 'team.manage' &&
        k !== 'api_keys.create' &&
        k !== 'api_keys.revoke' &&
        !k.startsWith('webhooks.') &&
        k !== 'settings.update' &&
        k !== 'organizations.update',
    ).concat(['webhooks.view']),
  },
  {
    code: 'CUSTOMER_FINANCE',
    name: 'Finance',
    description: 'Buys credits and manages payments, invoices and spending reports.',
    scope: 'ORGANIZATION',
    permissions: ['dashboard.view', 'organizations.view', 'wallet.view', 'wallet.purchase', 'payments.view', 'payments.create', 'invoices.view', 'reports.view', 'sms.view', 'senders.view', 'senders.allocate'],
  },
  {
    code: 'CUSTOMER_MARKETING',
    name: 'Marketing',
    description: 'Runs campaigns, manages contacts and sender IDs.',
    scope: 'ORGANIZATION',
    permissions: [
      'dashboard.view',
      'organizations.view',
      'wallet.view',
      'senders.view',
      'senders.request',
      'sms.view',
      'sms.send',
      'sms.cancel',
      ...orgKeys.filter((k) => k.startsWith('campaigns.') || k.startsWith('contacts.')),
      'reports.view',
    ],
  },
  {
    code: 'CUSTOMER_DEVELOPER',
    name: 'Developer',
    description: 'Integrates the SMS API: API keys, webhooks and API logs.',
    scope: 'ORGANIZATION',
    permissions: ['dashboard.view', 'organizations.view', 'wallet.view', 'senders.view', 'sms.view', 'api_keys.view', 'api_keys.create', 'api_keys.revoke', ...orgKeys.filter((k) => k.startsWith('webhooks.')), 'reports.view'],
  },
  {
    code: 'CUSTOMER_STAFF',
    name: 'Staff',
    description: 'Sends and views SMS; manages contacts.',
    scope: 'ORGANIZATION',
    permissions: [
      'dashboard.view',
      'organizations.view',
      'senders.view',
      'wallet.view',
      'sms.view',
      'sms.send',
      'campaigns.view',
      'contacts.view',
      'contacts.create',
      'contacts.update',
      'reports.view',
    ],
  },
];

/**
 * Versioned permission grants for roles that already exist in a database. Seeding creates
 * new roles with their full definition, but only applies these *additions* to existing
 * roles (once per version), so Super Admin customisations are never overwritten.
 */
export const GRANT_MIGRATIONS: { version: number; grants: Record<string, string[]> }[] = [
  {
    version: 2,
    grants: {
      ADMIN: ['providers.manage', 'provider_purchases.view', 'finance.view', 'inquiries.view'],
      FINANCE: ['finance.view', 'profit.view', 'expenses.view', 'expenses.manage', 'provider_purchases.view', 'providers.view'],
      SUPPORT: ['inquiries.view'],
      SMS_OPERATOR: ['provider_purchases.view'],
    },
  },
  {
    version: 3,
    grants: {
      CUSTOMER_MANAGER: ['senders.allocate'],
      CUSTOMER_FINANCE: ['senders.allocate'],
      ADMIN: ['organizations.create'],
    },
  },
  {
    // Two branches both shipped a "version 3"; databases seeded from either one only received half
    // of it. Re-apply both (grants are additive and idempotent).
    version: 4,
    grants: {
      CUSTOMER_MANAGER: ['senders.allocate'],
      CUSTOMER_FINANCE: ['senders.allocate'],
      ADMIN: ['organizations.create'],
    },
  },
];

export function resolveRolePermissions(role: RoleDef): string[] {
  const all = role.scope === 'PLATFORM' ? platformKeys : orgKeys;
  return role.permissions === '*' ? all : role.permissions.filter((k) => all.includes(k));
}
