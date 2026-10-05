import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Area, AreaChart } from 'recharts';
import {
  AlertTriangle,
  ArrowDownLeft,
  Banknote,
  Boxes,
  Calculator,
  CheckCircle2,
  Coins,
  Inbox,
  Pencil,
  Plus,
  Radio,
  Receipt,
  ShoppingCart,
  Trash2,
  TrendingUp,
  Webhook as WebhookIcon,
  Activity,
} from 'lucide-react';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { EmptyState, ErrorState, PageLoader, Skeleton } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Overlay';
import { DataTable, Pagination } from '@/components/ui/Table';
import { DescriptionList, PageHeader, Tabs } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { businessService, type Expense } from '@/services/businessService';
import { cn, fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtRelative, titleCase } from '@/utils/format';
import { RangePicker, useRange } from '../dashboard/ReportsPage';

const FINANCE_RANGES = [
  { value: 'today' as const, label: 'Today' },
  { value: 'yesterday' as const, label: 'Yesterday' },
  { value: 'week' as const, label: 'This week' },
  { value: 'month' as const, label: 'This month' },
  { value: 'lastMonth' as const, label: 'Last month' },
  { value: 'year' as const, label: 'This year' },
  { value: 'all' as const, label: 'All time' },
  { value: 'custom' as const, label: 'Custom' },
];

const axis = { fontSize: 11, fill: '#94a3b8' };
const short = (l: string) => (/T\d{2}:00$/.test(l) ? l.slice(11, 16) : /^\d{4}-\d{2}-\d{2}$/.test(l) ? l.slice(5) : l);
const k = (v: number) => (Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v));

// ── Finance dashboard ──────────────────────────────────────────────────

export function FinancePage() {
  const r = useRange('month');
  const q = useQuery({ queryKey: ['admin', 'finance', r.params], queryFn: () => businessService.finance(r.params) });
  const d = q.data;
  const cur = d?.currency ?? 'RWF';
  const m = (v: string | null | undefined) => (v == null ? '—' : fmtMoney(v, cur));
  return (
    <div className="space-y-6">
      <PageHeader title="Business overview" description="Revenue, provider costs, margin and profit — computed from the ledgers." actions={<RangePicker {...r} options={FINANCE_RANGES} />} />
      {q.error ? (
        <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Customer revenue" icon={<Banknote />} tone="emerald" loading={q.isLoading} value={m(d?.money.revenue)} hint={`${fmtNumber(d?.counts.payments)} verified payments`} />
            <StatCard label="Provider spend" icon={<ShoppingCart />} tone="amber" loading={q.isLoading} value={m(d?.money.providerSpend)} hint={`${fmtNumber(d?.counts.providerPurchases)} capacity purchases`} />
            <StatCard label="Gross SMS margin" icon={<TrendingUp />} tone="brand" loading={q.isLoading} value={m(d?.money.grossMargin)} hint="Revenue − provider spend" />
            <StatCard
              label="Net profit"
              icon={<Calculator />}
              tone={d?.money.netProfit && Number(d.money.netProfit) < 0 ? 'red' : 'violet'}
              loading={q.isLoading}
              value={m(d?.money.netProfit)}
              hint={d?.money.netMarginPercent != null ? `${d.money.netMarginPercent}% net margin` : d?.canViewProfit === false ? 'Requires profit permission' : 'No revenue in period'}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <Card padded={false} className="xl:col-span-2">
              <CardHeader title="Revenue, costs and profit" description={d ? `${fmtDate(d.range.from)} – ${fmtDate(d.range.to)}` : undefined} />
              <div className="p-4">
                {q.isLoading ? (
                  <Skeleton className="h-[280px]" />
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={(d?.series ?? []).map((s) => ({ label: s.label, Revenue: Number(s.revenue), Costs: Number(s.costs), Profit: s.profit == null ? null : Number(s.profit) }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                      <XAxis dataKey="label" tickFormatter={short} tick={axis} axisLine={false} tickLine={false} minTickGap={16} />
                      <YAxis tick={axis} axisLine={false} tickLine={false} tickFormatter={k} />
                      <Tooltip formatter={(v) => `${cur} ${fmtNumber(Number(v))}`} labelFormatter={(l) => short(String(l))} />
                      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="Revenue" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={22} />
                      <Bar dataKey="Costs" fill="#f59e0b" radius={[3, 3, 0, 0]} maxBarSize={22} />
                      {d?.canViewProfit && <Line type="monotone" dataKey="Profit" stroke="#6366f1" strokeWidth={2} dot={false} />}
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>
            <Card padded={false}>
              <CardHeader title="Profit calculation" description="Transparent formula for the selected period" />
              <div className="space-y-2 p-5 text-sm">
                {[
                  ['Customer revenue', d?.money.revenue, 'plus'],
                  ['Provider spend', d?.money.providerSpend, 'minus'],
                  ['Gross SMS margin', d?.money.grossMargin, 'subtotal'],
                  ['Refunds', d?.money.refunds, 'minus'],
                  ['Payment fees', d?.money.paymentFees, 'minus'],
                  ['Other expenses', d?.money.otherExpenses, 'minus'],
                  ['Net profit', d?.money.netProfit, 'total'],
                ].map(([label, value, kind]) => (
                  <div key={label as string} className={cn('flex justify-between', (kind === 'subtotal' || kind === 'total') && 'border-t border-slate-200 pt-2 font-semibold', kind === 'total' && 'text-base')}>
                    <span className="text-slate-600">{kind === 'minus' ? '− ' : kind === 'plus' ? '' : ''}{label as string}</span>
                    <span className={cn('tabular-nums', kind === 'minus' && 'text-slate-500')}>{q.isLoading ? '…' : m(value as string | null)}</span>
                  </div>
                ))}
                <p className="pt-3 text-xs text-slate-500">{d?.formula.costBasis}. Amounts in {cur}.</p>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="SMS purchased" icon={<ArrowDownLeft />} tone="sky" loading={q.isLoading} value={fmtNumber(d?.sms.purchasedFromProviders)} hint="From providers, in period" />
            <StatCard label="SMS sold" icon={<Coins />} tone="emerald" loading={q.isLoading} value={fmtNumber(d?.sms.soldToCustomers)} hint={`${fmtNumber(d?.sms.refundedCredits)} credits refunded`} />
            <StatCard label="SMS used" icon={<Radio />} tone="violet" loading={q.isLoading} value={fmtNumber(d?.sms.usedByCustomers)} hint={`${fmtNumber(d?.sms.segmentsThroughProviders)} segments through providers`} />
            <StatCard label="Provider capacity remaining" icon={<Boxes />} tone="amber" loading={q.isLoading} value={fmtNumber(d?.sms.providerCapacityRemaining)} hint={`${fmtNumber(d?.sms.customerCreditsOutstanding)} credits held by customers`} />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card padded={false}>
              <CardHeader title="Unit economics" description="Per-sale contribution (accrual view)" />
              <div className="p-5">
                <DescriptionList
                  items={[
                    { label: 'Sales revenue', value: m(d?.unitEconomics.salesRevenue) },
                    { label: 'Est. provider cost of credits sold', value: m(d?.unitEconomics.estimatedProviderCostOfSales) },
                    { label: 'Payment fees on sales', value: m(d?.unitEconomics.paymentFeesOnSales) },
                    { label: 'Sales contribution', value: <strong>{m(d?.unitEconomics.salesContribution)}</strong> },
                    { label: 'Cost of SMS delivered (WAC)', value: m(d?.unitEconomics.costOfSmsDelivered) },
                    { label: 'Formula', value: <span className="text-xs text-slate-500">{d?.formula.saleContribution}</span> },
                  ]}
                />
              </div>
            </Card>
            <Card padded={false}>
              <CardHeader title="SMS inventory flow" description="Purchased vs sold vs used" />
              <div className="p-4">
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={d?.series ?? []} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="label" tickFormatter={short} tick={axis} axisLine={false} tickLine={false} minTickGap={16} />
                    <YAxis tick={axis} axisLine={false} tickLine={false} tickFormatter={k} />
                    <Tooltip formatter={(v) => fmtNumber(Number(v))} labelFormatter={(l) => short(String(l))} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="smsPurchased" name="Purchased" stroke="#0ea5e9" fill="#0ea5e922" />
                    <Area type="monotone" dataKey="smsSold" name="Sold" stroke="#10b981" fill="#10b98122" />
                    <Area type="monotone" dataKey="smsUsed" name="Used" stroke="#8b5cf6" fill="#8b5cf622" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <Card padded={false}>
            <CardHeader title="Providers" description="Spend, usage and remaining capacity" action={<Link to="/admin/providers" className="link text-sm">Manage →</Link>} />
            <DataTable
              rows={d?.providers}
              loading={q.isLoading}
              columns={[
                { key: 'n', header: 'Provider', cell: (p) => <span className="font-medium">{p.name}</span> },
                { key: 's', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
                { key: 'b', header: 'Purchased (period)', cell: (p) => fmtNumber(p.purchased) },
                { key: 'sp', header: 'Spend (period)', cell: (p) => fmtMoney(p.spend, cur) },
                { key: 'u', header: 'Used (period)', cell: (p) => fmtNumber(p.used) },
                {
                  key: 'r',
                  header: 'Remaining now',
                  cell: (p) => <span className={cn('font-semibold tabular-nums', p.remaining < p.lowCapacityThreshold && 'text-amber-600')}>{fmtNumber(p.remaining)}</span>,
                },
              ]}
              empty={<EmptyState title="No providers configured" className="py-8" />}
            />
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card padded={false}>
              <CardHeader title="Top customers by revenue" />
              <DataTable
                rows={d?.topCustomersByRevenue}
                columns={[
                  { key: 'n', header: 'Customer', cell: (c) => <Link to={`/admin/organizations/${c.id}`} className="link">{c.name}</Link> },
                  { key: 'r', header: 'Revenue', cell: (c) => fmtMoney(c.revenue, cur) },
                  { key: 'c', header: 'Credits bought', cell: (c) => fmtNumber(c.credits) },
                ]}
                empty={<EmptyState title="No sales in this period" className="py-8" />}
              />
            </Card>
            <Card padded={false}>
              <CardHeader title="Top customers by SMS usage" />
              <DataTable
                rows={d?.topCustomersByUsage}
                columns={[
                  { key: 'n', header: 'Customer', cell: (c) => <Link to={`/admin/organizations/${c.id}`} className="link">{c.name}</Link> },
                  { key: 'm', header: 'Messages', cell: (c) => fmtNumber(c.messages) },
                  { key: 'c', header: 'Credits', cell: (c) => fmtNumber(c.credits) },
                ]}
                empty={<EmptyState title="No traffic in this period" className="py-8" />}
              />
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <Card padded={false}>
              <CardHeader title="Recent customer payments" action={<Link to="/admin/payments" className="link text-sm">All →</Link>} />
              <ul className="divide-y divide-slate-100">
                {d?.recentPayments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                    <span className="min-w-0"><span className="block truncate">{p.organization.name}</span><span className="text-xs text-slate-500">{fmtRelative(p.createdAt)}</span></span>
                    <span className="flex shrink-0 flex-col items-end gap-1"><span className="tabular-nums">{fmtMoney(p.amount, p.currency)}</span><StatusBadge status={p.status} /></span>
                  </li>
                ))}
                {d && !d.recentPayments.length && <li className="px-5 py-6 text-center text-sm text-slate-400">None</li>}
              </ul>
            </Card>
            <Card padded={false}>
              <CardHeader title="Recent provider purchases" action={<Link to="/admin/provider-purchases" className="link text-sm">All →</Link>} />
              <ul className="divide-y divide-slate-100">
                {d?.recentProviderPurchases.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                    <span className="min-w-0"><span className="block truncate">{p.provider.name} · {fmtNumber(p.quantity)} SMS</span><span className="font-mono text-xs text-slate-500">{p.reference}</span></span>
                    <span className="flex shrink-0 flex-col items-end gap-1"><span className="tabular-nums">{fmtMoney(p.totalCost, p.currency)}</span><StatusBadge status={p.status} /></span>
                  </li>
                ))}
                {d && !d.recentProviderPurchases.length && <li className="px-5 py-6 text-center text-sm text-slate-400">None</li>}
              </ul>
            </Card>
            <Card padded={false}>
              <CardHeader title="Recent customer purchases" action={<Link to="/admin/sales" className="link text-sm">All →</Link>} />
              <ul className="divide-y divide-slate-100">
                {d?.recentSales.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                    <span className="min-w-0"><span className="block truncate">{s.organization.name}</span><span className="text-xs text-slate-500">{s.packageName} · {fmtNumber(s.credits)} credits</span></span>
                    <span className="flex shrink-0 flex-col items-end"><span className="tabular-nums">{fmtMoney(s.revenue, cur)}</span>{d?.canViewProfit && <span className="text-xs text-emerald-600">+{fmtMoney(s.contribution, cur)} contrib.</span>}</span>
                  </li>
                ))}
                {d && !d.recentSales.length && <li className="px-5 py-6 text-center text-sm text-slate-400">None</li>}
              </ul>
            </Card>
          </div>

          <Card padded={false}>
            <CardHeader title="Failed transactions" description="Customer payments and provider purchases that did not complete" />
            <DataTable
              rows={d?.failedTransactions}
              columns={[
                { key: 'k', header: 'Type', cell: (f) => <Badge color={f.kind === 'CUSTOMER_PAYMENT' ? 'blue' : 'amber'}>{f.kind === 'CUSTOMER_PAYMENT' ? 'Customer payment' : 'Provider purchase'}</Badge> },
                { key: 'r', header: 'Reference', cell: (f) => <span className="font-mono text-xs">{f.reference}</span> },
                { key: 'p', header: 'Party', cell: (f) => f.party },
                { key: 'a', header: 'Amount', cell: (f) => fmtMoney(f.amount, cur) },
                { key: 'e', header: 'Reason', cell: (f) => <span className="text-xs text-red-600">{f.reason}</span> },
                { key: 'd', header: 'Date', cell: (f) => fmtDateTime(f.createdAt) },
              ]}
              empty={<EmptyState icon={<CheckCircle2 />} title="No failed transactions" className="py-8" />}
            />
          </Card>
        </>
      )}
    </div>
  );
}

// ── Providers ──────────────────────────────────────────────────────────

export function ProviderPurchasesPage() {
  const [page, setPage] = useState(1);
  const [providerId, setProviderId] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const providers = useQuery({ queryKey: ['admin', 'providers'], queryFn: businessService.providers });
  const filters = {
    providerId: providerId || undefined,
    status: status || undefined,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
  };
  const q = useQuery({ queryKey: ['admin', 'provider-purchases', page, filters], queryFn: () => businessService.purchases({ page, limit: 20, ...filters }) });
  return (
    <div className="space-y-6">
      <PageHeader title="Provider purchases" description="Every purchase of SMS capacity from upstream providers." />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4">
          <Select value={providerId} onChange={(e) => { setProviderId(e.target.value); setPage(1); }} className="w-auto" aria-label="Provider">
            <option value="">All providers</option>
            {providers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto" aria-label="Status">
            <option value="">All statuses</option>
            <option value="SUCCESS">Completed</option>
            <option value="PENDING">Pending</option>
            <option value="FAILED">Failed</option>
          </Select>
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="w-auto" aria-label="From date" />
          <span className="text-slate-400">–</span>
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="w-auto" aria-label="To date" />
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'r', header: 'Purchase', cell: (p) => <span><span className="block font-mono text-xs font-medium">{p.reference}</span><span className="font-mono text-[11px] text-slate-400">{p.providerReference ?? '—'}</span></span> },
            { key: 'p', header: 'Provider', cell: (p) => p.provider.name },
            { key: 'q', header: 'SMS', cell: (p) => <span className="tabular-nums">{fmtNumber(p.quantity)}</span> },
            { key: 'u', header: 'Unit cost', cell: (p) => <span className="tabular-nums">{p.unitCost}</span> },
            { key: 't', header: 'Total cost', cell: (p) => <span className="font-medium tabular-nums">{fmtMoney(p.totalCost, p.currency)}</span> },
            { key: 's', header: 'Status', cell: (p) => <span title={p.failureReason ?? undefined}><StatusBadge status={p.status} /></span> },
            { key: 'd', header: 'Date', cell: (p) => fmtDateTime(p.createdAt) },
          ]}
          empty={<EmptyState icon={<ShoppingCart />} title="No provider purchases" description="Buy capacity from a provider under SMS Providers." />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

export function CapacityLedgerPage() {
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const q = useQuery({ queryKey: ['admin', 'capacity', 'all', page, type], queryFn: () => businessService.ledger({ page, limit: 25, type: type || undefined }) });
  return (
    <div className="space-y-6">
      <PageHeader title="Provider wallets" description="Append-only capacity ledger: purchases, usage by customer messages, releases and adjustments." />
      <Card padded={false}>
        <div className="border-b border-slate-100 p-4">
          <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All movements</option>
            {['PURCHASE', 'USAGE', 'RELEASE', 'ADJUSTMENT'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </Select>
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'd', header: 'Date', cell: (e) => <span className="text-slate-500">{fmtDateTime(e.createdAt)}</span> },
            { key: 'p', header: 'Provider', cell: (e) => e.provider.name },
            { key: 't', header: 'Type', cell: (e) => <Badge color={e.type === 'PURCHASE' ? 'green' : e.type === 'USAGE' ? 'gray' : e.type === 'RELEASE' ? 'blue' : 'amber'}>{titleCase(e.type)}</Badge> },
            { key: 'desc', header: 'Description', cell: (e) => <span className="block max-w-xs truncate">{e.description}</span> },
            { key: 'a', header: 'SMS', cell: (e) => <span className={cn('font-semibold tabular-nums', e.amount > 0 && 'text-emerald-600')}>{e.amount > 0 ? '+' : ''}{fmtNumber(e.amount)}</span> },
            { key: 'b', header: 'Before → after', cell: (e) => <span className="tabular-nums text-slate-500">{fmtNumber(e.balanceBefore)} → {fmtNumber(e.balanceAfter)}</span> },
            { key: 'c', header: 'Unit cost', cell: (e) => <span className="tabular-nums text-slate-500">{e.unitCost ?? '—'}</span> },
          ]}
          empty={<EmptyState icon={<Boxes />} title="No capacity movements" />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

export function CustomerSalesPage() {
  const { canAdmin } = usePermissions();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['admin', 'sales', page], queryFn: () => businessService.sales({ page, limit: 20 }) });
  const t = q.data?.totals;
  return (
    <div className="space-y-6">
      <PageHeader title="Customer SMS sales" description="Every package sold to a customer, with its estimated provider cost and contribution." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Credits sold" icon={<Coins />} value={fmtNumber(t?.credits)} loading={q.isLoading} />
        <StatCard label="Revenue" icon={<Banknote />} tone="emerald" value={t ? fmtMoney(t.revenue) : '—'} loading={q.isLoading} />
        <StatCard label="Est. provider cost + fees" icon={<Receipt />} tone="amber" value={t ? fmtMoney(String(Number(t.estimatedProviderCost) + Number(t.paymentFees))) : '—'} loading={q.isLoading} />
        {canAdmin('profit.view') && <StatCard label="Contribution" icon={<TrendingUp />} tone="violet" value={t ? fmtMoney(t.contribution) : '—'} loading={q.isLoading} />}
      </div>
      <Card padded={false}>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'o', header: 'Customer', cell: (s) => <Link to={`/admin/organizations/${s.organization.id}`} className="link">{s.organization.name}</Link> },
            { key: 'p', header: 'Package', cell: (s) => <span>{s.packageName}<span className="block text-xs text-slate-500">{fmtNumber(s.credits)} credits · {s.payment.reference}</span></span> },
            { key: 'r', header: 'Revenue', cell: (s) => <span className="tabular-nums">{fmtMoney(s.revenue, s.currency)}</span> },
            { key: 'c', header: 'Est. provider cost', cell: (s) => <span className="tabular-nums text-slate-500">{fmtMoney(s.estimatedProviderCost, s.currency)}</span> },
            { key: 'f', header: 'Payment fee', cell: (s) => <span className="tabular-nums text-slate-500">{fmtMoney(s.paymentFee, s.currency)}</span> },
            ...(canAdmin('profit.view') ? [{ key: 'm', header: 'Contribution', cell: (s: { contribution: string; currency: string }) => <span className="font-medium tabular-nums text-emerald-600">{fmtMoney(s.contribution, s.currency)}</span> }] : []),
            { key: 'd', header: 'Date', cell: (s) => fmtDateTime(s.createdAt) },
          ]}
          empty={<EmptyState icon={<Coins />} title="No sales yet" description="Sales appear when customers' payments are verified." />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

const EXPENSE_CATEGORIES = ['INFRASTRUCTURE', 'SOFTWARE', 'PERSONNEL', 'MARKETING', 'REGULATORY', 'PAYMENT_PROCESSING', 'OTHER'];

function ExpenseModal({ expense, open, onClose }: { expense: Expense | null; open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ category: 'INFRASTRUCTURE', description: '', vendor: '', reference: '', amount: '', incurredAt: new Date().toISOString().slice(0, 10) });
  const [loaded, setLoaded] = useState<string | null | undefined>(undefined);
  if (open && loaded !== (expense?.id ?? null)) {
    setLoaded(expense?.id ?? null);
    setForm(expense
      ? { category: expense.category, description: expense.description, vendor: expense.vendor ?? '', reference: expense.reference ?? '', amount: expense.amount, incurredAt: expense.incurredAt.slice(0, 10) }
      : { category: 'INFRASTRUCTURE', description: '', vendor: '', reference: '', amount: '', incurredAt: new Date().toISOString().slice(0, 10) });
  }
  const body = { ...form, vendor: form.vendor || null, reference: form.reference || null, incurredAt: new Date(`${form.incurredAt}T12:00:00`).toISOString() };
  const m = useApiMutation(() => (expense ? businessService.updateExpense(expense.id, body) : businessService.createExpense(body)), {
    success: expense ? 'Expense updated' : 'Expense recorded',
    invalidate: [['admin', 'expenses'], ['admin', 'finance']],
    onSuccess: () => { setLoaded(undefined); onClose(); },
  });
  const set = (k2: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k2]: e.target.value }));
  return (
    <Modal open={open} onClose={() => { setLoaded(undefined); onClose(); }} title={expense ? 'Edit expense' : 'Record expense'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!form.description || !/^\d+(\.\d{1,2})?$/.test(form.amount)} loading={m.isPending} onClick={() => m.mutate(undefined)}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category"><Select value={form.category} onChange={set('category')}>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}</Select></Field>
        <Field label="Date"><Input type="date" value={form.incurredAt} onChange={set('incurredAt')} /></Field>
        <Field label="Description" required className="sm:col-span-2"><Input value={form.description} onChange={set('description')} placeholder="e.g. Cloud hosting — September" /></Field>
        <Field label="Amount" required><Input value={form.amount} onChange={set('amount')} placeholder="25000" /></Field>
        <Field label="Vendor"><Input value={form.vendor} onChange={set('vendor')} /></Field>
        <Field label="Reference" className="sm:col-span-2"><Input value={form.reference} onChange={set('reference')} placeholder="Invoice or receipt number" /></Field>
      </div>
    </Modal>
  );
}

export function ExpensesPage() {
  const { canAdmin } = usePermissions();
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState('');
  const [modal, setModal] = useState<{ open: boolean; expense: Expense | null }>({ open: false, expense: null });
  const [del, setDel] = useState<Expense | null>(null);
  const q = useQuery({ queryKey: ['admin', 'expenses', page, category], queryFn: () => businessService.expenses({ page, limit: 20, category: category || undefined }) });
  const remove = useApiMutation((id: string) => businessService.deleteExpense(id), { success: 'Expense removed', invalidate: [['admin', 'expenses'], ['admin', 'finance']], onSuccess: () => setDel(null) });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        description="Operating costs not already captured by provider purchases or payment fees (hosting, salaries, marketing…)."
        actions={canAdmin('expenses.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setModal({ open: true, expense: null })}>Record expense</Button>}
      />
      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
          <Select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All categories</option>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </Select>
          <span className="text-sm text-slate-600">Total: <strong className="tabular-nums">{q.data ? fmtMoney(q.data.total) : '—'}</strong></span>
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'd', header: 'Date', cell: (e) => fmtDate(e.incurredAt) },
            { key: 'c', header: 'Category', cell: (e) => <Badge>{titleCase(e.category)}</Badge> },
            { key: 'x', header: 'Description', cell: (e) => <span><span className="block">{e.description}</span><span className="text-xs text-slate-500">{[e.vendor, e.reference].filter(Boolean).join(' · ')}</span></span> },
            { key: 'a', header: 'Amount', cell: (e) => <span className="font-medium tabular-nums">{fmtMoney(e.amount, e.currency)}</span> },
            {
              key: 'act',
              header: '',
              className: 'text-right',
              cell: (e) =>
                canAdmin('expenses.manage') && (
                  <span className="flex justify-end gap-1">
                    <Button size="xs" variant="secondary" icon={<Pencil className="h-3 w-3" />} onClick={() => setModal({ open: true, expense: e })}>Edit</Button>
                    <Button size="xs" variant="ghost" className="text-red-600" icon={<Trash2 className="h-3 w-3" />} onClick={() => setDel(e)}>Delete</Button>
                  </span>
                ),
            },
          ]}
          empty={<EmptyState icon={<Receipt />} title="No expenses recorded" description="Record operating costs so net profit reflects the real business." />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
      <ExpenseModal open={modal.open} expense={modal.expense} onClose={() => setModal({ open: false, expense: null })} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title="Remove this expense?" description="It is kept for audit but excluded from all reports." confirmLabel="Remove" loading={remove.isPending} onConfirm={() => del && remove.mutate(del.id)} />
    </div>
  );
}

export function InquiriesPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'NEW' | 'HANDLED' | ''>('NEW');
  const q = useQuery({ queryKey: ['admin', 'inquiries', page, status], queryFn: () => businessService.inquiries({ page, limit: 20, status: status || undefined }) });
  const handle = useApiMutation((id: string) => businessService.handleInquiry(id), { success: 'Marked as handled', invalidate: [['admin', 'inquiries']] });
  return (
    <div className="space-y-6">
      <PageHeader title="Inquiries" description="Messages sent from the public website contact form." />
      <Tabs tabs={[{ value: 'NEW' as const, label: 'Open' }, { value: 'HANDLED' as const, label: 'Handled' }, { value: '' as const, label: 'All' }]} value={status} onChange={(v) => { setStatus(v); setPage(1); }} />
      {q.isLoading ? <PageLoader /> : q.error ? <Card><ErrorState error={q.error} /></Card> : !q.data?.data.length ? (
        <Card><EmptyState icon={<Inbox />} title="No inquiries" /></Card>
      ) : (
        <div className="space-y-3">
          {q.data.data.map((i) => (
            <Card key={i.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-slate-900">{i.name}{i.company && <span className="font-normal text-slate-500"> · {i.company}</span>}</p>
                  <p className="text-sm text-slate-500"><a className="link" href={`mailto:${i.email}`}>{i.email}</a>{i.phone && ` · ${i.phone}`} · {fmtRelative(i.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={i.status} />
                  {i.status === 'NEW' && <Button size="xs" variant="secondary" onClick={() => handle.mutate(i.id)}>Mark handled</Button>}
                </div>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{i.message}</p>
            </Card>
          ))}
          <Pagination pagination={q.data.pagination} onPage={setPage} />
        </div>
      )}
    </div>
  );
}

export function AdminApiUsagePage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [requestId, setRequestId] = useState('');
  const usage = useQuery({ queryKey: ['admin', 'api-usage'], queryFn: businessService.apiUsage });
  const q = useQuery({ queryKey: ['admin', 'api-logs', page, status, requestId], queryFn: () => businessService.apiLogs({ page, limit: 25, status: status || undefined, requestId: requestId || undefined }), refetchInterval: 15_000 });
  return (
    <div className="space-y-6">
      <PageHeader title="API usage" description="Public API traffic across all customers." />
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Requests (24h)" icon={<Activity />} value={fmtNumber(usage.data?.last24h.requests)} loading={usage.isLoading} />
        <StatCard label="Errors (24h)" icon={<AlertTriangle />} tone="red" value={fmtNumber(usage.data?.last24h.errors)} loading={usage.isLoading} />
        <Card>
          <p className="text-sm font-medium text-slate-500">Top API customers (24h)</p>
          <ul className="mt-2 space-y-1 text-sm">
            {usage.data?.topOrganizations.slice(0, 4).map((o) => <li key={o.id} className="flex justify-between"><Link to={`/admin/organizations/${o.id}`} className="link">{o.name}</Link><span className="tabular-nums">{fmtNumber(o.requests)}</span></li>)}
            {usage.data && !usage.data.topOrganizations.length && <li className="text-slate-400">No traffic</li>}
          </ul>
        </Card>
      </div>
      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto"><option value="">All responses</option><option value="success">Success</option><option value="error">Errors</option></Select>
          <Input value={requestId} onChange={(e) => { setRequestId(e.target.value); setPage(1); }} placeholder="Request ID" className="max-w-xs font-mono" />
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 't', header: 'Time', cell: (l) => <span className="text-slate-500">{fmtDateTime(l.createdAt)}</span> },
            { key: 'o', header: 'Customer', cell: (l) => <Link to={`/admin/organizations/${l.organization.id}`} className="link">{l.organization.name}</Link> },
            { key: 'r', header: 'Request', cell: (l) => <span className="font-mono text-xs"><span className="mr-2 font-semibold text-brand-700">{l.method}</span>{l.path}</span> },
            { key: 's', header: 'Status', cell: (l) => <Badge color={l.statusCode < 400 ? 'green' : l.statusCode < 500 ? 'amber' : 'red'}>{l.statusCode}{l.errorCode ? ` · ${l.errorCode}` : ''}</Badge> },
            { key: 'd', header: 'Duration', cell: (l) => `${l.durationMs} ms` },
            { key: 'k', header: 'Key', cell: (l) => (l.apiKey ? <span className="font-mono text-xs">{l.apiKey.prefix}</span> : '—') },
            { key: 'id', header: 'Request ID', cell: (l) => <span className="font-mono text-[11px] text-slate-400">{l.requestId?.slice(0, 12)}</span> },
          ]}
          empty={<EmptyState icon={<Activity />} title="No API requests" />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

export function AdminWebhooksPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['admin', 'webhooks', page, status], queryFn: () => businessService.webhookDeliveries({ page, limit: 25, status: status || undefined }), refetchInterval: 15_000 });
  return (
    <div className="space-y-6">
      <PageHeader title="Webhook deliveries" description="Outbound webhook deliveries to customer endpoints, including retries." />
      <Card padded={false}>
        <div className="border-b border-slate-100 p-4">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All</option>
            {['PENDING', 'SUCCESS', 'RETRYING', 'FAILED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 't', header: 'Created', cell: (d) => <span className="text-slate-500">{fmtDateTime(d.createdAt)}</span> },
            { key: 'o', header: 'Customer', cell: (d) => <Link to={`/admin/organizations/${d.webhook.organization.id}`} className="link">{d.webhook.organization.name}</Link> },
            { key: 'e', header: 'Event', cell: (d) => <span className="font-mono text-xs">{d.event}</span> },
            { key: 'u', header: 'Endpoint', cell: (d) => <span className="block max-w-xs truncate font-mono text-xs text-slate-500">{d.webhook.url}</span> },
            { key: 's', header: 'Status', cell: (d) => <StatusBadge status={d.status} /> },
            { key: 'a', header: 'Attempts', cell: (d) => `${d.attempts}${d.responseStatus ? ` · HTTP ${d.responseStatus}` : ''}` },
            { key: 'err', header: 'Last error', cell: (d) => <span className="text-xs text-red-600">{d.lastError}</span> },
          ]}
          empty={<EmptyState icon={<WebhookIcon />} title="No webhook deliveries" />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

/** Extra operational cards for the admin dashboard (business summary for this month). */
export function AdminBusinessSummary() {
  const { canAdmin } = usePermissions();
  const q = useQuery({ queryKey: ['admin', 'finance', 'summary-month'], queryFn: () => businessService.finance({ range: 'month' }), enabled: canAdmin('finance.view') });
  const d = q.data;
  if (!canAdmin('finance.view')) return null;
  const cur = d?.currency ?? 'RWF';
  return (
    <Card padded={false}>
      <CardHeader title="This month's business" description="From the finance ledgers" action={<Link to="/admin/finance" className="link text-sm">Business overview →</Link>} />
      <div className="grid gap-px bg-slate-100 sm:grid-cols-3 xl:grid-cols-6">
        {[
          ['Total revenue', d ? fmtMoney(d.money.revenue, cur) : '—', Banknote],
          ['Provider cost', d ? fmtMoney(d.money.providerSpend, cur) : '—', ShoppingCart],
          ['Gross profit', d?.money.grossMargin != null ? fmtMoney(d.money.grossMargin, cur) : '—', TrendingUp],
          ['Net profit', d?.money.netProfit != null ? fmtMoney(d.money.netProfit, cur) : '—', Calculator],
          ['SMS sold / used', d ? `${fmtNumber(d.sms.soldToCustomers)} / ${fmtNumber(d.sms.usedByCustomers)}` : '—', Coins],
          ['Provider capacity', d ? fmtNumber(d.sms.providerCapacityRemaining) : '—', Boxes],
        ].map(([label, value, Icon]) => {
          const I = Icon as typeof Banknote;
          return (
            <div key={label as string} className="bg-white p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-slate-500"><I className="h-3.5 w-3.5" />{label as string}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{q.isLoading ? '…' : (value as string)}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
