import { get, getPage } from '@/api/client';
import type { AuditLog, SeriesPoint, SmsTotals } from '@/api/types';

export type RangeKey = 'today' | 'yesterday' | 'week' | '7d' | '30d' | 'month' | 'lastMonth' | 'year' | 'all' | 'custom';

export interface OverviewReport {
  range: { from: string; to: string; unit: 'hour' | 'day' | 'month'; timezone: string };
  totals: SmsTotals & { creditsConsumed: number; campaigns: number };
  bySource: { source: string; messages: number }[];
  series: SeriesPoint[];
  billing: { creditsPurchased: number; creditsUsed: number; remainingBalance: number; totalSpending: string; currency: string };
  spendingSeries: { label: string; amount: string }[];
  campaignPerformance: { id: string; name: string; status: string; recipients: number; delivered: number; failed: number; pending: number }[];
}

export const reportService = {
  overview: (params: { range: RangeKey; from?: string; to?: string }) => get<OverviewReport>('/reports/overview', params),
  dashboard: () =>
    get<{ balance: number; lowBalanceThreshold: number; today: SmsTotals; month: SmsTotals; last7Days: SeriesPoint[] }>('/reports/dashboard'),
  auditLogs: (params: { page: number; limit?: number; action?: string }) => getPage<AuditLog>('/audit-logs', params),
};
