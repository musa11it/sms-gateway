import { del, get, getPage, patch, post } from '@/api/client';
import type { ApiKey, Webhook, WebhookDelivery } from '@/api/types';

export interface ApiLog {
  id: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ipAddress: string | null;
  errorCode: string | null;
  requestId: string | null;
  createdAt: string;
  apiKey: { name: string; prefix: string } | null;
}

export const developerService = {
  apiKeys: () => get<ApiKey[]>('/developer/api-keys'),
  createApiKey: (body: { name: string; scopes?: string[]; allowedIps?: string[]; expiresAt?: string | null; environment?: string; rateLimitPerMinute?: number | null }) =>
    post<{ apiKey: ApiKey; secret: string }>('/developer/api-keys', body),
  revokeApiKey: (id: string) => post(`/developer/api-keys/${id}/revoke`),
  setApiKeyEnabled: (id: string, enabled: boolean) => post(`/developer/api-keys/${id}/${enabled ? 'enable' : 'disable'}`),
  regenerateApiKey: (id: string) => post<{ apiKey: ApiKey; secret: string }>(`/developer/api-keys/${id}/regenerate`),
  logs: (params: { page: number; limit?: number; apiKeyId?: string; status?: string; path?: string; requestId?: string; from?: string; to?: string }) =>
    getPage<ApiLog>('/developer/api-logs', params),
  usage: () =>
    get<{ last24h: { requests: number; errors: number }; smsViaApi14d: number; daily: { date: string; requests: number; errors: number }[] }>('/developer/api-logs/usage'),
  webhookEvents: () => get<string[]>('/developer/webhooks/events'),
  webhooks: () => get<Webhook[]>('/developer/webhooks'),
  createWebhook: (body: { url: string; description?: string; events: string[] }) => post<{ webhook: Webhook; secret: string }>('/developer/webhooks', body),
  updateWebhook: (id: string, body: Partial<{ url: string; description: string; events: string[]; isActive: boolean }>) => patch<Webhook>(`/developer/webhooks/${id}`, body),
  deleteWebhook: (id: string) => del(`/developer/webhooks/${id}`),
  rotateSecret: (id: string) => post<{ secret: string }>(`/developer/webhooks/${id}/rotate-secret`),
  testWebhook: (id: string) => post(`/developer/webhooks/${id}/test`),
  deliveries: (id: string, params: { page: number; limit?: number }) => getPage<WebhookDelivery>(`/developer/webhooks/${id}/deliveries`, params),
  redeliver: (deliveryId: string) => post(`/developer/webhooks/deliveries/${deliveryId}/redeliver`),
};
