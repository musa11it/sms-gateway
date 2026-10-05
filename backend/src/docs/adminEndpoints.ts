import type { Router } from 'express';
import { adminMounts } from '../routes';

/**
 * Builds the OpenAPI paths for the platform administration API by reading the real routers, so
 * the documentation can never list an endpoint that does not exist or miss one that does.
 * Permissions come from `requirePlatformPermission`; routes that check inline are listed in INLINE.
 */

/** Mounts a credential can never use (humans only). */
const HIDDEN = new Set(['/integrations']);

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
        const security = inline ? inline.anyOf.map((p) => ({ IntegrationKey: [p] })) : required.length ? [{ IntegrationKey: required }] : [{ IntegrationKey: [] }];
        const get = method === 'get';
        (paths[full] ??= {})[method] = {
          tags: [`Admin — ${titleCase(mount)}`],
          summary: `${method.toUpperCase()} /admin${mount}${path}`,
          description: [
            required.length ? `Requires permission${required.length > 1 ? 's' : ''}: ${required.map((r) => `\`${r}\``).join(', ')}.` : inline ? inline.note : 'Requires platform staff access; the permission is checked for the specific action.',
            'Also usable with a staff session (`Authorization: Bearer <jwt>`).',
            get ? 'List endpoints accept `page` and `limit` query parameters, plus filters specific to the resource.' : 'Send a JSON body; invalid input returns `422 VALIDATION_ERROR` with a field list.',
          ].join('\n\n'),
          security,
          parameters: params,
          ...(get ? {} : { requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } }),
          responses: {
            200: { description: 'Success — `{ "success": true, "data": … }`' },
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

/** Permission keys referenced by the documented admin operations (used by tests). */
export function documentedAdminPermissions(): string[] {
  const out = new Set<string>();
  for (const ops of Object.values(adminPaths())) for (const op of Object.values(ops as Record<string, { security: Record<string, string[]>[] }>)) for (const sec of op.security) for (const scopes of Object.values(sec)) scopes.forEach((s) => out.add(s));
  return [...out];
}
