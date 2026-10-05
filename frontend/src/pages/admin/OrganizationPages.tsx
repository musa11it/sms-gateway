import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ban, Building2, Coins, CreditCard, FileCheck2, MoreHorizontal, Play, Plus, Send, ShieldCheck, UserCog, Users } from 'lucide-react';
import type { AdminUser } from '@/services/adminService';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button, IconButton, LinkButton } from '@/components/ui/Button';
import { Card, StatCard } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Overlay';
import { DataTable, Pagination } from '@/components/ui/Table';
import { Avatar, DescriptionList, Dropdown, MenuItem, PageHeader, Tabs } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { useMe, usePermissions } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { adminService } from '@/services/adminService';
import { businessService } from '@/services/businessService';
import { cn, fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtRelative, titleCase } from '@/utils/format';
import { TX_LABEL } from '../wallet/WalletPages';
import { OrganizationApiAccess } from './IntegrationPages';
import { CreateOrganizationModal, GiveAccessModal } from './ProvisioningModals';

export function AdjustWalletModal({ organizationId, organizationName, open, onClose }: { organizationId: string; organizationName: string; open: boolean; onClose: () => void }) {
  const { canAdmin } = usePermissions();
  const [kind, setKind] = useState<'CREDIT' | 'DEBIT' | 'REFUND'>(canAdmin('wallet.adjust') ? 'CREDIT' : 'REFUND');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const m = useApiMutation(() => adminService.adjustWallet(organizationId, { kind, amount: Number(amount), reason, reference }), {
    success: (t) => `Wallet adjusted — new balance ${fmtNumber(t.balanceAfter)}`,
    invalidate: [['admin', 'org', organizationId], ['admin', 'ledger'], ['admin', 'wallets']],
    onSuccess: () => { onClose(); setAmount(''); setReason(''); setReference(''); },
  });
  const valid = Number(amount) > 0 && Number.isInteger(Number(amount)) && reason.trim().length >= 5 && /^[\w\-./#]{3,}$/.test(reference);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Adjust wallet"
      description={organizationName}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={kind === 'DEBIT' ? 'danger' : 'primary'} disabled={!valid} loading={m.isPending} onClick={() => m.mutate(undefined)}>{kind === 'DEBIT' ? 'Deduct credits' : 'Add credits'}</Button></>}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {(['CREDIT', 'DEBIT', 'REFUND'] as const).map((k) => {
            const allowed = k === 'REFUND' ? canAdmin('wallet.refund') : canAdmin('wallet.adjust');
            return (
              <button key={k} disabled={!allowed} onClick={() => setKind(k)} className={cn('rounded-lg border px-3 py-2 text-sm font-medium transition disabled:opacity-40', kind === k ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>
                {titleCase(k)}
              </button>
            );
          })}
        </div>
        <Field label="Credits" required><Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Reason" required hint="Visible to the customer in their ledger."><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Goodwill credit for delivery outage" /></Field>
        <Field label="Reference" required hint="Ticket or document number. Each reference can be used once."><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="TKT-1042" className="font-mono" /></Field>
        <Alert tone="info">This adjustment is recorded in the immutable ledger and the audit log with your name.</Alert>
      </div>
    </Modal>
  );
}

export function OrganizationsPage() {
  const navigate = useNavigate();
  const { canAdmin } = usePermissions();
  const [adding, setAdding] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const debounced = useDebounce(search);
  const q = useQuery({ queryKey: ['admin', 'orgs', { page, debounced, status }], queryFn: () => adminService.organizations({ page, limit: 20, search: debounced || undefined, status: status || undefined }), placeholderData: (p) => p });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Organizations"
        description="All customer accounts on the platform."
        actions={canAdmin('organizations.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add organization</Button>}
      />
      <CreateOrganizationModal open={adding} onClose={() => setAdding(false)} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
          <Input placeholder="Search name or registration no…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="max-w-xs" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All statuses</option>
            {['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          onRowClick={(o) => navigate(`/admin/organizations/${o.id}`)}
          columns={[
            { key: 'name', header: 'Organization', cell: (o) => <span className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-600">{o.name.slice(0, 2).toUpperCase()}</span><span><span className="block font-medium text-slate-900">{o.name}</span><span className="text-xs text-slate-500">{o.businessType ?? '—'}</span></span></span> },
            { key: 'owner', header: 'Owner', cell: (o) => o.owner ? <span><span className="block">{o.owner.fullName}</span><span className="text-xs text-slate-500">{o.owner.email}</span></span> : '—' },
            { key: 'status', header: 'Status', cell: (o) => <StatusBadge status={o.status} /> },
            { key: 'balance', header: 'Balance', cell: (o) => <span className="tabular-nums">{fmtNumber(o.balance)}</span> },
            { key: 'members', header: 'Members', cell: (o) => o.memberCount },
            { key: 'created', header: 'Joined', cell: (o) => <span className="text-slate-500">{fmtDate(o.createdAt)}</span> },
          ]}
          empty={<EmptyState icon={<Building2 />} title="No organizations found" />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

/** Per-business activity for Super Admin: campaigns, API usage, invoices and audit trail. */
function OrgActivityTab({ organizationId, tab }: { organizationId: string; tab: 'campaigns' | 'api' | 'invoices' | 'audit' }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const params = { page, limit: 15, organizationId };
  const campaigns = useQuery({ queryKey: ['admin', 'org-campaigns', organizationId, page], queryFn: () => adminService.campaigns(params), enabled: tab === 'campaigns' });
  const api = useQuery({ queryKey: ['admin', 'org-api', organizationId, page], queryFn: () => businessService.apiLogs(params), enabled: tab === 'api' });
  const invoices = useQuery({ queryKey: ['admin', 'org-invoices', organizationId, page], queryFn: () => adminService.invoices(params), enabled: tab === 'invoices' });
  const audit = useQuery({ queryKey: ['admin', 'org-audit', organizationId, page], queryFn: () => adminService.auditLogs(params), enabled: tab === 'audit' });
  return (
    <Card padded={false}>
      {tab === 'campaigns' && (
        <>
          <DataTable
            rows={campaigns.data?.data}
            loading={campaigns.isLoading}
            columns={[
              { key: 'n', header: 'Campaign', cell: (c) => c.name },
              { key: 's', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
              { key: 'r', header: 'Recipients', cell: (c) => fmtNumber(c.stats.recipients) },
              { key: 'd', header: 'Delivered / failed', cell: (c) => `${fmtNumber(c.stats.delivered)} / ${fmtNumber(c.stats.failed)}` },
              { key: 'c', header: 'Created', cell: (c) => fmtDateTime(c.createdAt) },
            ]}
            empty={<EmptyState title="No campaigns" className="py-8" />}
          />
          <Pagination pagination={campaigns.data?.pagination} onPage={setPage} />
        </>
      )}
      {tab === 'api' && (
        <>
          <OrganizationApiAccess organizationId={organizationId} />
          <DataTable
            rows={api.data?.data}
            loading={api.isLoading}
            columns={[
              { key: 't', header: 'Time', cell: (l) => fmtDateTime(l.createdAt) },
              { key: 'r', header: 'Request', cell: (l) => <span className="font-mono text-xs">{l.method} {l.path}</span> },
              { key: 's', header: 'Status', cell: (l) => <Badge color={l.statusCode < 400 ? 'green' : 'red'}>{l.statusCode}{l.errorCode ? ` · ${l.errorCode}` : ''}</Badge> },
              { key: 'k', header: 'Key', cell: (l) => <span className="font-mono text-xs">{l.apiKey?.prefix ?? '—'}</span> },
              { key: 'd', header: 'Duration', cell: (l) => `${l.durationMs} ms` },
            ]}
            empty={<EmptyState title="No API requests" className="py-8" />}
          />
          <Pagination pagination={api.data?.pagination} onPage={setPage} />
        </>
      )}
      {tab === 'invoices' && (
        <>
          <DataTable
            rows={invoices.data?.data}
            loading={invoices.isLoading}
            onRowClick={(i) => navigate(`/admin/payments/invoices/${i.id}`)}
            columns={[
              { key: 'n', header: 'Invoice', cell: (i) => <span className="font-mono">{i.number}</span> },
              { key: 'd', header: 'Description', cell: (i) => i.description },
              { key: 't', header: 'Total', cell: (i) => fmtMoney(i.total, i.currency) },
              { key: 's', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
              { key: 'dt', header: 'Issued', cell: (i) => fmtDate(i.issuedAt) },
            ]}
            empty={<EmptyState title="No invoices" className="py-8" />}
          />
          <Pagination pagination={invoices.data?.pagination} onPage={setPage} />
        </>
      )}
      {tab === 'audit' && (
        <>
          <DataTable
            rows={audit.data?.data}
            loading={audit.isLoading}
            columns={[
              { key: 't', header: 'Time', cell: (a) => fmtDateTime(a.createdAt) },
              { key: 'a', header: 'Action', cell: (a) => <Badge color="violet">{a.action}</Badge> },
              { key: 'u', header: 'Actor', cell: (a) => (a.actorType === 'USER' ? a.actor?.fullName ?? a.actorEmail : a.actorType === 'API_KEY' ? 'API key' : 'System') },
              { key: 'r', header: 'Resource', cell: (a) => titleCase(a.resource) },
              { key: 'ip', header: 'IP', cell: (a) => <span className="font-mono text-xs">{a.ipAddress ?? '—'}</span> },
            ]}
            empty={<EmptyState title="No audit records" className="py-8" />}
          />
          <Pagination pagination={audit.data?.pagination} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

export function OrganizationDetailPage() {
  const { id } = useParams();
  const { canAdmin } = usePermissions();
  const q = useQuery({ queryKey: ['admin', 'org', id], queryFn: () => adminService.organization(id!) });
  const [tab, setTab] = useState<'overview' | 'members' | 'senders' | 'ledger' | 'payments' | 'campaigns' | 'api' | 'invoices' | 'audit'>('overview');
  const [adjust, setAdjust] = useState(false);
  const [giveAccess, setGiveAccess] = useState(false);
  const [statusAction, setStatusAction] = useState<'suspend' | 'reactivate' | null>(null);
  const [ledgerPage, setLedgerPage] = useState(1);
  const ledger = useQuery({ queryKey: ['admin', 'ledger', id, ledgerPage], queryFn: () => adminService.ledger({ page: ledgerPage, limit: 15, organizationId: id }), enabled: tab === 'ledger' });
  const payments = useQuery({ queryKey: ['admin', 'payments', 'org', id], queryFn: () => adminService.payments({ page: 1, limit: 20, organizationId: id }), enabled: tab === 'payments' });
  const setStatus = useApiMutation((reason?: string) => adminService.setOrganizationStatus(id!, statusAction!, reason), {
    success: statusAction === 'suspend' ? 'Organization suspended' : 'Organization reactivated',
    invalidate: [['admin', 'org', id], ['admin', 'orgs']],
    onSuccess: () => setStatusAction(null),
  });
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const o = q.data;
  const verification = o.verifications[0];
  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Organizations', to: '/admin/organizations' }, { label: o.name }]}
        title={<span className="flex flex-wrap items-center gap-3">{o.name}<StatusBadge status={o.status} /></span>}
        description={<>Joined {fmtDate(o.createdAt)}{o.approvedAt && <> · approved {fmtDate(o.approvedAt)}</>}</>}
        actions={
          <>
            {verification && canAdmin('verification.view') && <LinkButton to={`/admin/verification/${verification.id}`} variant="secondary" icon={<FileCheck2 className="h-4 w-4" />}>Verification</LinkButton>}
            {(canAdmin('wallet.adjust') || canAdmin('wallet.refund')) && <Button variant="secondary" icon={<Coins className="h-4 w-4" />} onClick={() => setAdjust(true)}>Adjust wallet</Button>}
            {canAdmin('organizations.suspend') && (o.status === 'SUSPENDED'
              ? <Button variant="success" icon={<Play className="h-4 w-4" />} onClick={() => setStatusAction('reactivate')}>Reactivate</Button>
              : <Button variant="danger" icon={<Ban className="h-4 w-4" />} onClick={() => setStatusAction('suspend')}>Suspend</Button>)}
          </>
        }
      />
      {o.status === 'SUSPENDED' && <Alert tone="danger" title="Suspended">{o.statusReason} — sending, campaigns and API access are blocked; billing history remains visible to the customer.</Alert>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Wallet balance" icon={<Coins />} value={fmtNumber(o.wallet?.balance)} />
        <StatCard label="Messages (all time)" icon={<Send />} tone="sky" value={fmtNumber(o.stats.smsTotal)} />
        <StatCard label="Revenue" icon={<CreditCard />} tone="emerald" value={fmtMoney(o.stats.revenue, 'RWF')} hint={`${o.stats.payments} payments`} />
        <StatCard label="Team" icon={<Users />} tone="violet" value={o.members.length} hint={`${o._count.apiKeys} API keys · ${o._count.webhooks} webhooks`} />
      </div>
      <Tabs
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'members', label: 'Members', count: o.members.length },
          { value: 'senders', label: 'Sender IDs', count: o.senders.length },
          { value: 'ledger', label: 'Wallet ledger' },
          { value: 'payments', label: 'Payments' },
          { value: 'invoices', label: 'Invoices' },
          { value: 'campaigns', label: 'Campaigns' },
          { value: 'api', label: 'API usage' },
          { value: 'audit', label: 'Audit log' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'overview' && (
        <Card>
          <DescriptionList
            items={[
              { label: 'Business type', value: o.businessType },
              { label: 'Registration no.', value: o.registrationNumber },
              { label: 'Tax ID', value: o.taxId },
              { label: 'Country / city', value: [o.country, o.city].filter(Boolean).join(' / ') },
              { label: 'Address', value: o.address },
              { label: 'Website', value: o.website },
              { label: 'Contact person', value: o.contactPersonName },
              { label: 'Contact phone / email', value: [o.contactPersonPhone, o.contactPersonEmail].filter(Boolean).join(' · ') },
              { label: 'Expected monthly volume', value: o.expectedMonthlyVolume ? fmtNumber(o.expectedMonthlyVolume) : null },
              { label: 'Verification', value: verification ? <StatusBadge status={verification.status} /> : '—' },
              { label: 'Purpose of SMS', value: o.smsPurpose },
              { label: 'Contacts / campaigns', value: `${fmtNumber(o._count.contacts)} / ${fmtNumber(o._count.campaigns)}` },
            ]}
          />
        </Card>
      )}
      {tab === 'members' && (
        <Card padded={false}>
          {canAdmin('organizations.create') && (
            <div className="flex justify-end border-b border-slate-100 p-3">
              <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setGiveAccess(true)}>Give access</Button>
            </div>
          )}
          <GiveAccessModal organizationId={o.id} open={giveAccess} onClose={() => setGiveAccess(false)} />
          <DataTable
            rows={o.members}
            columns={[
              { key: 'u', header: 'User', cell: (m) => <span className="flex items-center gap-3"><Avatar name={m.user.fullName} size="sm" /><span><span className="block font-medium">{m.user.fullName}</span><span className="text-xs text-slate-500">{m.user.email}</span></span></span> },
              { key: 'r', header: 'Role', cell: (m) => (m.isOwner ? <Badge color="violet">Owner</Badge> : <Badge>{m.role.name}</Badge>) },
              { key: 's', header: 'Account', cell: (m) => <StatusBadge status={m.user.status} /> },
              { key: 'l', header: 'Last sign-in', cell: (m) => (m.user.lastLoginAt ? fmtRelative(m.user.lastLoginAt) : 'Never') },
            ]}
          />
        </Card>
      )}
      {tab === 'senders' && (
        <Card padded={false}>
          <DataTable
            rows={o.senders}
            columns={[
              { key: 'n', header: 'Sender', cell: (s) => <span className="font-mono font-medium">{s.name}</span> },
              { key: 's', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
              { key: 'p', header: 'Purpose', cell: (s) => <span className="block max-w-md truncate text-slate-600">{s.purpose}</span> },
              { key: 'd', header: 'Requested', cell: (s) => fmtDate(s.createdAt) },
            ]}
            empty={<EmptyState icon={<ShieldCheck />} title="No sender IDs" className="py-8" />}
          />
          {canAdmin('senders.review') && <div className="border-t border-slate-100 p-3 text-right"><LinkButton to="/admin/senders" variant="ghost" size="sm">Open sender review →</LinkButton></div>}
        </Card>
      )}
      {tab === 'ledger' && (
        <Card padded={false}>
          <DataTable
            rows={ledger.data?.data}
            loading={ledger.isLoading}
            columns={[
              { key: 'd', header: 'Date', cell: (t) => fmtDateTime(t.createdAt) },
              { key: 't', header: 'Type', cell: (t) => <Badge color={TX_LABEL[t.type].color}>{TX_LABEL[t.type].label}</Badge> },
              { key: 'desc', header: 'Description', cell: (t) => <span className="block max-w-sm truncate">{t.description}</span> },
              { key: 'a', header: 'Credits', cell: (t) => <span className={cn('font-semibold tabular-nums', t.amount > 0 ? 'text-emerald-600' : '')}>{t.amount > 0 ? '+' : ''}{fmtNumber(t.amount)}</span> },
              { key: 'b', header: 'Balance', cell: (t) => fmtNumber(t.balanceAfter) },
              { key: 'by', header: 'By', cell: (t) => t.createdBy?.fullName ?? 'System' },
            ]}
            empty={<EmptyState title="No ledger entries" className="py-8" />}
          />
          <Pagination pagination={ledger.data?.pagination} onPage={setLedgerPage} />
        </Card>
      )}
      {tab === 'payments' && (
        <Card padded={false}>
          <DataTable
            rows={payments.data?.data}
            loading={payments.isLoading}
            columns={[
              { key: 'r', header: 'Reference', cell: (p) => <span className="font-mono text-xs">{p.reference}</span> },
              { key: 'p', header: 'Package', cell: (p) => p.packageName },
              { key: 'a', header: 'Amount', cell: (p) => fmtMoney(p.amount, p.currency) },
              { key: 's', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
              { key: 'd', header: 'Date', cell: (p) => fmtDateTime(p.createdAt) },
            ]}
            empty={<EmptyState title="No payments" className="py-8" />}
          />
        </Card>
      )}
      {['campaigns', 'api', 'invoices', 'audit'].includes(tab) && <OrgActivityTab organizationId={o.id} tab={tab as 'campaigns' | 'api' | 'invoices' | 'audit'} />}
      <AdjustWalletModal open={adjust} onClose={() => setAdjust(false)} organizationId={o.id} organizationName={o.name} />
      <ConfirmDialog
        open={!!statusAction}
        onClose={() => setStatusAction(null)}
        tone={statusAction === 'suspend' ? 'danger' : 'success'}
        title={statusAction === 'suspend' ? `Suspend ${o.name}?` : `Reactivate ${o.name}?`}
        description={statusAction === 'suspend' ? 'They will not be able to send SMS, run campaigns, use the API or buy credits. Members are notified.' : 'Messaging will be enabled again.'}
        requireReason={statusAction === 'suspend' ? true : undefined}
        reasonPlaceholder="e.g. Spam complaints under investigation"
        confirmLabel={statusAction === 'suspend' ? 'Suspend' : 'Reactivate'}
        loading={setStatus.isPending}
        onConfirm={(reason) => setStatus.mutate(reason)}
      />
    </div>
  );
}

function StaffModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: adminService.roles, enabled: open });
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const m = useApiMutation(() => adminService.createStaff({ email, fullName, password, roleIds }), { success: 'Staff user created', invalidate: [['admin', 'users']], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Add staff user" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!email || !fullName || password.length < 8 || !roleIds.length} loading={m.isPending} onClick={() => m.mutate(undefined)}>Create user</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
          <Field label="Email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        </div>
        <Field label="Temporary password" required hint="At least 8 characters with a letter and a number. Ask them to change it after first sign-in."><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <div>
          <p className="label">Platform roles</p>
          <div className="space-y-2">{roles.data?.map((r) => <Checkbox key={r.id} label={r.name} description={r.description ?? undefined} checked={roleIds.includes(r.id)} onChange={(e) => setRoleIds((x) => (e.target.checked ? [...x, r.id] : x.filter((i) => i !== r.id)))} />)}</div>
        </div>
      </div>
    </Modal>
  );
}

function RolesModal({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: adminService.roles, enabled: !!user });
  const [roleIds, setRoleIds] = useState<string[] | null>(null);
  const current = roleIds ?? user?.roles.map((r) => r.id) ?? [];
  const m = useApiMutation(() => adminService.setUserRoles(user!.id, current), { success: 'Roles updated', invalidate: [['admin', 'users']], onSuccess: () => { setRoleIds(null); onClose(); } });
  return (
    <Modal open={!!user} onClose={() => { setRoleIds(null); onClose(); }} title="Platform roles" description={user?.email} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={() => m.mutate(undefined)}>Save roles</Button></>}>
      <p className="mb-3 text-sm text-slate-500">You can only grant roles whose permissions you hold yourself.</p>
      <div className="space-y-2">{roles.data?.map((r) => <Checkbox key={r.id} label={r.name} description={r.description ?? undefined} checked={current.includes(r.id)} onChange={(e) => setRoleIds(e.target.checked ? [...current, r.id] : current.filter((i) => i !== r.id))} />)}</div>
    </Modal>
  );
}

export function UsersPage() {
  const { canAdmin } = usePermissions();
  const { data: me } = useMe();
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const [staffOpen, setStaffOpen] = useState(false);
  const [rolesUser, setRolesUser] = useState<AdminUser | null>(null);
  const [action, setAction] = useState<{ user: AdminUser; action: 'suspend' | 'reactivate' | 'deactivate' } | null>(null);
  const q = useQuery({ queryKey: ['admin', 'users', { page, type, status, debounced }], queryFn: () => adminService.users({ page, limit: 20, type: type || undefined, status: status || undefined, search: debounced || undefined }), placeholderData: (p) => p });
  const setStatusM = useApiMutation((reason?: string) => adminService.setUserStatus(action!.user.id, action!.action, reason), { success: 'User updated', invalidate: [['admin', 'users']], onSuccess: () => setAction(null) });
  return (
    <div className="space-y-6">
      <PageHeader title="Users" description="Customers and platform staff." actions={canAdmin('users.create') && canAdmin('roles.assign') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setStaffOpen(true)}>Add staff user</Button>} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
          <Input placeholder="Search name or email…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="max-w-xs" />
          <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-auto"><option value="">All users</option><option value="staff">Staff</option><option value="customer">Customers</option></Select>
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            <option value="">Any status</option>
            {['PENDING_EMAIL_VERIFICATION', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'DEACTIVATED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'u', header: 'User', cell: (u) => <span className="flex items-center gap-3"><Avatar name={u.fullName} size="sm" /><span><span className="block font-medium text-slate-900">{u.fullName}</span><span className="text-xs text-slate-500">{u.email}</span></span></span> },
            { key: 'roles', header: 'Access', cell: (u) => <span className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r.id} color="violet">{r.name}</Badge>)}{u.memberships.map((m) => <Link key={m.organization.id} to={`/admin/organizations/${m.organization.id}`}><Badge>{m.organization.name} · {m.isOwner ? 'Owner' : m.role.name}</Badge></Link>)}</span> },
            { key: 's', header: 'Status', cell: (u) => <StatusBadge status={u.status} /> },
            { key: 'l', header: 'Last sign-in', cell: (u) => <span className="text-slate-500">{u.lastLoginAt ? fmtRelative(u.lastLoginAt) : 'Never'}</span> },
            {
              key: 'act',
              header: '',
              className: 'text-right',
              cell: (u) =>
                u.id !== me?.user.id && (canAdmin('users.suspend') || canAdmin('roles.assign')) && (
                  <Dropdown trigger={<IconButton label="Actions"><MoreHorizontal className="h-4 w-4" /></IconButton>}>
                    {(close) => (
                      <>
                        {canAdmin('roles.assign') && <MenuItem icon={<UserCog />} onClick={() => { close(); setRolesUser(u); }}>Platform roles</MenuItem>}
                        {canAdmin('users.suspend') && (u.status === 'SUSPENDED' || u.status === 'DEACTIVATED'
                          ? <MenuItem icon={<Play />} onClick={() => { close(); setAction({ user: u, action: 'reactivate' }); }}>Reactivate</MenuItem>
                          : <MenuItem icon={<Ban />} danger onClick={() => { close(); setAction({ user: u, action: 'suspend' }); }}>Suspend</MenuItem>)}
                      </>
                    )}
                  </Dropdown>
                ),
            },
          ]}
          empty={<EmptyState icon={<Users />} title="No users found" />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
      <StaffModal open={staffOpen} onClose={() => setStaffOpen(false)} />
      <RolesModal user={rolesUser} onClose={() => setRolesUser(null)} />
      <ConfirmDialog
        open={!!action}
        onClose={() => setAction(null)}
        tone={action?.action === 'reactivate' ? 'success' : 'danger'}
        title={`${titleCase(action?.action ?? '')} ${action?.user.fullName}?`}
        description={action?.action === 'reactivate' ? 'They will be able to sign in again.' : 'All their sessions are signed out immediately.'}
        requireReason={action?.action !== 'reactivate' ? true : undefined}
        confirmLabel={titleCase(action?.action ?? 'Confirm')}
        loading={setStatusM.isPending}
        onConfirm={(r) => setStatusM.mutate(r)}
      />
    </div>
  );
}
