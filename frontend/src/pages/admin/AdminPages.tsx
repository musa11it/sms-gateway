import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Banknote, Building2, CheckCircle2, Clock, CreditCard, FileCheck2, Gauge, Megaphone, RotateCcw, Send, ShieldCheck, XCircle } from 'lucide-react';
import { GrowthChart, RevenueChart, SmsTrendChart, StatusDonut } from '@/components/charts/Charts';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { EmptyState, ErrorState, PageLoader, Skeleton } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Form';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { DataTable, Pagination } from '@/components/ui/Table';
import { PageHeader } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions, useSystemInfo } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { adminService } from '@/services/adminService';
import { fmtMoney, fmtNumber, fmtRelative, titleCase } from '@/utils/format';
import { MessageDrawer, recipientColumns } from '../sms/SmsPages';
import { RangePicker, useRange } from '../dashboard/ReportsPage';
import { AdminBusinessSummary } from './BusinessPages';
import { SegmentationSummaryCard } from './SmsConfigurationPage';

export function AdminDashboardPage() {
  const { canAdmin } = usePermissions();
  const { data: sys } = useSystemInfo();
  const q = useQuery({ queryKey: ['admin', 'dashboard'], queryFn: adminService.dashboard, refetchInterval: 20_000 });
  const d = q.data;
  if (q.error) return <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform overview"
        description={<>Live view of customers, traffic and revenue.{sys && <> SMS provider: <Badge color={sys.smsSimulation ? 'amber' : 'green'}>{sys.smsSimulation ? 'Simulation (no real SMS)' : sys.smsProvider}</Badge></>}</>}
      />
      <AdminBusinessSummary />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total organizations" icon={<Building2 />} value={fmtNumber(d?.organizations.total)} loading={q.isLoading} hint={`${fmtNumber(d?.organizations.suspended)} suspended`} />
        <StatCard label="Active organizations" icon={<CheckCircle2 />} tone="emerald" value={fmtNumber(d?.organizations.active)} loading={q.isLoading} />
        <StatCard label="Pending verification" icon={<FileCheck2 />} tone="amber" value={fmtNumber(d?.pendingVerification)} loading={q.isLoading} hint={canAdmin('verification.view') && d?.pendingVerification ? <Link to="/admin/verification" className="link">Review queue →</Link> : undefined} />
        <StatCard label="Pending sender IDs" icon={<ShieldCheck />} tone="violet" value={fmtNumber(d?.pendingSenders)} loading={q.isLoading} hint={canAdmin('senders.view') && d?.pendingSenders ? <Link to="/admin/senders" className="link">Review →</Link> : undefined} />
        <StatCard label="SMS sent today" icon={<Send />} tone="sky" value={fmtNumber(d?.smsToday.total)} loading={q.isLoading} hint={`${fmtNumber(d?.smsToday.pending)} pending`} />
        <StatCard label="Delivered today" icon={<CheckCircle2 />} tone="emerald" value={fmtNumber(d?.smsToday.delivered)} loading={q.isLoading} hint={d?.smsToday.deliveryRate != null ? `${d.smsToday.deliveryRate}% of final outcomes` : 'no final outcomes yet'} />
        <StatCard label="Failed today" icon={<XCircle />} tone="red" value={fmtNumber(d?.smsToday.failed)} loading={q.isLoading} />
        <StatCard label="Revenue (30 days)" icon={<Banknote />} tone="emerald" value={d ? fmtMoney(d.revenue30d.amount, d.currency) : '—'} loading={q.isLoading} hint={<>{fmtNumber(d?.revenue30d.creditsSold)} credits sold · {fmtNumber(d?.pendingPayments)} pending payments</>} />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card padded={false} className="xl:col-span-2">
          <CardHeader title="SMS usage" description="Last 30 days, all organizations" />
          <div className="p-4">{q.isLoading ? <Skeleton className="h-[260px]" /> : <SmsTrendChart data={d?.series ?? []} />}</div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Delivery status" description="Last 30 days" />
          <div className="p-4">{q.isLoading ? <Skeleton className="h-[200px]" /> : <StatusDonut delivered={d?.deliveryStatus30d.delivered ?? 0} failed={d?.deliveryStatus30d.failed ?? 0} pending={d?.deliveryStatus30d.pending ?? 0} />}</div>
        </Card>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card padded={false}>
          <CardHeader title="Revenue" description="Verified payments, last 30 days" />
          <div className="p-4">{q.isLoading ? <Skeleton className="h-[240px]" /> : <RevenueChart data={d?.revenueSeries ?? []} currency={d?.currency ?? 'RWF'} height={240} />}</div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Customer growth" description="Sign-ups vs approvals" />
          <div className="p-4">{q.isLoading ? <Skeleton className="h-[240px]" /> : <GrowthChart data={d?.growth ?? []} height={240} />}</div>
        </Card>
      </div>
      <SegmentationSummaryCard />
    </div>
  );
}

export function SmsTrafficPage() {
  const { canAdmin } = usePermissions();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const [selected, setSelected] = useState<string | null>(null);
  const [retry, setRetry] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['admin', 'sms', { page, status, debounced }],
    queryFn: () => adminService.smsMessages({ page, limit: 25, status: status || undefined, search: debounced || undefined }),
    refetchInterval: 5000,
    placeholderData: (p) => p,
  });
  const retryM = useApiMutation((id: string) => adminService.retrySms(id), { success: 'Message re-queued', invalidate: [['admin', 'sms']], onSuccess: () => setRetry(null) });
  return (
    <div className="space-y-6">
      <PageHeader title="SMS traffic" description="All messages across the platform, with live delivery status." />
      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
          <Input placeholder="Phone or provider message ID…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="max-w-xs" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All statuses</option>
            {['QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED', 'CANCELLED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          onRowClick={(r) => setSelected(r.id)}
          columns={[
            ...recipientColumns([{ key: 'org', header: 'Organization', cell: (m) => <Link to={`/admin/organizations/${m.organization?.id}`} onClick={(e) => e.stopPropagation()} className="link">{m.organization?.name}</Link> }]),
            { key: 'err', header: 'Error', cell: (m) => <span className="text-xs text-red-600">{m.errorCode}</span> },
            {
              key: 'act',
              header: '',
              className: 'text-right',
              cell: (m) => canAdmin('sms.retry') && ['FAILED', 'EXPIRED'].includes(m.status) && (
                <Button size="xs" variant="secondary" icon={<RotateCcw className="h-3 w-3" />} onClick={(e) => { e.stopPropagation(); setRetry(m.id); }}>Retry</Button>
              ),
            },
          ]}
          empty={<EmptyState icon={<Send />} title="No messages" />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
      <MessageDrawer id={selected} onClose={() => setSelected(null)} fetcher={adminService.smsMessage} />
      <ConfirmDialog open={!!retry} onClose={() => setRetry(null)} tone="primary" title="Retry this message?" description="It will be re-submitted to the provider. If its credits were refunded, they are charged again." confirmLabel="Retry" loading={retryM.isPending} onConfirm={() => retry && retryM.mutate(retry)} />
    </div>
  );
}

export function AdminCampaignsPage() {
  const { canAdmin } = usePermissions();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [cancel, setCancel] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['admin', 'campaigns', page, status], queryFn: () => adminService.campaigns({ page, limit: 20, status: status || undefined }), refetchInterval: 10_000 });
  const cancelM = useApiMutation((id: string) => adminService.cancelCampaign(id), { success: 'Campaign cancelled', invalidate: [['admin', 'campaigns']], onSuccess: () => setCancel(null) });
  return (
    <div className="space-y-6">
      <PageHeader title="Campaigns" description="Campaigns across all organizations." />
      <Card padded={false}>
        <div className="border-b border-slate-100 p-4">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All statuses</option>
            {['DRAFT', 'SCHEDULED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'name', header: 'Campaign', cell: (c) => <span className="font-medium text-slate-900">{c.name}</span> },
            { key: 'org', header: 'Organization', cell: (c) => <Link to={`/admin/organizations/${c.organization?.id}`} className="link">{c.organization?.name}</Link> },
            { key: 'sender', header: 'Sender', cell: (c) => <Badge>{c.sender.name}</Badge> },
            { key: 'status', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
            { key: 'rcpt', header: 'Recipients', cell: (c) => fmtNumber(c.stats.recipients) },
            { key: 'del', header: 'Delivered / failed', cell: (c) => <span className="tabular-nums"><span className="text-emerald-600">{fmtNumber(c.stats.delivered)}</span> / <span className="text-red-600">{fmtNumber(c.stats.failed)}</span></span> },
            { key: 'when', header: 'Created', cell: (c) => <span className="text-slate-500">{fmtRelative(c.createdAt)}</span> },
            { key: 'act', header: '', className: 'text-right', cell: (c) => canAdmin('campaigns.cancel') && ['DRAFT', 'SCHEDULED'].includes(c.status) && <Button size="xs" variant="secondary" onClick={() => setCancel(c.id)}>Cancel</Button> },
          ]}
          empty={<EmptyState icon={<Megaphone />} title="No campaigns" />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
      <ConfirmDialog open={!!cancel} onClose={() => setCancel(null)} title="Cancel this campaign?" description="Scheduled campaigns are refunded in full to the customer." confirmLabel="Cancel campaign" loading={cancelM.isPending} onConfirm={() => cancel && cancelM.mutate(cancel)} />
    </div>
  );
}

export function AdminReportsPage() {
  const r = useRange();
  const q = useQuery({ queryKey: ['admin', 'overview', r.params], queryFn: () => adminService.overview(r.params) });
  const d = q.data;
  if (q.isLoading) return <PageLoader />;
  if (q.error || !d) return <Card><ErrorState error={q.error} /></Card>;
  return (
    <div className="space-y-6">
      <PageHeader title="Platform reports" description="Revenue, volume, delivery and provider performance." actions={<RangePicker {...r} />} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Customers" icon={<Building2 />} value={fmtNumber(d.customers.total)} hint={`${fmtNumber(d.customers.active)} active`} />
        <StatCard label="SMS volume" icon={<Send />} tone="sky" value={fmtNumber(d.sms.total)} hint={`${fmtNumber(d.sms.creditsConsumed)} credits consumed`} />
        <StatCard label="SMS revenue" icon={<CreditCard />} tone="emerald" value={fmtMoney(d.revenue.amount, d.currency)} hint={`${fmtNumber(d.revenue.creditsSold)} credits sold · ${d.revenue.payments} payments`} />
        <StatCard label="Delivery rate" icon={<Gauge />} tone="violet" value={d.sms.deliveryRate != null ? `${d.sms.deliveryRate}%` : '—'} hint={d.sms.deliveryRate != null ? `over ${fmtNumber(d.sms.deliveryRateBasis.final)} final outcomes; ${fmtNumber(d.sms.failed)} failed` : 'insufficient final outcomes'} />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card padded={false}><CardHeader title="SMS volume" /><div className="p-4"><SmsTrendChart data={d.series} /></div></Card>
        <Card padded={false}><CardHeader title="Revenue" /><div className="p-4"><RevenueChart data={d.revenueSeries} currency={d.currency} /></div></Card>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card padded={false}>
          <CardHeader title="Top organizations" description="By message volume" />
          <DataTable
            rows={d.topOrganizations}
            columns={[
              { key: 'name', header: 'Organization', cell: (o) => <Link to={`/admin/organizations/${o.id}`} className="link">{o.name}</Link> },
              { key: 'msgs', header: 'Messages', cell: (o) => <span className="tabular-nums">{fmtNumber(o.messages)}</span> },
              { key: 'credits', header: 'Credits', cell: (o) => <span className="tabular-nums">{fmtNumber(o.credits)}</span> },
            ]}
            empty={<EmptyState title="No traffic in this period" className="py-8" />}
          />
        </Card>
        <Card padded={false}>
          <CardHeader title="Provider performance" />
          <DataTable
            rows={d.providers.map((p) => ({ ...p, id: p.provider }))}
            columns={[
              { key: 'p', header: 'Provider', cell: (p) => <Badge color={p.provider === 'simulation' ? 'amber' : 'blue'}>{p.provider}</Badge> },
              { key: 't', header: 'Messages', cell: (p) => fmtNumber(p.total) },
              { key: 'r', header: 'Delivery rate', cell: (p) => (p.deliveryRate != null ? `${p.deliveryRate}%` : '—') },
              { key: 'f', header: 'Failed', cell: (p) => <span className="text-red-600">{fmtNumber(p.failed)}</span> },
              { key: 'l', header: 'Avg. delivery time', cell: (p) => (p.avgDeliveryLatencyMs != null ? `${(p.avgDeliveryLatencyMs / 1000).toFixed(1)} s` : '—') },
            ]}
            empty={<EmptyState icon={<AlertTriangle />} title="No provider traffic" className="py-8" />}
          />
        </Card>
      </div>
      <Card padded={false}><CardHeader title="Customer growth" /><div className="p-4"><GrowthChart data={d.growth} /></div></Card>
      <p className="flex items-center gap-1.5 text-xs text-slate-400"><Clock className="h-3.5 w-3.5" /> Delivery rate only counts messages with a final delivery outcome. Pending messages are excluded.</p>
    </div>
  );
}
