import { get, getPage, post } from '@/api/client';
import type { Notification } from '@/api/types';

export const notificationService = {
  list: (params: { page: number; limit?: number; unread?: boolean }) =>
    getPage<Notification>('/notifications', { ...params, unread: params.unread ? 'true' : undefined }),
  unreadCount: () => get<{ count: number }>('/notifications/unread-count'),
  markRead: (id: string) => post(`/notifications/${id}/read`),
  markAllRead: () => post('/notifications/read-all'),
};
