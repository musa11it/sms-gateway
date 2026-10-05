import { del, get, patch, post } from '@/api/client';
import type { SenderId } from '@/api/types';

export const senderService = {
  list: () => get<SenderId[]>('/senders'),
  request: (body: { name: string; purpose: string; sampleMessage?: string; useCase?: string }) => post<SenderId>('/senders', body),
  update: (id: string, body: Partial<{ name: string; purpose: string; sampleMessage: string; useCase: string }>) => patch<SenderId>(`/senders/${id}`, body),
  resubmit: (id: string) => post<SenderId>(`/senders/${id}/submit`),
  withdraw: (id: string) => del(`/senders/${id}`),
};
