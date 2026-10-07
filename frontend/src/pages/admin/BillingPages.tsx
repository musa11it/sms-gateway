import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Coins, CreditCard, FileText, RefreshCw, Undo2, Wallet } from 'lucide-react';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Form';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { DataTable, Pagination } from '@/components/ui/Table';
import { PageHeader, Tabs } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { adminService } from '@/services/adminService';
import { businessService } from '@/services/businessService';
import { cn, fmtDate, fmtDateTime, fmtMoney, fmtNumber, titleCase } from '@/utils/format';
import { InvoiceView, TX_LABEL } from '../wallet/WalletPages';
import { AdjustWalletModal } from './OrganizationPages';

export function AdminPaymentsPage() {
  const { canAdmin } = usePermissions();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const [refund, setRefund] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['admin', 'payments', { page, status, debounced }], queryFn: () => adminService.payments({ page, limit: 20, status: status || undefined, search: debounced || undefined }), placeholderData: (p) => p });
  const verify = useApiMutation((id: string) => adminService.verifyPayment(id), { success: (p) => `Provider reports: ${p.status}`, invalidate: [['admin', 'payments']] });
  const refundM = useApiMutation((reason?: string) => adminService.refundPayment(refund!, reason ?? ''), { success: 'Refund recorded', invalidate: [['admin', 'payments']], onSuccess: () => setRefund(null) });
  const summary = q.data?.summary ?? [];
  const s = (k: string) => summary.find((x) => x.status === k);
  return (
    <div className="space-y-6">
      <PageHeader title="Payments" description="All payments across the platform. Wallets are credited only after provider verification." />
      <div className="grid gap-4 sm:grid-cols-4">
        {['SUCCESS', 'PROCESSING', 'FAILED', 'REFUNDED'].map((k) => (
          <Card key={k}>
            <p className="text-sm font-medium text-slate-500">{titleCase(k)}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{fmtNumber(s(k)?.count ?? 0)}</p>
            <p className="text-xs text-slate-500">{fmtMoney(s(k)?.amount ?? '0', 'RWF')}</p>
          </Card>
        ))}
      </div>
      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
          <Input placeholder="Search reference…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="max-w-xs" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All statuses</option>
            {['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED'].map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
          </Select>
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'ref', header: 'Reference', cell: (p) => <span><span className="block font-mono text-xs">{p.reference}</span><span className="font-mono text-xs text-slate-400">{p.provider} · {p.providerReference ?? '—'}</span></span> },
            { key: 'org', header: 'Organization', cell: (p) => <Link to={`/admin/organizations/${p.organization?.id}`} className="link">{p.organization?.name}</Link> },
            { key: 'pkg', header: 'Package', cell: (p) => <span>{p.packageName}<span className="block text-xs text-slate-500">{fmtNumber(p.credits)} credits</span></span> },
            { key: 'amt', header: 'Amount', cell: (p) => <span className="font-medium tabular-nums">{fmtMoney(p.amount, p.currency)}</span> },
            { key: 's', header: 'Status', cell: (p) => <span title={p.failureReason ?? undefined}><StatusBadge status={p.status} /></span> },
            { key: 'd', header: 'Created', cell: (p) => <span className="text-slate-500">{fmtDateTime(p.createdAt)}</span> },
            {
              key: 'a',
              header: '',
              className: 'text-right',
              cell: (p) => (
                <span className="flex justify-end gap-1">
                  {canAdmin('payments.verify') && ['PENDING', 'PROCESSING'].includes(p.status) && <Button size="xs" variant="secondary" icon={<RefreshCw className="h-3 w-3" />} loading={verify.isPending && verify.variables === p.id} onClick={() => verify.mutate(p.id)}>Verify</Button>}
                  {canAdmin('payments.refund') && p.status === 'SUCCESS' && <Button size="xs" variant="secondary" icon={<Undo2 className="h-3 w-3" />} onClick={() => setRefund(p.id)}>Refund</Button>}
                </span>
              ),
            },
          ]}
          empty={<EmptyState icon={<CreditCard />} title="No payments" />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
      <ConfirmDialog open={!!refund} onClose={() => setRefund(null)} title="Refund this payment?" description="The purchased credits are removed from the customer’s wallet (they must still be unused) and the invoice is marked refunded. Return the money through the payment provider." requireReason reasonLabel="Refund reason" confirmLabel="Record refund" loading={refundM.isPending} onConfirm={(r) => refundM.mutate(r)} />
    </div>
  );
}

export function AdminInvoicesPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['admin', 'invoices', page], queryFn: () => adminService.invoices({ page, limit: 20 }) });
  return (
    <div className="space-y-6">
      <PageHeader title="Invoices" description="Invoices issued for verified payments." />
      <Card padded={false}>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          onRowClick={(i) => navigate(`/admin/payments/invoices/${i.id}`)}
          columns={[
            { key: 'n', header: 'Invoice', cell: (i) => <span className="font-mono font-medium">{i.number}</span> },
            { key: 'c', header: 'Customer', cell: (i) => i.customerName },
            { key: 'd', header: 'Description', cell: (i) => <span className="block max-w-xs truncate">{i.description}</span> },
            { key: 't', header: 'Total', cell: (i) => <span className="font-medium tabular-nums">{fmtMoney(i.total, i.currency)}</span> },
            { key: 's', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
            { key: 'dt', header: 'Issued', cell: (i) => fmtDate(i.issuedAt) },
          ]}
          empty={<EmptyState icon={<FileText />} title="No invoices" />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

export function AdminInvoicePage() {
  const { id } = useParams();
  return <InvoiceView id={id!} fetcher={adminService.invoice} back="/admin/payments/invoices" onDownload={businessService.invoicePdf} />;
}

export function WalletsPage() {
  const { canAdmin } = usePermissions();
  const [tab, setTab] = useState<'wallets' | 'ledger'>('wallets');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const [type, setType] = useState('');
  const [adjust, setAdjust] = useState<{ id: string; name: string } | null>(null);
  const wallets = useQuery({ queryKey: ['admin', 'wallets', page, debounced], queryFn: () => adminService.wallets({ page, limit: 20, search: debounced || undefined }), enabled: tab === 'wallets' });
  const ledger = useQuery({ queryKey: ['admin', 'ledger', 'all', page, type], queryFn: () => adminService.ledger({ page, limit: 25, type: type || undefined }), enabled: tab === 'ledger' });
  return (
    <div className="space-y-6">
      <PageHeader title="Wallets & ledger" description="Credit balances and every ledger movement across the platform." />
      <Tabs tabs={[{ value: 'wallets', label: 'Wallets' }, { value: 'ledger', label: 'Global ledger' }]} value={tab} onChange={(v) => { setTab(v); setPage(1); }} />
      {tab === 'wallets' ? (
        <Card padded={false}>
          <div className="border-b border-slate-100 p-4"><Input placeholder="Search organization…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="max-w-xs" /></div>
          <DataTable
            rows={wallets.data?.data}
            loading={wallets.isLoading}
            error={wallets.error}
            columns={[
              { key: 'o', header: 'Organization', cell: (w) => <Link to={`/admin/organizations/${w.organization.id}`} className="link">{w.organization.name}</Link> },
              { key: 's', header: 'Status', cell: (w) => <StatusBadge status={w.organization.status} /> },
              { key: 'b', header: 'Balance', cell: (w) => <span className={cn('font-semibold tabular-nums', w.balance < w.lowBalanceThreshold && 'text-amber-600')}>{fmtNumber(w.balance)}</span> },
              { key: 't', header: 'Alert threshold', cell: (w) => <span className="tabular-nums text-slate-500">{fmtNumber(w.lowBalanceThreshold)}</span> },
              { key: 'u', header: 'Updated', cell: (w) => fmtDateTime(w.updatedAt) },
              { key: 'a', header: '', className: 'text-right', cell: (w) => (canAdmin('wallet.adjust') || canAdmin('wallet.refund')) && <Button size="xs" variant="secondary" icon={<Coins className="h-3 w-3" />} onClick={() => setAdjust({ id: w.organization.id, name: w.organization.name })}>Adjust</Button> },
            ]}
            empty={<EmptyState icon={<Wallet />} title="No wallets" />}
          />
          <Pagination pagination={wallets.data?.pagination} onPage={setPage} />
        </Card>
      ) : (
        <Card padded={false}>
          <div className="border-b border-slate-100 p-4">
            <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-auto">
              <option value="">All types</option>
              {Object.entries(TX_LABEL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </div>
          <DataTable
            rows={ledger.data?.data}
            loading={ledger.isLoading}
            error={ledger.error}
            columns={[
              { key: 'd', header: 'Date', cell: (t) => <span className="text-slate-500">{fmtDateTime(t.createdAt)}</span> },
              { key: 'o', header: 'Organization', cell: (t) => <Link to={`/admin/organizations/${t.organization?.id}`} className="link">{t.organization?.name}</Link> },
              { key: 't', header: 'Type', cell: (t) => <Badge color={TX_LABEL[t.type].color}>{TX_LABEL[t.type].label}</Badge> },
              { key: 'desc', header: 'Description', cell: (t) => <span className="block max-w-xs truncate">{t.description}</span> },
              { key: 'a', header: 'Credits', cell: (t) => <span className={cn('font-semibold tabular-nums', t.amount > 0 && 'text-emerald-600')}>{t.amount > 0 ? '+' : ''}{fmtNumber(t.amount)}</span> },
              { key: 'b', header: 'Before → after', cell: (t) => <span className="tabular-nums text-slate-500">{fmtNumber(t.balanceBefore)} → {fmtNumber(t.balanceAfter)}</span> },
              { key: 'by', header: 'Actor', cell: (t) => t.createdBy?.fullName ?? 'System' },
            ]}
            empty={<EmptyState title="No ledger entries" />}
          />
          <Pagination pagination={ledger.data?.pagination} onPage={setPage} />
        </Card>
      )}
      {adjust && <AdjustWalletModal open organizationId={adjust.id} organizationName={adjust.name} onClose={() => setAdjust(null)} />}
    </div>
  );
}
