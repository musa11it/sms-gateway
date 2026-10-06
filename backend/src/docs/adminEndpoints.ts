import type { Router } from 'express';
import { adminMounts } from '../routes';

/**
 * Builds the OpenAPI paths for the platform administration API by reading the real routers, so
 * the documentation can never list an endpoint that does not exist or miss one that does.
 * Permissions come from `requirePlatformPermission`; routes that check inline are listed in INLINE.
 */

/** Alias of /api-credentials; documented once under the canonical name. */
const HIDDEN = new Set(['/integrations']);
/** Credential management: only a signed-in staff member can call it, never a credential. */
const HUMAN_ONLY = new Set(['/api-credentials']);

/** Routes whose permission is decided inside the handler. Any one of the listed permissions is enough. */
const INLINE: Record<string, { anyOf: string[]; note: string }> = {
  'POST /verifications/{id}/decision': {
    anyOf: ['verification.approve', 'verification.reject', 'verification.review'],
    note: '`APPROVE` needs `verification.approve`, `REJECT` needs `verification.reject`, `REQUEST_INFORMATION` needs `verification.review`.',
  },
  'POST /senders/{id}/{action}': {
    anyOf: ['senders.review', 'senders.approve', 'senders.reject', 'senders.suspend'],
    note: '`review` and `request_info` need `senders.review`, `approve` needs `senders.approve`, `reject` needs `senders.reject`, `suspend` and `reactivate` need `senders.suspend`.',
  },
  'POST /billing/wallets/{organizationId}/adjust': {
    anyOf: ['wallet.adjust', 'wallet.refund'],
    note: 'Body `kind` `CREDIT` or `DEBIT` needs `wallet.adjust`; `REFUND` needs `wallet.refund`. Both are high-risk permissions.',
  },
};

type Body = { contentType?: string; required: string[]; properties: Record<string, unknown>; example: unknown; summary: string; response?: unknown };
const str = (description?: string, extra: object = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const person = { type: 'object', required: ['fullName', 'email'], properties: { fullName: str(), email: str(undefined, { format: 'email' }), phone: str('Rwandan or international format') } };
const scopesProp = { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Platform permission keys, e.g. `organizations.view`. The full list is in the admin screen and under "Platform scopes" above.' };

/** Hand-written request bodies for the endpoints external systems are most likely to call. */
const BODIES: Record<string, Body> = {
  'POST /api-credentials': {
    summary: 'Create a credential',
    required: ['name', 'scopes'],
    properties: { name: str('For example "Finance System"'), scopes: scopesProp, allowedIps: { type: 'array', items: { type: 'string' }, description: 'Addresses allowed to use the key. Required in production and for high-risk scopes — send `["*"]` to deliberately allow any address.' }, expiresAt: str('Required for high-risk scopes', { format: 'date-time' }) },
    example: { name: 'Finance System', scopes: ['verification.view', 'verification.review'], allowedIps: ['196.0.2.10'], expiresAt: '2027-01-01T00:00:00Z' },
    response: { type: 'object', properties: { success: { const: true }, data: { type: 'object', properties: { integration: { type: 'object', additionalProperties: true }, secret: str('The full key, e.g. `sgw_int_<prefix>_<secret>`. Shown **once** and never stored.') } } } },
  },
  'PATCH /api-credentials/{id}': {
    summary: 'Change a credential’s name, scopes, IP list or expiry',
    required: [],
    properties: { name: str(), scopes: scopesProp, allowedIps: { type: 'array', items: { type: 'string' } }, expiresAt: { type: ['string', 'null'], format: 'date-time' } },
    example: { allowedIps: ['196.0.2.10', '196.0.2.11'] },
  },
  'POST /api-credentials/{id}/rotate': {
    summary: 'Issue a new key for the same credential',
    required: [],
    properties: { overlapMinutes: { type: 'integer', minimum: 0, maximum: 1440, default: 0, description: 'Keep the old key valid this long so the other system can deploy the new one.' } },
    example: { overlapMinutes: 60 },
    response: { type: 'object', properties: { success: { const: true }, data: { type: 'object', properties: { integration: { type: 'object', additionalProperties: true }, secret: str('The new full key — shown once.') } } } },
  },
  'POST /organizations': {
    summary: 'Create an organization and its owner',
    required: ['name', 'owner'],
    properties: {
      name: str(), businessType: str(), country: str(), city: str(), address: str(), registrationNumber: str(), taxId: str(), website: str(),
      contactPersonName: str(), contactPersonPhone: str(), contactPersonEmail: str(), smsPurpose: str(),
      owner: person,
      activate: { type: 'boolean', default: false, description: 'Skip verification and approve now. Needs `verification.approve` as well.' },
      apiAccess: { type: 'object', required: ['enabled', 'allowedScopes'], properties: { enabled: { type: 'boolean' }, allowedScopes: { type: ['array', 'null'], items: { enum: ['sms.send', 'sms.read', 'balance.read'] }, description: 'null = all organization scopes' } }, description: 'Needs `api_keys.revoke` as well.' },
    },
    example: { name: 'Kigali Fresh Foods', country: 'Rwanda', owner: { fullName: 'Aline Uwase', email: 'aline@kigalifresh.example', phone: '0788123456' }, activate: false },
    response: { type: 'object', properties: { success: { const: true }, data: { type: 'object', properties: { organization: { type: 'object', additionalProperties: true }, owner: { type: 'object', properties: { id: str(), email: str(), created: { type: 'boolean' }, temporaryPassword: { type: ['string', 'null'], description: 'Generated password for a brand-new owner. Shown **once**; `null` if the account already existed.' } } } } } } },
  },
  'PATCH /organizations/{id}': {
    summary: 'Update an organization’s profile',
    required: [],
    properties: { name: str(), businessType: str(), country: str(), city: str(), address: str(), registrationNumber: str(), taxId: str(), website: str(), contactPersonName: str(), contactPersonPhone: str(), contactPersonEmail: str(), smsPurpose: str(), expectedMonthlyVolume: { type: 'integer', minimum: 0 } },
    example: { registrationNumber: 'RDB-2026-0042', address: 'KN 4 Ave, Kigali' },
  },
  'POST /organizations/{id}/documents': {
    summary: 'Upload a verification document on the organization’s behalf',
    contentType: 'multipart/form-data',
    required: ['documentType', 'file'],
    properties: { documentType: str('The requirement type from `GET /admin/organizations/{id}/verification`, e.g. `BUSINESS_REGISTRATION`'), file: { type: 'string', format: 'binary', description: 'PDF, PNG or JPEG, within the requirement’s size limit' } },
    example: undefined,
  },
  'POST /organizations/{id}/documents/on-file': {
    summary: 'Record that a required file is already held by the platform',
    required: ['documentType'],
    properties: { documentType: str('A file-type requirement, e.g. `BUSINESS_REGISTRATION`'), note: str('Optional: where the original is kept or how it was checked', { maxLength: 300 }) },
    example: { documentType: 'BUSINESS_REGISTRATION', note: 'Checked in person at the RDB office, 2 Oct' },
  },
  'POST /organizations/{id}/documents/value': {
    summary: 'Provide a link, text, date or choice answer on the organization’s behalf',
    required: ['documentType', 'value'],
    properties: { documentType: str(), value: str('Validated against the requirement’s kind: URL, text length, date `YYYY-MM-DD`, or one of its options') },
    example: { documentType: 'WEBSITE', value: 'https://kigalifresh.example' },
  },
  'POST /organizations/{id}/finalize': {
    summary: 'Finish onboarding: save as draft, submit for review, or approve',
    required: ['outcome'],
    properties: { outcome: { type: 'string', enum: ['SAVE_DRAFT', 'SUBMIT', 'APPROVE'], description: '`APPROVE` also needs `verification.approve`. SUBMIT and APPROVE are refused with `VERIFICATION_INCOMPLETE` while required details or documents are missing.' }, note: str('Recorded in the review history when approving', { maxLength: 1000 }) },
    example: { outcome: 'APPROVE', note: 'Verified in person' },
  },
  'POST /organizations/{id}/senders': {
    summary: 'Create a sender ID on the organization’s behalf',
    required: ['name', 'purpose', 'reason'],
    properties: { name: str('3–11 characters: letters, digits, space, `.` `-` `&`'), purpose: str(), sampleMessage: str(), useCase: str(), approveNow: { type: 'boolean', default: false, description: 'Also approve it now. Needs `senders.approve`.' }, reason: str('**Required.** Recorded in the organization’s audit log (min 5 characters)') },
    example: { name: 'KIGALIFRSH', purpose: 'Order and delivery notifications', approveNow: true, reason: 'Customer requested by phone; registration checked' },
  },
  'POST /organizations/{id}/senders/{senderId}/withdraw': {
    summary: 'Withdraw an unused sender ID',
    required: ['reason'],
    properties: { reason: str('**Required.** Recorded in the audit log') },
    example: { reason: 'Created by mistake' },
  },
  'PATCH /organizations/{id}/members/{memberId}': {
    summary: 'Change a team member’s role or disable/enable them',
    required: ['reason'],
    properties: { roleId: str('A role id from `GET /admin/organizations/{id}/roles` (never Owner)', { format: 'uuid' }), status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] }, reason: str('**Required.** Recorded with the before and after values') },
    example: { status: 'DISABLED', reason: 'Employee left the company' },
  },
  'POST /organizations/{id}/members/{memberId}/remove': {
    summary: 'Remove a team member’s access',
    required: ['reason'],
    properties: { reason: str('**Required.** Recorded in the audit log') },
    example: { reason: 'Access requested by the organization owner' },
  },
  'POST /organizations/{id}/members': {
    summary: 'Give a person access to an organization',
    required: ['person', 'roleId'],
    properties: { person, roleId: str('A role id from `GET /admin/organizations/{id}/roles` (never Owner)', { format: 'uuid' }) },
    example: { person: { fullName: 'Jean Mugabo', email: 'jean@kigalifresh.example' }, roleId: '00000000-0000-0000-0000-000000000000' },
  },
  'PUT /organizations/{id}/api-access': {
    summary: 'Switch an organization’s API access on or off and cap its scopes',
    required: ['enabled', 'allowedScopes'],
    properties: { enabled: { type: 'boolean' }, allowedScopes: { type: ['array', 'null'], items: { enum: ['sms.send', 'sms.read', 'balance.read'] }, description: 'null = all organization scopes' } },
    example: { enabled: true, allowedScopes: ['sms.read', 'balance.read'] },
  },
  'POST /organizations/{id}/status': {
    summary: 'Suspend or reactivate an organization',
    required: ['action'],
    properties: { action: { type: 'string', enum: ['suspend', 'reactivate'] }, reason: str('Required when suspending; shown to the customer', { maxLength: 500 }) },
    example: { action: 'suspend', reason: 'Non-payment flagged by finance' },
  },
  'POST /verifications/{id}/decision': {
    summary: 'Decide a whole business verification',
    required: ['decision'],
    properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'REQUEST_INFORMATION'] }, note: str('Required for REJECT and REQUEST_INFORMATION', { maxLength: 2000 }) },
    example: { decision: 'REQUEST_INFORMATION', note: 'Please upload a clearer ID' },
  },
  'POST /verifications/documents/{id}/review': {
    summary: 'Review one verification document',
    required: ['decision'],
    properties: { decision: { type: 'string', enum: ['APPROVED', 'REJECTED', 'REPLACEMENT_REQUESTED'] }, note: str('Required unless approving', { maxLength: 1000 }) },
    example: { decision: 'REJECTED', note: 'Certificate is expired' },
  },
  'POST /senders/{id}/{action}': {
    summary: 'Review, approve, reject, suspend or reactivate a sender ID',
    required: [],
    properties: { note: str('Required when rejecting or requesting information', { maxLength: 1000 }) },
    example: { note: 'Approved after checking the registration' },
  },
  'POST /billing/wallets/{organizationId}/adjust': {
    summary: 'Adjust an organization’s SMS credit balance',
    required: ['kind', 'amount', 'reason', 'reference'],
    properties: { kind: { type: 'string', enum: ['CREDIT', 'DEBIT', 'REFUND'] }, amount: { type: 'integer', minimum: 1, description: 'Credits' }, reason: str('At least 5 characters'), reference: str('Unique reference; repeating it is rejected as a duplicate') },
    example: { kind: 'CREDIT', amount: 500, reason: 'Goodwill credit for outage', reference: 'finance/2026/0042' },
  },
};

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: { requiredPermissions?: string[] } }[] } };

const titleCase = (s: string) => s.replace(/[-/]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** Express path (`/:id/:action(enable|disable)`) → OpenAPI path plus its parameters. */
function toOpenApiPath(path: string) {
  const params: unknown[] = [];
  const out = path.replace(/:(\w+)(?:\(([^)]*)\))?/g, (_m, name: string, choices?: string) => {
    params.push({ name, in: 'path', required: true, schema: choices ? { type: 'string', enum: choices.split('|') } : { type: 'string' } });
    return `{${name}}`;
  });
  return { path: out === '/' ? '' : out, params };
}

function bodyFor(key: string) {
  const b = BODIES[key];
  if (!b) return { requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } };
  return { requestBody: { required: b.required.length > 0, content: { [b.contentType ?? 'application/json']: { schema: { type: 'object', required: b.required, properties: b.properties }, ...(b.example ? { example: b.example } : {}) } } } };
}

export function adminPaths() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [mount, router] of adminMounts as [string, Router][]) {
    if (HIDDEN.has(mount)) continue;
    for (const layer of (router as unknown as { stack: Layer[] }).stack) {
      if (!layer.route || typeof layer.route.path !== 'string') continue;
      const { path, params } = toOpenApiPath(layer.route.path);
      const full = `/admin${mount}${path}`;
      for (const method of Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m])) {
        const key = `${method.toUpperCase()} ${mount}${path}`;
        const inline = INLINE[key];
        const required = layer.route.stack.flatMap((h) => h.handle.requiredPermissions ?? []);
        const human = HUMAN_ONLY.has(mount);
        const scheme = human ? 'StaffSession' : 'IntegrationKey';
        const security = inline ? inline.anyOf.map((p) => ({ [scheme]: [p] })) : required.length ? [{ [scheme]: required }] : [{ [scheme]: [] }];
        const get = method === 'get';
        (paths[full] ??= {})[method] = {
          tags: [human ? 'Credential management (staff only)' : `Admin — ${titleCase(mount)}`],
          summary: BODIES[key]?.summary ?? `${method.toUpperCase()} /admin${mount}${path}`,
          description: [
            required.length ? `Requires permission${required.length > 1 ? 's' : ''}: ${required.map((r) => `\`${r}\``).join(', ')}.` : inline ? inline.note : 'Requires platform staff access; the permission is checked for the specific action.',
            human ? '**Staff session only** — a credential can never call this endpoint, so a leaked key cannot create or change keys.' : 'Also usable with a staff session (`Authorization: Bearer <jwt>`).',
            !human && method !== 'get' ? 'Send an `Idempotency-Key` header to make retries safe: the original response is replayed instead of repeating the action.' : '',
            get ? 'List endpoints accept `page` and `limit` query parameters, plus filters specific to the resource.' : 'Send a JSON body; invalid input returns `422 VALIDATION_ERROR` with a field list.',
          ].filter(Boolean).join('\n\n'),
          security,
          parameters: [...params, ...(!human && method !== 'get' ? [{ $ref: '#/components/parameters/IdempotencyKey' }] : [])],
          ...(get ? {} : bodyFor(key)),
          responses: {
            200: { description: 'Success — `{ "success": true, "data": … }`', ...(BODIES[key]?.response ? { content: { 'application/json': { schema: BODIES[key].response } } } : {}) },
            401: { description: 'Missing, invalid, revoked or expired credential', content: { 'application/json': { schema: ref('Error') } } },
            403: { description: 'The credential lacks the required permission (`PERMISSION_DENIED`), is disabled, or the IP is not allowed', content: { 'application/json': { schema: ref('Error') } } },
            404: { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
          },
        };
      }
    }
  }
  return paths;
}

/** Hand-written bodies whose route no longer exists (used by tests so the docs cannot drift). */
export function orphanedBodies(): string[] {
  const keys = new Set<string>();
  for (const [full, ops] of Object.entries(adminPaths())) for (const method of Object.keys(ops)) keys.add(`${method.toUpperCase()} ${full.replace(/^\/admin/, '')}`);
  return Object.keys(BODIES).filter((k) => !keys.has(k));
}

/** Permission keys referenced by the documented admin operations (used by tests). */
export function documentedAdminPermissions(): string[] {
  const out = new Set<string>();
  for (const ops of Object.values(adminPaths())) for (const op of Object.values(ops as Record<string, { security: Record<string, string[]>[] }>)) for (const sec of op.security) for (const scopes of Object.values(sec)) scopes.forEach((s) => out.add(s));
  return [...out];
}
