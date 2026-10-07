import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { notificationService } from '@/services/notificationService';
import { cn, fmtRelative } from '@/utils/format';
import { Dropdown } from '../ui/Misc';

export function NotificationBell({ allLink }: { allLink: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: count } = useQuery({ queryKey: ['notifications', 'count'], queryFn: notificationService.unreadCount, refetchInterval: 20_000 });
  const { data: list, refetch } = useQuery({ queryKey: ['notifications', 'recent'], queryFn: () => notificationService.list({ page: 1, limit: 8 }), enabled: false });
  const unread = count?.count ?? 0;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <Dropdown
      className="w-[360px] p-0"
      trigger={
        <button onClick={() => void refetch()} className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800" aria-label="Notifications">
          <Bell className="h-[18px] w-[18px]" />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-bold text-white ring-2 ring-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      }
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">Notifications</p>
            {unread > 0 && (
              <button
                className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
                onClick={async () => {
                  await notificationService.markAllRead();
                  refresh();
                  void refetch();
                }}
              >
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            )}
          </div>
          <div className="scrollbar-thin max-h-[380px] overflow-y-auto">
            {!list ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">Loading…</p>
            ) : list.data.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-slate-400">You’re all caught up ✨</p>
            ) : (
              list.data.map((n) => (
                <button
                  key={n.id}
                  onClick={async () => {
                    if (!n.readAt) await notificationService.markRead(n.id);
                    refresh();
                    close();
                    if (n.link) navigate(n.link);
                  }}
                  className={cn('flex w-full gap-3 border-b border-slate-50 px-4 py-3 text-left transition hover:bg-slate-50', !n.readAt && 'bg-brand-50/40')}
                >
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand-500')} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-900">{n.title}</span>
                    {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-slate-500">{n.body}</span>}
                    <span className="mt-1 block text-xs text-slate-400">{fmtRelative(n.createdAt)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
          <button
            onClick={() => {
              close();
              navigate(allLink);
            }}
            className="w-full rounded-b-xl px-4 py-2.5 text-center text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            View all notifications
          </button>
        </div>
      )}
    </Dropdown>
  );
}
