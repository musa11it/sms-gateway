import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Eye, FileCheck2, FileText, Info, RefreshCcw, ShieldCheck, X } from 'lucide-react';
import { toast } from 'sonner';
import { downloadFile, errorMessage } from '@/api/client';
import type { SenderId } from '@/api/types';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Form';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { DataTable, Pagination } from '@/components/ui/Table';
import { DescriptionList, PageHeader, Tabs } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { adminService } from '@/services/adminService';
import { fmtBytes, fmtDate, fmtDateTime, fmtRelative, titleCase } from '@/utils/format';

export function VerificationQueuePage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<string>('');
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['admin', 'verifications', status, page], queryFn: () => adminService.verifications({ page, limit: 20, status: status || undefined }), refetchInterval: 20_000 });
  return (
    <div className="space-y-6">
      <PageHeader title="Verification" description="Review business verification submissions (KYB)." />
      <Tabs
        tabs={[
          { value: '', label: 'Needs review' },
          { value: 'MORE_INFORMATION_REQUIRED', label: 'More info required' },
          { value: 'SUSPENDED', label: 'Suspended' },
          { value: 'APPROVED', label: 'Approved' },
          { value: 'REJECTED', label: 'Rejected' },
        ]}
        value={status}
        onChange={(v) => { setStatus(v); setPage(1); }}
      />
      <Card padded={false}>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          onRowClick={(v) => navigate(`/admin/verification/${v.id}`)}
          columns={[
            { key: 'org', header: 'Organization', cell: (v) => <span><span className="block font-medium text-slate-900">{v.organization.name}</span><span className="text-xs text-slate-500">{v.organization.businessType ?? '—'} · {v.organization.country ?? '—'}</span></span> },
            { key: 'status', header: 'Status', cell: (v) => <StatusBadge status={v.status} /> },
            { key: 'docs', header: 'Documents', cell: (v) => <Badge>{v._count.documents} file(s)</Badge> },
            { key: 'sub', header: 'Submitted', cell: (v) => (v.submittedAt ? <span title={fmtDateTime(v.submittedAt)}>{fmtRelative(v.submittedAt)}</span> : '—') },
            { key: 'go', header: '', className: 'text-right', cell: () => <span className="text-sm font-medium text-brand-600">Review →</span> },
          ]}
          empty={<EmptyState icon={<FileCheck2 />} title="Queue is clear" description="New submissions will appear here." />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

export function VerificationDetailPage() {
  const { id } = useParams();
  const { canAdmin } = usePermissions();
  const q = useQuery({ queryKey: ['admin', 'verification', id], queryFn: () => adminService.verification(id!) });
  const inv = [['admin', 'verification', id], ['admin', 'verifications'], ['admin', 'dashboard']];
  const start = useApiMutation(() => adminService.startReview(id!), { success: 'Review started', invalidate: inv });
  const [docAction, setDocAction] = useState<{ id: string; decision: 'APPROVED' | 'REJECTED' | 'REPLACEMENT_REQUESTED' } | null>(null);
  const reviewDoc = useApiMutation((note?: string) => adminService.reviewDocument(docAction!.id, docAction!.decision, note), { success: 'Document reviewed', invalidate: inv, onSuccess: () => setDocAction(null) });
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT' | 'REQUEST_INFORMATION' | null>(null);
  const decide = useApiMutation((note?: string) => adminService.decideVerification(id!, decision!, note), { success: 'Decision recorded — the customer has been notified', invalidate: inv, onSuccess: () => setDecision(null) });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const v = q.data;
  const org = v.organization;
  const owner = org.members[0]?.user;
  const open = ['SUBMITTED', 'UNDER_REVIEW'].includes(v.status);
  const label = (type: string) => v.requirements.find((r) => r.type === type)?.label ?? titleCase(type);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Verification', to: '/admin/verification' }, { label: org.name }]}
        title={<span className="flex flex-wrap items-center gap-3">{org.name}<StatusBadge status={v.status} /></span>}
        description={v.submittedAt ? `Submitted ${fmtDateTime(v.submittedAt)}` : 'Not submitted yet'}
        actions={
          open && (
            <>
              {v.status === 'SUBMITTED' && canAdmin('verification.review') && <Button variant="secondary" loading={start.isPending} onClick={() => start.mutate(undefined)}>Start review</Button>}
              {canAdmin('verification.review') && <Button variant="secondary" icon={<RefreshCcw className="h-4 w-4" />} onClick={() => setDecision('REQUEST_INFORMATION')}>Request more information</Button>}
              {canAdmin('verification.reject') && <Button variant="danger" icon={<X className="h-4 w-4" />} onClick={() => setDecision('REJECT')}>Reject</Button>}
              {canAdmin('verification.approve') && <Button variant="success" icon={<Check className="h-4 w-4" />} onClick={() => setDecision('APPROVE')}>Approve</Button>}
            </>
          )
        }
      />
      {v.reviewNote && <Alert tone={v.status === 'REJECTED' ? 'danger' : 'warning'} title="Review note">{v.reviewNote}</Alert>}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card padded={false}>
            <CardHeader title="Business information" action={<Link to={`/admin/organizations/${org.id}`} className="link text-sm">Organization →</Link>} />
            <div className="p-5">
              <DescriptionList
                items={[
                  { label: 'Legal name', value: org.name },
                  { label: 'Business type', value: org.businessType },
                  { label: 'Registration no.', value: org.registrationNumber },
                  { label: 'Tax ID', value: org.taxId },
                  { label: 'Address', value: [org.address, org.city, org.country].filter(Boolean).join(', ') },
                  { label: 'Website', value: org.website },
                  { label: 'Contact person', value: `${org.contactPersonName ?? '—'} · ${org.contactPersonPhone ?? ''}` },
                  { label: 'Expected volume', value: org.expectedMonthlyVolume ? `${org.expectedMonthlyVolume.toLocaleString()} SMS / month` : null },
                  { label: 'Purpose of SMS', value: org.smsPurpose },
                ]}
              />
            </div>
          </Card>
          <Card padded={false}>
            <CardHeader title="Documents" description="Opened files are logged in the audit trail." />
            {v.documents.length === 0 ? (
              <EmptyState icon={<FileText />} title="No documents" className="py-8" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {v.documents.map((d) => (
                  <li key={d.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><FileText className="h-5 w-5" /></span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900">{label(d.documentType)}</p>
                        <p className="truncate text-xs text-slate-500">
                          {d.value ? (/^https?:\/\//.test(d.value) ? <a href={d.value} target="_blank" rel="noopener noreferrer" className="link">{d.value}</a> : d.value) : d.originalName}
                          {d.sizeBytes != null && ` · ${fmtBytes(d.sizeBytes)}`} · {fmtDate(d.createdAt)}
                        </p>
                        {d.reviewNote && <p className="text-xs text-amber-700">{d.reviewNote}</p>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={d.status} />
                      {!d.value && <Button size="xs" variant="secondary" icon={<Eye className="h-3 w-3" />} onClick={() => downloadFile(`/admin/verifications/documents/${d.id}/download`, d.originalName, true).catch((e) => toast.error(errorMessage(e)))}>View</Button>}
                      {open && canAdmin('verification.review') && (
                        <Select className="h-7 w-auto py-0 text-xs" value="" onChange={(e) => e.target.value && setDocAction({ id: d.id, decision: e.target.value as 'APPROVED' })}>
                          <option value="">Mark as…</option>
                          <option value="APPROVED">Approved</option>
                          <option value="REPLACEMENT_REQUESTED">Needs replacement</option>
                          <option value="REJECTED">Rejected</option>
                        </Select>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <Card padded={false}>
            <CardHeader title="Account owner" />
            <div className="space-y-1 p-5 text-sm">
              <p className="font-medium text-slate-900">{owner?.fullName}</p>
              <p className="text-slate-600">{owner?.email}</p>
              <p className="text-slate-600">{owner?.phone ?? '—'}</p>
              <p className="pt-2">{owner?.emailVerifiedAt ? <Badge color="green">Email verified</Badge> : <Badge color="amber">Email not verified</Badge>}</p>
            </div>
          </Card>
          {v.reviews.length > 0 && (
            <Card padded={false}>
              <CardHeader title="Review decisions" />
              <ul className="space-y-3 p-5">
                {v.reviews.map((r) => (
                  <li key={r.id} className="text-sm">
                    <span className="flex items-center gap-2"><Badge color={r.action === 'APPROVE' ? 'green' : r.action === 'REJECT' || r.action === 'SUSPEND' ? 'red' : 'violet'}>{titleCase(r.action)}</Badge><span className="text-xs text-slate-500">{fmtRelative(r.createdAt)}</span></span>
                    {r.note && <p className="mt-1 text-xs text-slate-600">{r.note}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card padded={false}>
            <CardHeader title="History" />
            <ul className="space-y-3 p-5">
              {v.history.map((h) => (
                <li key={h.id} className="flex gap-3 text-sm">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
                  <span><span className="font-medium text-slate-800">{titleCase(h.action)}</span><span className="block text-xs text-slate-500">{h.actor?.fullName ?? 'System'} · {fmtRelative(h.createdAt)}</span></span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={!!docAction}
        onClose={() => setDocAction(null)}
        tone={docAction?.decision === 'APPROVED' ? 'success' : 'danger'}
        title={`Mark document as ${titleCase(docAction?.decision ?? '')}?`}
        requireReason={docAction?.decision === 'APPROVED' ? undefined : true}
        reasonLabel="Note to customer"
        confirmLabel="Confirm"
        loading={reviewDoc.isPending}
        onConfirm={(n) => reviewDoc.mutate(n)}
      />
      <ConfirmDialog
        open={!!decision}
        onClose={() => setDecision(null)}
        tone={decision === 'APPROVE' ? 'success' : decision === 'REJECT' ? 'danger' : 'primary'}
        title={decision === 'APPROVE' ? `Approve ${org.name}?` : decision === 'REJECT' ? `Reject ${org.name}?` : 'Request more information?'}
        description={decision === 'APPROVE' ? 'The organization and its members become active and can request sender IDs and buy credits.' : 'The customer will see your note and can resubmit.'}
        requireReason={decision === 'APPROVE' ? 'optional' : true}
        reasonLabel="Note to customer"
        confirmLabel={decision === 'APPROVE' ? 'Approve' : decision === 'REJECT' ? 'Reject' : 'Request information'}
        loading={decide.isPending}
        onConfirm={(n) => decide.mutate(n)}
      />
    </div>
  );
}

const SENDER_ACTIONS: Record<string, { label: string; perm: string; tone: 'success' | 'danger' | 'primary'; needsNote: boolean; from: string[] }> = {
  review: { label: 'Start review', perm: 'senders.review', tone: 'primary', needsNote: false, from: ['PENDING'] },
  approve: { label: 'Approve', perm: 'senders.approve', tone: 'success', needsNote: false, from: ['PENDING', 'UNDER_REVIEW', 'NEEDS_INFORMATION'] },
  request_info: { label: 'Request info', perm: 'senders.review', tone: 'primary', needsNote: true, from: ['PENDING', 'UNDER_REVIEW'] },
  reject: { label: 'Reject', perm: 'senders.reject', tone: 'danger', needsNote: true, from: ['PENDING', 'UNDER_REVIEW', 'NEEDS_INFORMATION'] },
  suspend: { label: 'Suspend', perm: 'senders.suspend', tone: 'danger', needsNote: true, from: ['APPROVED'] },
  reactivate: { label: 'Reactivate', perm: 'senders.suspend', tone: 'success', needsNote: false, from: ['SUSPENDED'] },
};

export function SenderReviewPage() {
  const { canAdmin } = usePermissions();
  const [status, setStatus] = useState('PENDING');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<{ sender: SenderId; action: string } | null>(null);
  const q = useQuery({ queryKey: ['admin', 'senders', status, debounced, page], queryFn: () => adminService.senders({ page, limit: 20, status: status || undefined, search: debounced || undefined }) });
  const act = useApiMutation((note?: string) => adminService.senderAction(action!.sender.id, action!.action, note), {
    success: (s) => `${s.name}: ${titleCase(s.status)}`,
    invalidate: [['admin', 'senders'], ['admin', 'dashboard']],
    onSuccess: () => setAction(null),
  });
  const cfg = action ? SENDER_ACTIONS[action.action] : null;
  return (
    <div className="space-y-6">
      <PageHeader title="Sender IDs" description="Approve, reject or suspend sender names. Only approved senders can send." />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          tabs={[
            { value: 'PENDING', label: 'Pending' },
            { value: 'UNDER_REVIEW', label: 'Under review' },
            { value: 'NEEDS_INFORMATION', label: 'Needs info' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'REJECTED', label: 'Rejected' },
            { value: 'SUSPENDED', label: 'Suspended' },
            { value: '', label: 'All' },
          ]}
          value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          className="flex-1"
        />
        <Input placeholder="Search sender or organization…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
      </div>
      <Card padded={false}>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'n', header: 'Sender ID', cell: (s) => <span className="font-mono text-[15px] font-semibold text-slate-900">{s.name}</span> },
            { key: 'o', header: 'Organization', cell: (s) => <span><Link to={`/admin/organizations/${s.organization?.id}`} className="link">{s.organization?.name}</Link><span className="ml-2"><StatusBadge status={s.organization?.status ?? ''} /></span></span> },
            { key: 'p', header: 'Purpose', cell: (s) => <span className="block max-w-xs whitespace-normal text-xs text-slate-600">{s.useCase && <Badge className="mb-1">{s.useCase}</Badge>}<span className="block">{s.purpose}</span>{s.sampleMessage && <span className="mt-1 block italic text-slate-400">“{s.sampleMessage}”</span>}</span> },
            { key: 's', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
            { key: 'd', header: 'Requested', cell: (s) => fmtRelative(s.createdAt) },
            {
              key: 'a',
              header: '',
              className: 'text-right',
              cell: (s) => (
                <span className="flex flex-wrap justify-end gap-1">
                  {Object.entries(SENDER_ACTIONS)
                    .filter(([, c]) => c.from.includes(s.status) && canAdmin(c.perm))
                    .map(([k, c]) => (
                      <Button key={k} size="xs" variant={c.tone === 'success' ? 'success' : c.tone === 'danger' ? 'secondary' : 'secondary'} className={c.tone === 'danger' ? 'text-red-600' : undefined} onClick={() => setAction({ sender: s, action: k })}>
                        {c.label}
                      </Button>
                    ))}
                </span>
              ),
            },
          ]}
          empty={<EmptyState icon={<ShieldCheck />} title="Nothing here" description="No sender IDs in this state." />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
      <ConfirmDialog
        open={!!action}
        onClose={() => setAction(null)}
        tone={cfg?.tone ?? 'primary'}
        title={`${cfg?.label} "${action?.sender.name}"?`}
        description={action?.action === 'approve' ? 'The organization will be able to send SMS with this sender ID.' : undefined}
        requireReason={cfg?.needsNote ? true : 'optional'}
        reasonLabel="Note to customer"
        confirmLabel={cfg?.label}
        loading={act.isPending}
        onConfirm={(n) => act.mutate(n)}
      />
    </div>
  );
}
