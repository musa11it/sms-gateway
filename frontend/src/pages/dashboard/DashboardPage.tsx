import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Circle, Coins, Contact, Gauge, Megaphone, Send, ShoppingCart, TrendingUp, Wallet } from 'lucide-react';
import { SmsTrendChart, StatusDonut } from '@/components/charts/Charts';
import { StatusBadge } from '@/components/ui/Badge';
import { LinkButton } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { EmptyState, Skeleton } from '@/components/ui/Feedback';
import { ProgressBar } from '@/components/ui/Misc';
import { useMe, usePermissions } from '@/hooks/useAuth';
import { campaignService } from '@/services/campaignService';
import { contactService } from '@/services/contactService';
import { reportService } from '@/services/reportService';
import { senderService } from '@/services/senderService';
import { smsService } from '@/services/smsService';
import { walletService } from '@/services/walletService';
import { cn, fmtNumber, fmtRelative, greeting } from '@/utils/format';

function GettingStarted() {
  const { can } = usePermissions();
  const senders = useQuery({ queryKey: ['senders'], queryFn: senderService.list, enabled: can('senders.view') });
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: walletService.wallet, enabled: can('wallet.view') });
  const contacts = useQuery({ queryKey: ['contacts', 'count'], queryFn: () => contactService.list({ page: 1, limit: 1 }), enabled: can('contacts.view') });
  const sent = useQuery({ queryKey: ['sms', 'batches', 'count'], queryFn: () => smsService.batches({ page: 1, limit: 1 }), enabled: can('sms.view') });
  if (senders.isLoading || wallet.isLoading || contacts.isLoading || sent.isLoading) return null;
  const steps = [
    { done: true, title: 'Verify your business', desc: 'Your organization is approved', to: '/app/organization' },
    { done: !!senders.data?.some((s) => s.status === 'APPROVED'), title: 'Get a sender ID approved', desc: 'Your brand name shown to recipients', to: '/app/senders' },
    { done: (wallet.data?.balance ?? 0) > 0, title: 'Buy SMS credits', desc: 'Prepaid credits, charged per segment', to: '/app/wallet/buy' },
    { done: (contacts.data?.pagination.total ?? 0) > 0, title: 'Add contacts', desc: 'Create or import from CSV', to: '/app/contacts' },
    { done: (sent.data?.pagination.total ?? 0) > 0, title: 'Send your first SMS', desc: 'Watch it get delivered in real time', to: '/app/sms/send' },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-col gap-4 border-b border-slate-100 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-base font-semibold text-slate-900">Get set up to send</p>
          <p className="text-sm text-slate-500">
            {done} of {steps.length} steps complete
          </p>
        </div>
        <div className="w-full sm:w-48">
          <ProgressBar value={(done / steps.length) * 100} tone="emerald" />
        </div>
      </div>
      <div className="grid divide-y divide-slate-100 sm:grid-cols-5 sm:divide-x sm:divide-y-0">
        {steps.map((s) => (
          <Link key={s.title} to={s.to} className={cn('group flex gap-3 p-4 transition hover:bg-slate-50', s.done && 'opacity-60')}>
            {s.done ? <CheckCircle2 className="h-5 w-5 shrink-0 text-accent-600" /> : <Circle className="h-5 w-5 shrink-0 text-slate-300 group-hover:text-slate-900" />}
            <span>
              <span className={cn('block text-sm font-medium', s.done ? 'text-slate-500 line-through' : 'text-slate-900')}>{s.title}</span>
              <span className="block text-[13px] text-slate-500">{s.desc}</span>
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

export function DashboardPage() {
  const { data: me } = useMe();
  const { can } = usePermissions();
  const dash = useQuery({ queryKey: ['reports', 'dashboard'], queryFn: reportService.dashboard, refetchInterval: 15_000, enabled: can('dashboard.view') });
  const campaigns = useQuery({ queryKey: ['campaigns', 'recent'], queryFn: () => campaignService.list({ page: 1, limit: 5 }), enabled: can('campaigns.view') });
  const recentSms = useQuery({ queryKey: ['sms', 'recent'], queryFn: () => smsService.history({ page: 1, limit: 6 }), enabled: can('sms.view'), refetchInterval: 10_000 });
  const txns = useQuery({ queryKey: ['wallet', 'tx', 'recent'], queryFn: () => walletService.transactions({ page: 1, limit: 5 }), enabled: can('wallet.view') });
  const d = dash.data;
  const low = d && d.balance < d.lowBalanceThreshold;

  const actions = [
    { label: 'Send SMS', to: '/app/sms/send', icon: Send, perm: 'sms.send' },
    { label: 'Create campaign', to: '/app/campaigns/new', icon: Megaphone, perm: 'campaigns.create' },
    { label: 'Buy SMS', to: '/app/wallet/buy', icon: ShoppingCart, perm: 'wallet.purchase' },
    { label: 'Add contacts', to: '/app/contacts', icon: Contact, perm: 'contacts.create' },
  ].filter((a) => can(a.perm));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-slate-900">
            {greeting()}, {me?.user.fullName.split(' ')[0]}
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">Your SMS service at {me?.organization?.name}: usage, delivery and balance.</p>
        </div>
        {can('sms.send') && (
          <LinkButton to="/app/sms/send" icon={<Send className="h-4 w-4" />}>
            Send SMS
          </LinkButton>
        )}
      </div>

      <GettingStarted />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="SMS balance"
          icon={<Wallet />}
          tone={low ? 'amber' : 'slate'}
          loading={dash.isLoading}
          value={fmtNumber(d?.balance)}
          hint={low ? <span className="font-medium text-amber-700">Below your alert of {fmtNumber(d?.lowBalanceThreshold)}</span> : 'credits available'}
        />
        <StatCard label="Today’s usage" icon={<Send />} tone="slate" loading={dash.isLoading} value={fmtNumber(d?.today.total)} hint={`${fmtNumber(d?.today.pending)} pending`} />
        <StatCard label="This month" icon={<TrendingUp />} tone="slate" loading={dash.isLoading} value={fmtNumber(d?.month.total)} hint={`${fmtNumber(d?.month.delivered)} delivered`} />
        <StatCard
          label="Delivery rate"
          icon={<Gauge />}
          tone="emerald"
          loading={dash.isLoading}
          value={d?.month.deliveryRate != null ? `${d.month.deliveryRate}%` : '—'}
          hint={d?.month.deliveryRate != null ? `this month, ${fmtNumber(d.month.deliveryRateBasis.final)} final outcomes` : 'no delivery outcomes yet'}
        />
      </div>

      {actions.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {actions.map((a) => (
            <Link key={a.to} to={a.to} className="card group flex items-center gap-3 p-4 transition duration-150 hover:border-slate-300 hover:shadow-pop">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-700 group-hover:bg-slate-900 group-hover:text-white">
                <a.icon className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1 text-sm font-semibold text-slate-900">{a.label}</span>
              <ArrowRight className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-600" />
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card padded={false} className="xl:col-span-2">
          <CardHeader title="Messages — last 7 days" description="Sent, delivered and failed per day" action={can('reports.view') && <LinkButton to="/app/reports" variant="ghost" size="sm">Full report</LinkButton>} />
          <div className="p-4">{dash.isLoading ? <Skeleton className="h-[260px] w-full" /> : <SmsTrendChart data={d?.last7Days ?? []} />}</div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Delivery status" description="This month" />
          <div className="p-4">
            {dash.isLoading ? (
              <Skeleton className="h-[200px] w-full" />
            ) : (
              <>
                <StatusDonut delivered={d?.month.delivered ?? 0} failed={d?.month.failed ?? 0} pending={d?.month.pending ?? 0} />
                <div className="mt-4 space-y-2 text-sm">
                  {[
                    ['Delivered', d?.month.delivered ?? 0, 'emerald'],
                    ['Failed', d?.month.failed ?? 0, 'red'],
                    ['Pending', d?.month.pending ?? 0, 'amber'],
                  ].map(([l, v, t]) => (
                    <div key={l as string}>
                      <div className="mb-1 flex justify-between text-xs">
                        <span className="text-slate-600">{l}</span>
                        <span className="font-medium tabular-nums text-slate-900">{fmtNumber(v as number)}</span>
                      </div>
                      <ProgressBar value={d?.month.total ? ((v as number) / d.month.total) * 100 : 0} tone={t as 'emerald' | 'red' | 'amber'} />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        {can('campaigns.view') && (
          <Card padded={false}>
            <CardHeader title="Recent campaigns" action={<LinkButton to="/app/campaigns" variant="ghost" size="sm">View all</LinkButton>} />
            {campaigns.data?.data.length ? (
              <ul className="divide-y divide-slate-100">
                {campaigns.data.data.map((c) => (
                  <li key={c.id}>
                    <Link to={`/app/campaigns/${c.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-900">{c.name}</span>
                        <span className="text-xs text-slate-500">
                          {fmtNumber(c.stats.recipients)} recipients · {fmtNumber(c.stats.delivered)} delivered
                        </span>
                      </span>
                      <StatusBadge status={c.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Megaphone />} title="No campaigns yet" description="Reach a whole group at once." className="py-10" />
            )}
          </Card>
        )}
        {can('sms.view') && (
          <Card padded={false}>
            <CardHeader title="Recent SMS" action={<LinkButton to="/app/sms/history" variant="ghost" size="sm">History</LinkButton>} />
            {recentSms.data?.data.length ? (
              <ul className="divide-y divide-slate-100">
                {recentSms.data.data.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <span className="min-w-0">
                      <span className="block font-mono text-[13px] text-slate-900">{m.phone}</span>
                      <span className="block truncate text-xs text-slate-500">{m.message.body}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <StatusBadge status={m.status} />
                      <span className="text-xs text-slate-400">{fmtRelative(m.createdAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Send />} title="No messages yet" description="Messages you send will appear here with live status." className="py-10" />
            )}
          </Card>
        )}
        {can('wallet.view') && (
          <Card padded={false}>
            <CardHeader title="Recent transactions" action={<LinkButton to="/app/wallet/transactions" variant="ghost" size="sm">Ledger</LinkButton>} />
            {txns.data?.data.length ? (
              <ul className="divide-y divide-slate-100">
                {txns.data.data.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-slate-800">{t.description}</span>
                      <span className="text-xs text-slate-500">{fmtRelative(t.createdAt)}</span>
                    </span>
                    <span className={cn('shrink-0 font-semibold tabular-nums', t.amount > 0 ? 'text-accent-700' : 'text-slate-700')}>
                      {t.amount > 0 ? '+' : ''}
                      {fmtNumber(t.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Coins />} title="No transactions" description="Purchases and SMS charges appear here." className="py-10" />
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
