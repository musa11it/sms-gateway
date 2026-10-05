import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Banknote, CheckCircle2, Coins, Hourglass, Megaphone, Send, ShoppingCart, Wallet, XCircle } from 'lucide-react';
import { RevenueChart, SmsTrendChart, StatusDonut } from '@/components/charts/Charts';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { ErrorState, Skeleton } from '@/components/ui/Feedback';
import { Input } from '@/components/ui/Form';
import { PageHeader, SegmentedControl } from '@/components/ui/Misc';
import { reportService, type RangeKey } from '@/services/reportService';
import { fmtDate, fmtMoney, fmtNumber, titleCase } from '@/utils/format';

export const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom' },
];

export function RangePicker({ range, setRange, from, to, setFrom, setTo, options = RANGE_OPTIONS }: { range: RangeKey; setRange: (r: RangeKey) => void; from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; options?: { value: RangeKey; label: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl options={options} value={range} onChange={setRange} />
      {range === 'custom' && (
        <div className="flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-auto py-1" />
          <span className="text-slate-400">–</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-auto py-1" />
        </div>
      )}
    </div>
  );
}

export function useRange(initial: RangeKey = '30d') {
  const [range, setRange] = useState<RangeKey>(initial);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const params = range === 'custom' ? { range, from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59`).toISOString() } : { range };
  return { range, setRange, from, setFrom, to, setTo, params };
}

export function ReportsPage() {
  const r = useRange();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['reports', 'overview', r.params], queryFn: () => reportService.overview(r.params) });
  const t = data?.totals;
  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description="Messaging volume, delivery outcomes and credit consumption." actions={<RangePicker {...r} />} />
      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            <StatCard label="SMS sent" icon={<Send />} value={fmtNumber(t?.total)} loading={isLoading} />
            <StatCard label="Delivered" icon={<CheckCircle2 />} tone="emerald" value={fmtNumber(t?.delivered)} loading={isLoading} />
            <StatCard label="Failed" icon={<XCircle />} tone="red" value={fmtNumber(t?.failed)} loading={isLoading} />
            <StatCard label="Pending" icon={<Hourglass />} tone="violet" value={fmtNumber(t?.pending)} loading={isLoading} hint="awaiting delivery report" />
            <StatCard label="Credits consumed" icon={<Coins />} tone="amber" value={fmtNumber(t?.creditsConsumed)} loading={isLoading} hint="net of refunds" />
            <StatCard label="Campaigns" icon={<Megaphone />} tone="sky" value={fmtNumber(t?.campaigns)} loading={isLoading} />
          </div>
          <div className="grid gap-6 xl:grid-cols-3">
            <Card padded={false} className="xl:col-span-2">
              <CardHeader
                title="Volume over time"
                description={data ? `${fmtDate(data.range.from)} – ${fmtDate(data.range.to)} · ${data.range.timezone}` : undefined}
              />
              <div className="p-4">{isLoading ? <Skeleton className="h-[300px]" /> : <SmsTrendChart data={data?.series ?? []} height={300} />}</div>
            </Card>
            <Card padded={false}>
              <CardHeader title="Delivery rate" description="Only messages with a final outcome are counted" />
              <div className="p-5">
                {isLoading ? (
                  <Skeleton className="h-[200px]" />
                ) : (
                  <>
                    <p className="text-4xl font-semibold tracking-tight text-slate-900">{t?.deliveryRate != null ? `${t.deliveryRate}%` : '—'}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {t?.deliveryRate != null
                        ? `Based on ${fmtNumber(t.deliveryRateBasis.final)} of ${fmtNumber(t.deliveryRateBasis.total)} messages with a final status.`
                        : 'Not enough final delivery reports in this period to compute a rate.'}
                    </p>
                    <div className="mt-4">
                      <StatusDonut delivered={t?.delivered ?? 0} failed={t?.failed ?? 0} pending={t?.pending ?? 0} height={180} />
                    </div>
                  </>
                )}
              </div>
            </Card>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Credits purchased" icon={<ShoppingCart />} tone="emerald" value={fmtNumber(data?.billing.creditsPurchased)} loading={isLoading} />
            <StatCard label="Credits used" icon={<Coins />} tone="violet" value={fmtNumber(data?.billing.creditsUsed)} loading={isLoading} />
            <StatCard label="Remaining balance" icon={<Wallet />} value={fmtNumber(data?.billing.remainingBalance)} loading={isLoading} hint="credits now" />
            <StatCard label="Total spending" icon={<Banknote />} tone="amber" value={data ? fmtMoney(data.billing.totalSpending, data.billing.currency) : '—'} loading={isLoading} />
          </div>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card padded={false}>
              <CardHeader title="Spending" description="Verified SMS purchases" />
              <div className="p-4">{isLoading ? <Skeleton className="h-[240px]" /> : <RevenueChart data={(data?.spendingSeries ?? []).map((s) => ({ label: s.label, revenue: s.amount }))} currency={data?.billing.currency ?? 'RWF'} height={240} />}</div>
            </Card>
            <Card padded={false}>
              <CardHeader title="Campaign performance" description="Campaigns launched in this period" />
              {data?.campaignPerformance.length ? (
                <ul className="divide-y divide-slate-100">
                  {data.campaignPerformance.map((c) => {
                    const final = c.delivered + c.failed;
                    return (
                      <li key={c.id} className="px-5 py-3">
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <Link to={`/app/campaigns/${c.id}`} className="link truncate">{c.name}</Link>
                          <span className="shrink-0 text-xs text-slate-500">{fmtNumber(c.recipients)} recipients · {final ? `${Math.round((c.delivered / final) * 100)}% delivered` : 'pending'}</span>
                        </div>
                        <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div className="bg-emerald-500" style={{ width: `${c.recipients ? (c.delivered / c.recipients) * 100 : 0}%` }} />
                          <div className="bg-red-500" style={{ width: `${c.recipients ? (c.failed / c.recipients) * 100 : 0}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-5 py-10 text-center text-sm text-slate-400">No campaigns launched in this period</p>
              )}
            </Card>
          </div>
          <Card padded={false}>
            <CardHeader title="By channel" description="Where your messages originated" />
            <div className="grid gap-4 p-5 sm:grid-cols-3">
              {['DASHBOARD', 'CAMPAIGN', 'API'].map((s) => {
                const v = data?.bySource.find((b) => b.source === s)?.messages ?? 0;
                return (
                  <div key={s} className="rounded-xl bg-slate-50 p-4 ring-1 ring-inset ring-slate-100">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{s === 'API' ? 'API' : titleCase(s)}</p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{fmtNumber(v)}</p>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
