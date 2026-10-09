import { get, getPage, post } from '@/api/client';
import type { MessageEstimate, Quote, SmsBatch, SmsRecipient } from '@/api/types';

export interface SendPayload {
  senderId: string;
  message: string;
  recipients?: string[];
  contactIds?: string[];
  groupIds?: string[];
  scheduledAt?: string | null;
  timezone?: string;
  idempotencyKey?: string;
  /** Destination networks to send to (recipients on other networks are refused). */
  networkIds?: string[];
}

export const smsService = {
  /** Server-side encoding/segment analysis of a message (preview only). */
  estimate: (message: string) => post<MessageEstimate>('/sms/estimate', { message }),
  quote: (body: { message: string; recipients?: string[]; contactIds?: string[]; groupIds?: string[]; networkIds?: string[]; senderId?: string }) => post<Quote>('/sms/quote', body),
  send: (body: SendPayload) =>
    post<{ id: string; status: string; recipientCount: number; segments: number; totalCredits: number; skipped: { invalid: number; duplicates: number; optedOut: number } }>(
      '/sms/send',
      body,
    ),
  batches: (params: { page: number; limit?: number; status?: string; source?: string }) => getPage<SmsBatch>('/sms', params),
  batch: (id: string) => get<SmsBatch>(`/sms/${id}`),
  scheduled: () => get<SmsBatch[]>('/sms/scheduled'),
  history: (params: { page: number; limit?: number; status?: string; search?: string; batchId?: string; source?: string; from?: string; to?: string }) =>
    getPage<SmsRecipient>('/sms/messages', params),
  message: (id: string) => get<SmsRecipient>(`/sms/messages/${id}`),
  cancel: (id: string) => post(`/sms/${id}/cancel`),
};
