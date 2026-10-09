import { del, get, patch, post, put } from '@/api/client';
import type { AllocationOverview, EligibleSender, SenderAllocation, SenderId, SenderNetworkRow } from '@/api/types';

export const senderService = {
  list: () => get<SenderId[]>('/senders'),
  request: (body: { name: string; purpose: string; sampleMessage?: string; useCase?: string; networkIds?: string[] }) => post<SenderId>('/senders', body),
  update: (id: string, body: Partial<{ name: string; purpose: string; sampleMessage: string; useCase: string; networkIds: string[] }>) => patch<SenderId>(`/senders/${id}`, body),
  resubmit: (id: string) => post<SenderId>(`/senders/${id}/submit`),
  withdraw: (id: string) => del(`/senders/${id}`),
  allocations: () => get<AllocationOverview>('/senders/allocations'),
  setAllocation: (id: string, body: { allocated: number; alertThresholds?: number[] }) => put<SenderAllocation>(`/senders/${id}/allocation`, body),
  removeAllocation: (id: string) => del(`/senders/${id}/allocation`),
  /** Approved sender IDs with their compatibility on each given network. */
  eligible: (networkIds: string[]) => get<EligibleSender[]>('/senders/eligible', { networkIds: networkIds.join(',') }),
  networks: (id: string) => get<SenderNetworkRow[]>(`/senders/${id}/networks`),
  requestNetworks: (id: string, networkIds: string[]) => post<SenderNetworkRow[]>(`/senders/${id}/networks`, { networkIds }),
};
