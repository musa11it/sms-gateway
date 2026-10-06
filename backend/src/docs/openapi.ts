import { SCOPES } from '../modules/integrations/scopes';
import { adminPaths } from './adminEndpoints';

/**
 * OpenAPI 3.1 description of the API that external systems can call. Dashboard and admin
 * endpoints (browser sessions) are intentionally not listed. Scope descriptions come from the
 * same registry the admin screens use, so documentation and access control cannot drift apart.
 */
const scopeLine = (level: 'ORGANIZATION' | 'PLATFORM') =>
  SCOPES.filter((s) => s.level === level)
    .map((s) => `- \`${s.key}\` — ${s.description}`)
    .join('\n');

const platformPermissionGroups = () => {
  const groups = new Map<string, string[]>();
  for (const s of SCOPES.filter((x) => x.level === 'PLATFORM')) groups.set(s.group, [...(groups.get(s.group) ?? []), `\`${s.key}\``]);
  return [...groups].map(([g, keys]) => `- **${g}:** ${keys.join(', ')}`).join('\n');
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: ref('Error') } } });
const json = (schema: unknown, example?: unknown) => ({ 'application/json': { schema, ...(example ? { example } : {}) } });
const idParam = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: { type: 'string', format: 'uuid' } });
const pagingParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
];
const common = {
  400: errorResponse('Malformed request'),
  401: errorResponse('Missing, invalid, revoked or expired credential'),
  403: errorResponse('Credential lacks the required scope, is disabled, or the request comes from an IP address that is not allowed'),
  429: errorResponse('Rate limit exceeded — slow down and retry'),
};

export function buildOpenApi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'SMS Gateway API',
      version: '1.0.0',
      description: [
        'Programmatic access to the SMS Gateway. Every request is authenticated with a credential, and every credential is controlled by the platform:',
        '',
        '**Organization level** — an organization creates API keys (`sgw_live_…`) in its dashboard to send SMS and read its own messages and balance. The platform can switch an organization’s API access off, or limit which scopes it may use, at any time.',
        '',
        '**Platform level** — trusted external systems (for example the finance system) receive an integration credential (`sgw_int_…`) from a platform Super Admin. Each credential has explicit scopes, an optional IP allow-list and expiry, and can be disabled or revoked instantly. Request one from the platform team.',
        '',
        '### Scopes',
        '**Organization scopes**',
        scopeLine('ORGANIZATION'),
        '',
        '**Platform scopes** — the finance endpoints below use `verification.view` and `verification.review`.',
        '',
        '### Platform administration API',
        'A platform credential can also call **any** `/api/v1/admin/...` endpoint — the same API the admin dashboard uses — as long as it holds the permission that endpoint needs. Send `Authorization: Bearer sgw_int_…`. Requests without the right permission receive `403 PERMISSION_DENIED`. Permissions that move money or change access (marked high-risk in the admin screen) can only be given to credentials that are locked to specific IP addresses and have an expiry date. Credentials can never manage other credentials.',
        '',
        'Permissions a credential may hold, by area:',
        platformPermissionGroups(),
        '',
        '### Responses',
        'Successful responses use `{ "success": true, "data": … }`. Errors use `{ "success": false, "message": "…", "code": "…" }` and validation errors add an `errors` array.',
        '',
        '### Request IDs',
        'Every response carries an `X-Request-Id` header, and every error body a `requestId`. You may send your own `X-Request-Id` (8–64 characters) to correlate calls end to end.',
        '',
        '### Idempotency',
        'Send an `Idempotency-Key` header on writes. A retry with the same key and the same request returns the original response instead of repeating the action; the same key with a different request is rejected.',
        '',
        '### Rate limits',
        'Requests are limited per source IP (before authentication) and per credential. When exceeded you receive `429` with `RateLimit` headers describing the window.',
        '',
        '### Errors and authentication',
        'Authentication failures return a generic `401` and never reveal whether a key prefix exists. Keys must be sent in the `Authorization` header over HTTPS — never in a URL.',
      ].join('\n'),
    },
    servers: [{ url: '/api/v1', description: 'This server' }],
    tags: [
      { name: 'Platform administration', description: 'Every `/admin` area below can be called with a platform credential that holds the listed permission. Credential management itself (`/admin/integrations`) is human-only and not listed.' },
      { name: 'Organization API', description: 'Authenticated with an organization API key (`sgw_live_…`).' },
      { name: 'Platform API — Finance', description: 'Authenticated with a platform integration credential (`sgw_int_…`). Only verifications awaiting review are visible.' },
      { name: 'Health', description: 'Unauthenticated status checks for monitors and load balancers (served at the server root, outside `/api/v1`).' },
    ],
    components: {
      parameters: {
        IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, description: '8–100 characters `[A-Za-z0-9_-]`. Repeating the same request with the same key replays the original response (`Idempotent-Replay: true`); the same key with a different request returns `422 IDEMPOTENCY_KEY_REUSED`.', schema: { type: 'string' } },
      },
      securitySchemes: {
        StaffSession: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A signed-in platform staff member (dashboard session). Used for credential management, which credentials can never perform.' },
        OrganizationApiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Organization API key, `Authorization: Bearer sgw_live_<prefix>_<secret>`. The `X-API-Key` header is also accepted. Create keys in the dashboard under Developer → API keys.',
        },
        IntegrationKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Platform integration credential, `Authorization: Bearer sgw_int_<prefix>_<secret>`. Issued by a platform Super Admin; shown once at creation.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['success', 'message', 'code'],
          properties: {
            success: { const: false },
            message: { type: 'string' },
            code: { type: 'string', examples: ['SCOPE_MISSING', 'INVALID_API_KEY', 'VALIDATION_ERROR'] },
            requestId: { type: 'string', description: 'Quote this when contacting support. Also returned in the `X-Request-Id` header.' },
            errors: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
          },
        },
        SendSms: {
          type: 'object',
          required: ['senderId', 'message'],
          description: 'Provide `senderId` (or `sender`) and exactly one of `to`, `recipient` or `recipients`.',
          properties: {
            senderId: { type: 'string', maxLength: 11, description: 'Your approved sender name.', examples: ['ABCFOOD'] },
            to: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1000 }], description: 'One number, or a list of up to 1000.', examples: ['+250788123456'] },
            message: { type: 'string', minLength: 1, maxLength: 1600 },
            reference: { type: 'string', maxLength: 100, description: 'Your own reference, echoed back.' },
            scheduledAt: { type: 'string', format: 'date-time', description: 'Send later instead of immediately.' },
          },
        },
        MessageRecipient: {
          type: 'object',
          properties: {
            messageId: { type: 'string', format: 'uuid' },
            to: { type: 'string' },
            status: { type: 'string', examples: ['QUEUED', 'SENT', 'DELIVERED', 'FAILED'] },
            credits: { type: 'integer' },
            error: { type: ['object', 'null'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
            createdAt: { type: 'string', format: 'date-time' },
            sentAt: { type: ['string', 'null'], format: 'date-time' },
            deliveredAt: { type: ['string', 'null'], format: 'date-time' },
            failedAt: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        VerificationSummary: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['SUBMITTED', 'UNDER_REVIEW'] },
            submittedAt: { type: ['string', 'null'], format: 'date-time' },
            organization: {
              type: 'object',
              properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, businessType: { type: ['string', 'null'] }, country: { type: ['string', 'null'] }, city: { type: ['string', 'null'] }, address: { type: ['string', 'null'] }, registrationNumber: { type: ['string', 'null'] }, taxId: { type: ['string', 'null'] }, website: { type: ['string', 'null'] } },
            },
          },
        },
        VerificationDocument: {
          type: 'object',
          description: 'A file (`mimeType`/`sizeBytes` set, download it) or a plain answer (`value` set: a link, text, date or choice).',
          properties: {
            id: { type: 'string', format: 'uuid' },
            documentType: { type: 'string', examples: ['BUSINESS_REGISTRATION'] },
            originalName: { type: 'string' },
            value: { type: ['string', 'null'] },
            mimeType: { type: ['string', 'null'] },
            sizeBytes: { type: ['integer', 'null'] },
            status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'REPLACEMENT_REQUESTED'] },
            reviewNote: { type: ['string', 'null'] },
            createdAt: { type: 'string', format: 'date-time' },
            reviewedAt: { type: ['string', 'null'], format: 'date-time' },
          },
        },
      },
    },
    paths: {
      ...adminPaths(),
      '/public/sms/send': {
        post: {
          tags: ['Organization API'],
          summary: 'Send an SMS',
          description: 'Sends to one or many recipients. Credits are charged from the organization’s wallet. Send an `Idempotency-Key` header to make retries safe.',
          security: [{ OrganizationApiKey: ['sms.send'] }],
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, description: '8–100 characters `[A-Za-z0-9_-]`. Repeating a request with the same key returns the original result.', schema: { type: 'string' } }],
          requestBody: { required: true, content: json(ref('SendSms'), { senderId: 'ABCFOOD', to: ['+250788123456'], message: 'Your order is ready', reference: 'order-1042' }) },
          responses: {
            201: { description: 'Accepted for delivery', content: json({ type: 'object', properties: { success: { const: true }, messageId: { type: 'string', format: 'uuid', description: 'Present when there is a single recipient.' }, data: { type: 'object', properties: { batchId: { type: 'string', format: 'uuid' }, status: { type: 'string' }, segments: { type: 'integer' }, encoding: { type: 'string' }, recipientCount: { type: 'integer' }, totalCredits: { type: 'integer' }, reference: { type: ['string', 'null'] }, scheduledAt: { type: ['string', 'null'], format: 'date-time' }, messages: { type: 'array', items: ref('MessageRecipient') } } } } }) },
            200: { description: 'Duplicate request (same `Idempotency-Key`) — the original result is returned' },
            402: errorResponse('Not enough credits (`INSUFFICIENT_CREDITS`)'),
            422: errorResponse('Validation failed, or the sender name is not approved'),
            ...common,
          },
        },
      },
      '/public/sms/{messageId}': {
        get: {
          tags: ['Organization API'],
          summary: 'Get a message’s delivery status',
          security: [{ OrganizationApiKey: ['sms.read'] }],
          parameters: [idParam('messageId', 'The `messageId` returned when sending.')],
          responses: { 200: { description: 'Message status', content: json({ type: 'object', properties: { success: { const: true }, data: ref('MessageRecipient') } }) }, 404: errorResponse('No such message in your organization'), ...common },
        },
      },
      '/public/balance': {
        get: {
          tags: ['Organization API'],
          summary: 'Get the SMS credit balance',
          security: [{ OrganizationApiKey: ['balance.read'] }],
          responses: { 200: { description: 'Current balance', content: json({ type: 'object', properties: { success: { const: true }, data: { type: 'object', properties: { balance: { type: 'integer' }, unit: { const: 'credits' } } } } }, { success: true, data: { balance: 1250, unit: 'credits' } }) }, ...common },
        },
      },
      '/integrations/finance/verifications': {
        get: {
          tags: ['Platform API — Finance'],
          summary: 'List verifications awaiting review',
          description: 'Only verifications that are `SUBMITTED` or `UNDER_REVIEW`. Decided verifications are never returned.',
          security: [{ IntegrationKey: ['verification.view'] }],
          parameters: [...pagingParams, { name: 'status', in: 'query', schema: { type: 'string', enum: ['SUBMITTED', 'UNDER_REVIEW'] } }],
          responses: { 200: { description: 'A page of verifications', content: json({ type: 'object', properties: { success: { const: true }, data: { type: 'array', items: ref('VerificationSummary') }, pagination: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } } } } }) }, ...common },
        },
      },
      '/integrations/finance/verifications/{id}': {
        get: {
          tags: ['Platform API — Finance'],
          summary: 'Get one verification with its documents',
          description: 'Includes the list of items the business was asked to provide. Account-owner personal details are never exposed. Each read is audit-logged.',
          security: [{ IntegrationKey: ['verification.view'] }],
          parameters: [idParam('id', 'Verification id')],
          responses: { 200: { description: 'The verification', content: json({ type: 'object', properties: { success: { const: true }, data: { allOf: [ref('VerificationSummary'), { type: 'object', properties: { documents: { type: 'array', items: ref('VerificationDocument') }, requirements: { type: 'array', items: { type: 'object', additionalProperties: true } } } }] } } }) }, 404: errorResponse('Not found, or already decided'), ...common },
        },
      },
      '/integrations/finance/documents/{id}/download': {
        get: {
          tags: ['Platform API — Finance'],
          summary: 'Download a document file',
          description: 'Returns the file as an attachment (PDF, PNG or JPEG). Only for documents of verifications awaiting review. Each download is audit-logged.',
          security: [{ IntegrationKey: ['verification.view'] }],
          parameters: [idParam('id', 'Document id')],
          responses: { 200: { description: 'The file', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } }, 'image/png': { schema: { type: 'string', format: 'binary' } }, 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } }, 404: errorResponse('Not found, not a file, or already decided'), ...common },
        },
      },
      '/integrations/finance/documents/{id}/review': {
        post: {
          tags: ['Platform API — Finance'],
          summary: 'Review a document',
          description: 'Approve, reject or request replacement of a single document. A `note` is required unless approving. This does **not** approve the business — platform staff make the final decision.',
          security: [{ IntegrationKey: ['verification.review'] }],
          parameters: [idParam('id', 'Document id'), { $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: json({ type: 'object', required: ['decision'], properties: { decision: { type: 'string', enum: ['APPROVED', 'REJECTED', 'REPLACEMENT_REQUESTED'] }, note: { type: 'string', maxLength: 1000 } } }, { decision: 'REJECTED', note: 'Certificate is expired' }) },
          responses: { 200: { description: 'Updated document status', content: json({ type: 'object', properties: { success: { const: true }, data: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, reviewNote: { type: ['string', 'null'] }, reviewedAt: { type: 'string', format: 'date-time' } } } } }) }, 404: errorResponse('Not found, or its verification is already decided'), 422: errorResponse('A note is required for this decision'), ...common },
        },
      },
      '/health/live': {
        get: { tags: ['Health'], summary: 'Liveness', description: 'Served at `/health/live` (server root). Always 200 while the process runs.', servers: [{ url: '/' }], security: [], responses: { 200: { description: 'Process is running' } } },
      },
      '/health/ready': {
        get: { tags: ['Health'], summary: 'Readiness', description: 'Served at `/health/ready` (server root). 200 when the database and storage are reachable, 503 otherwise.', servers: [{ url: '/' }], security: [], responses: { 200: { description: 'Ready' }, 503: { description: 'A dependency is down' } } },
      },
    },
  };
}
