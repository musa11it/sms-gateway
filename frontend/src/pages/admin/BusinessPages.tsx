import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AMBER, GREEN, GREY, INK, TrendChart } from '@/components/charts/Charts';
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
import { DescriptionList, PageHeader, ProgressBar, Tabs } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { adminService } from '@/services/adminService';
import { businessService, type CustomerSale, type Expense, type ProfitGroup } from '@/services/businessService';
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


// ── Finance dashboard ──────────────────────────────────────────────────

const PROFIT_GROUPS: { value: ProfitGroup; label: string; header: string }[] = [
  { value: 'provider', label: 'Provider', header: 'Provider' },
  { value: 'organization', label: 'Customer', header: 'Customer' },
  { value: 'campaign', label: 'Campaign', header: 'Campaign' },
  { value: 'country', label: 'Country', header: 'Destination country' },
  { value: 'network', label: 'Network', header: 'Destination network' },
  { value: 'day', label: 'Day', header: 'Day' },
  { value: 'month', label: 'Month', header: 'Month' },
];

const profitTone = (v: string | null | undefined) => (v != null && Number(v) < 0 ? 'text-red-600' : 'text-emerald-700');

/**
 * SMS gross profit, segment level: revenue of the credits used for SMS accepted by providers (each at
 * the price it was bought at) − cost of the provider stock lots those SMS consumed. Same figures as
 * the provider, customer, campaign and per-SMS views.
 */
function SmsGrossProfit({ params, cur }: { params: { range: string; from?: string; to?: string }; cur: string }) {
  const [groupBy, setGroupBy] = useState<ProfitGroup>('provider');
  const [organizationId, setOrganizationId] = useState('');
  const [providerId, setProviderId] = useState('');
  const filters = { ...params, groupBy, ...(organizationId ? { organizationId } : {}), ...(providerId ? { providerId } : {}) };
  const q = useQuery({ queryKey: ['admin', 'finance', 'profit', filters], queryFn: () => businessService.profit(filters) });
  const providers = useQuery({ queryKey: ['admin', 'providers'], queryFn: businessService.providers });
  const orgs = useQuery({ queryKey: ['admin', 'organizations', 'finance-filter'], queryFn: () => adminService.organizations({ page: 1, limit: 100 }) });
  const t = q.data?.totals;
  const m = (v: string | null | undefined) => (v == null ? '—' : fmtMoney(v, cur));
  const header = PROFIT_GROUPS.find((g) => g.value === groupBy)!.header;
  return (
    <Card padded={false}>
      <CardHeader
        title="SMS gross profit"
        description="Per SMS segment: what the customer paid for the credits used (at their purchase price) minus what the provider stock those SMS consumed cost us. Only SMS accepted by a provider count; payment fees and operating costs are not included."
      />
      <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Customer revenue" icon={<Banknote />} tone="emerald" loading={q.isLoading} value={m(t?.revenue)} hint={t ? `${fmtNumber(t.credits)} credits used · ${fmtNumber(t.messages)} SMS` : undefined} />
        <StatCard label="Provider cost" icon={<ShoppingCart />} tone="amber" loading={q.isLoading} value={m(t?.providerCost)} hint={t ? `${fmtNumber(t.segments)} segments at their stock lot cost` : undefined} />
        <StatCard label="Gross profit" icon={<TrendingUp />} tone={t?.grossProfit && Number(t.grossProfit) < 0 ? 'red' : 'brand'} loading={q.isLoading} value={m(t?.grossProfit)} hint="Customer revenue − provider cost" />
        <StatCard
          label="Gross margin"
          icon={<Calculator />}
          tone="violet"
          loading={q.isLoading}
          value={t?.grossMarginPercent != null ? `${t.grossMarginPercent}%` : '—'}
          hint={t?.pending.messages ? `${fmtNumber(t.pending.messages)} SMS waiting for a provider (${fmtNumber(t.pending.credits)} credits reserved, not counted)` : 'Gross profit ÷ customer revenue'}
        />
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-slate-100 px-5 pt-3">
        <Tabs tabs={PROFIT_GROUPS.map((g) => ({ value: g.value, label: g.label }))} value={groupBy} onChange={setGroupBy} className="border-b-0" />
        <div className="flex flex-wrap gap-2 pb-2">
          <Select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} className="h-9 w-48 py-1 text-sm" aria-label="Customer">
            <option value="">All customers</option>
            {(orgs.data?.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
          <Select value={providerId} onChange={(e) => setProviderId(e.target.value)} className="h-9 w-44 py-1 text-sm" aria-label="Provider">
            <option value="">All providers</option>
            {(providers.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
      </div>
      <DataTable
        rows={q.data?.rows.map((r) => ({ ...r, id: r.key ?? 'none' }))}
        loading={q.isLoading}
        error={q.error}
        columns={[
          { key: 'l', header, cell: (r) => <span className="font-medium text-slate-900">{r.label}</span> },
          { key: 's', header: 'Segments', className: 'text-right', headerClassName: 'text-right', cell: (r) => <span className="tabular-nums">{fmtNumber(r.segments)}</span> },
          { key: 'r', header: 'Customer revenue', className: 'text-right', headerClassName: 'text-right', cell: (r) => <span className="tabular-nums">{m(r.revenue)}</span> },
          { key: 'c', header: 'Provider cost', className: 'text-right', headerClassName: 'text-right', cell: (r) => <span className="tabular-nums text-amber-700">{m(r.providerCost)}</span> },
          { key: 'g', header: 'Gross profit', className: 'text-right', headerClassName: 'text-right', cell: (r) => <span className={cn('font-semibold tabular-nums', profitTone(r.grossProfit))}>{m(r.grossProfit)}</span> },
          { key: 'p', header: 'Gross margin', className: 'text-right', headerClassName: 'text-right', cell: (r) => <span className={cn('tabular-nums', profitTone(r.grossProfit))}>{r.grossMarginPercent != null ? `${r.grossMarginPercent}%` : '—'}</span> },
        ]}
        empty={<EmptyState icon={<TrendingUp />} title="No SMS accepted by providers in this period" description="Gross profit appears once providers accept messages." />}
      />
    </Card>
  );
}

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
            <StatCard label="Customer payments" icon={<Banknote />} tone="emerald" loading={q.isLoading} value={m(d?.money.revenue)} hint={`Cash received · ${fmtNumber(d?.counts.payments)} verified payments`} />
            <StatCard label="Provider stock purchases" icon={<ShoppingCart />} tone="amber" loading={q.isLoading} value={m(d?.money.providerSpend)} hint={`Cash paid · ${fmtNumber(d?.counts.providerPurchases)} capacity purchases`} />
            <StatCard label="Cash margin" icon={<TrendingUp />} tone="brand" loading={q.isLoading} value={m(d?.money.grossMargin)} hint="Payments − stock purchases (cash basis, not gross profit)" />
            <StatCard
              label="Net profit"
              icon={<Calculator />}
              tone={d?.money.netProfit && Number(d.money.netProfit) < 0 ? 'red' : 'violet'}
              loading={q.isLoading}
              value={m(d?.money.netProfit)}
              hint={d?.money.netMarginPercent != null ? `${d.money.netMarginPercent}% net margin` : d?.canViewProfit === false ? 'Requires profit permission' : 'No revenue in period'}
            />
          </div>

          {d?.canViewProfit && <SmsGrossProfit params={r.params} cur={cur} />}

          <div className="grid gap-6 xl:grid-cols-3">
            <Card padded={false} className="xl:col-span-2">
              <CardHeader title="Revenue, costs and profit" description={d ? `${fmtDate(d.range.from)} – ${fmtDate(d.range.to)}` : undefined} />
              <div className="p-4">
                {q.isLoading ? (
                  <Skeleton className="h-[280px]" />
                ) : (
                  <TrendChart
                    height={280}
                    xKey="label"
                    data={(d?.series ?? []).map((s) => ({ label: s.label, Revenue: Number(s.revenue), Costs: Number(s.costs), Profit: s.profit == null ? null : Number(s.profit) }))}
                    series={[
                      { key: 'Revenue', label: 'Revenue', color: GREEN, area: true, format: (v) => `${cur} ${fmtNumber(v)}` },
                      { key: 'Costs', label: 'Costs', color: AMBER, format: (v) => `${cur} ${fmtNumber(v)}` },
                      ...(d?.canViewProfit ? [{ key: 'Profit', label: 'Profit', color: INK, format: (v: number) => `${cur} ${fmtNumber(v)}` }] : []),
                    ]}
                  />
                )}
              </div>
            </Card>
            <Card padded={false}>
              <CardHeader title="Cash profit calculation" description="Money in and out in the selected period" />
              <div className="space-y-2 p-5 text-sm">
                {[
                  ['Customer payments', d?.money.revenue, 'plus'],
                  ['Provider stock purchases', d?.money.providerSpend, 'minus'],
                  ['Cash margin', d?.money.grossMargin, 'subtotal'],
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
                <p className="pt-3 text-xs text-slate-500">Cash view: stock bought in the period counts as a cost even if it is not used yet. SMS gross profit above matches revenue and cost per segment instead. Amounts in {cur}.</p>
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
                    { label: 'Provider cost of SMS sent (stock lot cost)', value: m(d?.unitEconomics.costOfSmsDelivered) },
                    { label: 'Formula', value: <span className="text-xs text-slate-500">{d?.formula.saleContribution}</span> },
                  ]}
                />
              </div>
            </Card>
            <Card padded={false}>
              <CardHeader title="SMS inventory flow" description="Purchased vs sold vs used" />
              <div className="p-4">
                <TrendChart
                  height={220}
                  xKey="label"
                  data={(d?.series ?? []) as never}
                  series={[
                    { key: 'smsPurchased', label: 'Purchased', color: GREY },
                    { key: 'smsSold', label: 'Sold', color: GREEN, area: true },
                    { key: 'smsUsed', label: 'Used', color: INK },
                  ]}
                />
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
            { key: 'r', header: 'Purchase', cell: (p) => <span><span className="block font-mono text-xs font-medium">{p.reference}</span><span className="font-mono text-xs text-slate-400">{p.providerReference ?? '—'}</span></span> },
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
      <PageHeader
        title="Customer SMS sales"
        description="Every credit purchase, at the price the customer paid. Gross profit only exists for credits already used for SMS accepted by a provider; unused credits carry no provider cost."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Credits sold" icon={<Coins />} value={fmtNumber(t?.credits)} loading={q.isLoading} />
        <StatCard label="Purchase value" icon={<Banknote />} tone="emerald" value={t ? fmtMoney(t.revenue) : '—'} loading={q.isLoading} hint="Credit sales (cash received)" />
        <StatCard label="Payment fees" icon={<Receipt />} tone="amber" value={t ? fmtMoney(t.paymentFees) : '—'} loading={q.isLoading} hint="Operating cost — not part of gross profit" />
      </div>
      <Card padded={false}>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'o', header: 'Customer', cell: (s) => <Link to={`/admin/organizations/${s.organization.id}`} className="link">{s.organization.name}</Link> },
            { key: 'p', header: 'Purchase', cell: (s) => <span>{s.packageName}<span className="block text-xs text-slate-500">{fmtNumber(s.credits)} credits · {s.payment.reference}</span></span> },
            {
              key: 'r',
              header: 'Purchase value',
              cell: (s) => (
                <span className="tabular-nums">
                  {fmtMoney(s.revenue, s.currency)}
                  {s.usage.unitPrice && <span className="block text-xs text-slate-500">{fmtMoney(s.usage.unitPrice, s.currency)} / credit</span>}
                </span>
              ),
            },
            {
              key: 'u',
              header: 'Credits used / remaining',
              cell: (s) => (
                <span className="block min-w-[9rem]">
                  <span className="flex justify-between text-xs tabular-nums"><span>{fmtNumber(s.usage.creditsUsed)} used</span><span className="font-medium">{fmtNumber(s.usage.creditsRemaining)} left</span></span>
                  <ProgressBar value={s.credits ? (s.usage.creditsUsed / s.credits) * 100 : 0} className="mt-1" />
                  {s.usage.creditsOther > 0 && <span className="block text-xs text-slate-400">{fmtNumber(s.usage.creditsOther)} in progress, expired or reversed</span>}
                </span>
              ),
            },
            { key: 'ru', header: 'Customer revenue', cell: (s) => <span className="tabular-nums" title="Credits used × purchase price">{fmtMoney(s.usage.revenueUsed, s.currency)}</span> },
            { key: 'c', header: 'Provider cost', cell: (s) => <span className="tabular-nums text-amber-700" title="Stock lot cost of the SMS sent with these credits">{fmtMoney(s.usage.providerCost, s.currency)}</span> },
            ...(canAdmin('profit.view')
              ? [
                  {
                    key: 'm',
                    header: 'Gross profit',
                    cell: (s: CustomerSale) => (
                      <span className={cn('font-medium tabular-nums', Number(s.usage.grossProfit) < 0 ? 'text-red-600' : 'text-emerald-600')}>
                        {fmtMoney(s.usage.grossProfit, s.currency)}
                        {s.usage.creditsUsed > 0 && s.usage.grossMarginPercent != null && <span className="block text-xs font-normal">{s.usage.grossMarginPercent}%</span>}
                      </span>
                    ),
                  },
                ]
              : []),
            { key: 'f', header: 'Payment fee', cell: (s) => <span className="tabular-nums text-slate-500">{fmtMoney(s.paymentFee, s.currency)}</span> },
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
            { key: 'id', header: 'Request ID', cell: (l) => <span className="font-mono text-xs text-slate-400">{l.requestId?.slice(0, 12)}</span> },
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
          ['Customer revenue (SMS sent)', d ? fmtMoney(d.smsProfit.revenue, cur) : '—', Banknote],
          ['Provider cost', d ? fmtMoney(d.smsProfit.providerCost, cur) : '—', ShoppingCart],
          ['Gross profit', d?.smsProfit.grossProfit != null ? `${fmtMoney(d.smsProfit.grossProfit, cur)} · ${d.smsProfit.grossMarginPercent}%` : '—', TrendingUp],
          ['Net cash profit', d?.money.netProfit != null ? fmtMoney(d.money.netProfit, cur) : '—', Calculator],
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

/** One SMS: what the customer paid for its segments, which provider and stock lots carried it, and the gross profit. */
export function SmsFinancialsModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['admin', 'finance', 'sms', id], queryFn: () => businessService.smsFinancials(id!), enabled: !!id });
  const d = q.data;
  const m = (v: string | null | undefined) => (v == null ? '—' : fmtMoney(v, d?.currency ?? 'RWF'));
  const STATE = { REALIZED: { color: 'green', label: 'Realized' }, PENDING: { color: 'amber', label: 'Pending — waiting for a provider' }, NOT_CHARGED: { color: 'gray', label: 'Not charged (refunded)' } } as const;
  return (
    <Modal open={!!id} onClose={onClose} size="lg" title="SMS gross profit" description={d ? `${d.phone} · ${d.organization.name}` : undefined}>
      {q.isLoading || !d ? (
        q.error ? <ErrorState error={q.error} /> : <Skeleton className="h-48" />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={d.status} />
            <Badge color={STATE[d.state].color}>{STATE[d.state].label}</Badge>
            <span className="text-slate-500">{d.provider ? `via ${d.provider.name}` : 'No provider'} · {fmtNumber(d.segments)} segment{d.segments === 1 ? '' : 's'}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ['Customer revenue', m(d.revenue), `${fmtNumber(d.credits)} × ${m(d.customerPricePerCredit)}`, 'text-slate-900'],
              ['Provider cost', m(d.providerCost), `${fmtNumber(d.segments)} × ${m(d.providerCostPerSegment)}`, 'text-amber-700'],
              ['Gross profit', m(d.grossProfit), Number(d.grossProfit) < 0 ? 'Loss on this SMS' : 'Revenue − cost', profitTone(d.grossProfit)],
              ['Gross margin', d.grossMarginPercent != null ? `${d.grossMarginPercent}%` : '—', 'Profit ÷ revenue', profitTone(d.grossProfit)],
            ].map(([label, value, hint, tone]) => (
              <div key={label} className="rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
                <p className="text-xs text-slate-500">{label}</p>
                <p className={cn('mt-0.5 text-lg font-semibold tabular-nums', tone)}>{value}</p>
                <p className="text-xs text-slate-500">{hint}</p>
              </div>
            ))}
          </div>
          {!d.realized && <p className="text-xs text-slate-500">Not counted in gross profit: {d.state === 'PENDING' ? 'no provider has accepted it yet (credits reserved).' : 'it was never accepted by a provider, so the credits were refunded.'}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="label">Customer credits used</p>
              <ul className="space-y-1 text-sm">
                {d.revenueLots.length ? (
                  d.revenueLots.map((l) => (
                    <li key={l.lotId} className="flex justify-between gap-3">
                      <span className="text-slate-600">{fmtNumber(l.credits)} × {l.unitPrice ? m(l.unitPrice) : 'free credit'}<span className="block text-xs text-slate-400">{l.reference ?? l.source} {l.purchasedAt ? `· ${fmtDate(l.purchasedAt)}` : ''}</span></span>
                      <span className="tabular-nums">{m((Number(l.unitPrice ?? 0) * l.credits).toFixed(4))}</span>
                    </li>
                  ))
                ) : (
                  <li className="text-xs text-slate-500">Sent before per-lot tracking: valued at the customer's average purchase price.</li>
                )}
              </ul>
            </div>
            <div>
              <p className="label">Provider stock consumed</p>
              <ul className="space-y-1 text-sm">
                {d.costLots.length ? (
                  d.costLots.map((l) => (
                    <li key={l.lotId} className="flex justify-between gap-3">
                      <span className="text-slate-600">{fmtNumber(l.segments)} × {m(l.unitCost)}<span className="block text-xs text-slate-400">{l.reference} {l.purchasedAt ? `· bought ${fmtDate(l.purchasedAt)}` : ''}</span></span>
                      <span className="tabular-nums">{m(l.cost)}</span>
                    </li>
                  ))
                ) : (
                  <li className="text-xs text-slate-500">{d.provider ? 'Sent before per-lot tracking: cost recorded at routing time.' : 'No stock consumed.'}</li>
                )}
              </ul>
            </div>
          </div>
          <p className="text-xs text-slate-500">Prices and costs are frozen when the SMS is sent: later price changes never change these figures.</p>
        </div>
      )}
    </Modal>
  );
}
