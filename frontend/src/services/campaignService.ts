import { del, get, getPage, patch, post } from '@/api/client';
import type { Campaign } from '@/api/types';

export interface CampaignInput {
  name: string;
  senderId: string;
  message: string;
  groupIds?: string[];
  contactIds?: string[];
  phones?: string[];
}

export const campaignService = {
  list: (params: { page: number; limit?: number; status?: string; search?: string }) => getPage<Campaign>('/campaigns', params),
  get: (id: string) => get<Campaign>(`/campaigns/${id}`),
  create: (body: CampaignInput) => post<Campaign>('/campaigns', body),
  update: (id: string, body: Partial<CampaignInput>) => patch<Campaign>(`/campaigns/${id}`, body),
  remove: (id: string) => del(`/campaigns/${id}`),
  launch: (id: string, scheduledAt?: string | null) =>
    post<{ messageId: string; status: string; recipients: number; totalCredits: number }>(`/campaigns/${id}/launch`, { scheduledAt: scheduledAt ?? null }),
  cancel: (id: string) => post<Campaign>(`/campaigns/${id}/cancel`),
  duplicate: (id: string) => post<Campaign>(`/campaigns/${id}/duplicate`),
};
