import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CalendarClock, Copy, Megaphone, Pencil, Plus, Rocket, Trash2, Users, XCircle } from 'lucide-react';
import type { Campaign } from '@/api/types';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Overlay';
import { DataTable, Pagination } from '@/components/ui/Table';
import { PageHeader, ProgressBar, Tabs } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { campaignService } from '@/services/campaignService';
import { contactService } from '@/services/contactService';
import { senderService } from '@/services/senderService';
import { smsService } from '@/services/smsService';
import { cn, fmtDateTime, fmtNumber, fmtRelative } from '@/utils/format';
import { MessageEstimateBar, useMessageEstimate } from '@/components/sms/MessageEstimate';
import { recipientColumns, MessageDrawer } from '../sms/SmsPages';

const STATUSES = ['DRAFT', 'SCHEDULED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'] as const;

function Progress({ c }: { c: Campaign }) {
  const s = c.stats;
  if (!s.recipients) return <span className="text-xs text-slate-400">—</span>;
  const pct = ((s.delivered + s.failed) / s.recipients) * 100;
  return (
    <div className="w-32">
      <ProgressBar value={pct} tone={s.failed > s.delivered ? 'red' : 'emerald'} />
      <p className="mt-1 text-xs text-slate-500 tabular-nums">
        {fmtNumber(s.delivered)} delivered · {fmtNumber(s.failed)} failed
      </p>
    </div>
  );
}

export function CampaignsPage() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('all');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const q = useQuery({
    queryKey: ['campaigns', { page, status, debounced }],
    queryFn: () => campaignService.list({ page, limit: 15, status: status === 'all' ? undefined : status, search: debounced || undefined }),
    refetchInterval: 8000,
    placeholderData: (p) => p,
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Campaigns"
        description="Send one message to many contacts — now or on a schedule."
        breadcrumbs={[{ label: 'Messaging' }, { label: 'Campaigns' }]}
        actions={can('campaigns.create') && <LinkButton to="/app/campaigns/new" icon={<Plus className="h-4 w-4" />}>New campaign</LinkButton>}
      />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <Input placeholder="Search campaigns…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="max-w-xs" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            <option value="all">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
          </Select>
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          onRowClick={(c) => navigate(`/app/campaigns/${c.id}`)}
          columns={[
            { key: 'name', header: 'Campaign', cell: (c) => <div><p className="font-medium text-slate-900">{c.name}</p><p className="text-xs text-slate-500">from <span className="font-mono">{c.sender.name}</span></p></div> },
            { key: 'status', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
            { key: 'rcpt', header: 'Recipients', cell: (c) => <span className="tabular-nums">{fmtNumber(c.stats.recipients) || '—'}</span> },
            { key: 'progress', header: 'Delivery', cell: (c) => <Progress c={c} /> },
            { key: 'pending', header: 'Pending', cell: (c) => <span className="tabular-nums">{fmtNumber(c.stats.pending)}</span> },
            { key: 'credits', header: 'Credits used', cell: (c) => <span className="tabular-nums">{fmtNumber(c.stats.creditsUsed)}</span> },
            { key: 'when', header: 'Created', cell: (c) => <span className="text-slate-500">{c.scheduledAt && c.status === 'SCHEDULED' ? <span className="flex items-center gap-1 text-slate-700"><CalendarClock className="h-3.5 w-3.5" />{fmtDateTime(c.scheduledAt)}</span> : fmtRelative(c.createdAt)}</span> },
          ]}
          empty={<EmptyState icon={<Megaphone />} title="No campaigns yet" description="Create a campaign to message a contact group, e.g. a promotion to your VIP customers." action={can('campaigns.create') && <LinkButton to="/app/campaigns/new">Create campaign</LinkButton>} />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

export function CampaignFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = !!id;
  const existing = useQuery({ queryKey: ['campaign', id], queryFn: () => campaignService.get(id!), enabled: editing });
  const senders = useQuery({ queryKey: ['senders'], queryFn: senderService.list });
  const groups = useQuery({ queryKey: ['contact-groups'], queryFn: contactService.groups });
  const [name, setName] = useState('');
  const [senderId, setSenderId] = useState('');
  const [message, setMessage] = useState('');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [phonesText, setPhonesText] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const c = existing.data;
    if (c) {
      setName(c.name);
      setSenderId(c.senderId);
      setMessage(c.message);
      setGroupIds(c.groups?.map((g) => g.id) ?? []);
      setPhonesText((c.recipients ?? []).map((r) => r.phone).join('\n'));
    }
  }, [existing.data]);
  const usable = (senders.data ?? []).filter((s) => ['APPROVED', 'PENDING', 'UNDER_REVIEW'].includes(s.status));
  useEffect(() => {
    if (!senderId && usable.length && !editing) setSenderId(usable.find((s) => s.status === 'APPROVED')?.id ?? usable[0].id);
  }, [usable, senderId, editing]);

  const phones = useMemo(() => phonesText.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean), [phonesText]);
  const quoteInput = useDebounce({ message, recipients: phones, groupIds }, 400);
  const quote = useQuery({
    queryKey: ['sms-quote', quoteInput],
    queryFn: () => smsService.quote(quoteInput),
    enabled: quoteInput.message.length > 0 && (quoteInput.recipients.length > 0 || quoteInput.groupIds.length > 0),
    placeholderData: (p) => p,
  });
  const { estimate, pending: estimating } = useMessageEstimate(message);
  const q = message ? quote.data : undefined;

  const save = useApiMutation(
    () => {
      const body = { name, senderId, message, groupIds, phones };
      return editing ? campaignService.update(id!, body) : campaignService.create(body);
    },
    { success: editing ? 'Campaign updated' : 'Draft saved', invalidate: [['campaigns'], ['campaign', id]], onSuccess: (c) => navigate(`/app/campaigns/${c.id}`) },
  );

  const submit = () => {
    const e: Record<string, string> = {};
    if (name.trim().length < 2) e.name = 'Give your campaign a name';
    if (!senderId) e.senderId = 'Select a sender ID';
    if (!message.trim()) e.message = 'Write your message';
    if (!groupIds.length && !phones.length) e.recipients = 'Choose at least one group or add phone numbers';
    setErrors(e);
    if (!Object.keys(e).length) save.mutate(undefined);
  };

  if (editing && existing.isLoading) return <PageLoader />;
  if (editing && existing.data && existing.data.status !== 'DRAFT') return <Alert tone="warning">Only draft campaigns can be edited.</Alert>;

  return (
    <div className="space-y-6">
      <PageHeader title={editing ? 'Edit campaign' : 'New campaign'} breadcrumbs={[{ label: 'Campaigns', to: '/app/campaigns' }, { label: editing ? 'Edit' : 'New' }]} description="Save as a draft, then launch now or schedule it." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="space-y-5 p-6">
          <Field label="Campaign name" required error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekend promo — VIP customers" invalid={!!errors.name} />
          </Field>
          <Field label="Sender ID" required error={errors.senderId} hint="The sender must be approved before you can launch.">
            <Select value={senderId} onChange={(e) => setSenderId(e.target.value)} invalid={!!errors.senderId}>
              <option value="">Select…</option>
              {usable.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status !== 'APPROVED' ? ` (${s.status.toLowerCase().replace('_', ' ')})` : ''}</option>)}
            </Select>
          </Field>
          <div>
            <p className="label">Audience <span className="text-red-500">*</span></p>
            {groups.data?.length ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {groups.data.map((g) => (
                  <label key={g.id} className={cn('flex cursor-pointer items-center gap-3 rounded-lg border p-3', groupIds.includes(g.id) ? 'border-brand-300 bg-brand-50/50' : 'border-slate-200 hover:bg-slate-50')}>
                    <Checkbox checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((i) => i !== g.id)))} />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: g.color ?? '#94a3b8' }} />
                    <span className="flex-1 text-sm font-medium">{g.name}</span>
                    <span className="text-xs text-slate-500">{fmtNumber(g.contactCount)}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No contact groups yet — <Link to="/app/contacts/groups" className="link">create one</Link> or add numbers below.</p>
            )}
            <Field className="mt-3" hint="Additional numbers, one per line." error={errors.recipients}>
              <Textarea rows={3} value={phonesText} onChange={(e) => setPhonesText(e.target.value)} placeholder="+250788123456" className="font-mono text-[13px]" />
            </Field>
          </div>
          <Field label="Message" required error={errors.message}>
            <Textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} invalid={!!errors.message} placeholder="Hi! This weekend only: 20% off everything. Reply STOP to opt out." />
            <MessageEstimateBar estimate={estimate} pending={estimating} />
          </Field>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-5">
            <Button variant="secondary" onClick={() => navigate(-1)}>Cancel</Button>
            <Button onClick={submit} loading={save.isPending}>{editing ? 'Save changes' : 'Save draft'}</Button>
          </div>
        </Card>
        <Card className="h-fit p-5 lg:sticky lg:top-24">
          <p className="text-sm font-semibold text-slate-900">Estimated audience & cost</p>
          <p className="mt-1 text-xs text-slate-500">Calculated by our servers. Final numbers are recalculated when you launch (unsubscribed contacts are skipped).</p>
          {q ? (
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Recipients</dt><dd className="font-medium tabular-nums">{fmtNumber(q.recipientCount)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Characters</dt><dd className="font-medium tabular-nums">{fmtNumber(q.characterCount)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Encoding</dt><dd className="font-medium">{q.encoding === 'GSM7' ? 'GSM-7' : 'Unicode'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Segments per recipient</dt><dd className="font-medium tabular-nums">{q.segments}</dd></div>
              <div className="flex justify-between border-t border-slate-100 pt-2"><dt className="font-medium">Total SMS credits required</dt><dd className="text-lg font-semibold tabular-nums">{fmtNumber(q.totalCredits)}</dd></div>
              <div className="flex justify-between text-xs"><dt className="text-slate-500">Current balance</dt><dd className="tabular-nums">{fmtNumber(q.balance)}</dd></div>
              <div className="flex justify-between text-xs"><dt className="text-slate-500">Remaining after send</dt><dd className={cn('tabular-nums', !q.sufficientBalance && 'font-semibold text-red-600')}>{fmtNumber(q.remainingAfterSend)}</dd></div>
            </dl>
          ) : (
            <p className="mt-4 text-sm text-slate-500">Add a message and recipients to see the cost.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

export function CampaignDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const q = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => campaignService.get(id!),
    refetchInterval: (qq) => (qq.state.data && ['QUEUED', 'PROCESSING', 'SCHEDULED'].includes(qq.state.data.status) ? 3000 : false),
  });
  const c = q.data;
  const [tab, setTab] = useState<'overview' | 'messages'>('overview');
  const [page, setPage] = useState(1);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [mode, setMode] = useState<'now' | 'schedule'>('now');
  const [when, setWhen] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const msgs = useQuery({
    queryKey: ['sms', 'history', 'campaign', c?.smsMessage?.id, page],
    queryFn: () => smsService.history({ page, limit: 20, batchId: c!.smsMessage!.id }),
    enabled: tab === 'messages' && !!c?.smsMessage,
    refetchInterval: 5000,
  });
  const inv = [['campaign', id], ['campaigns'], ['wallet'], ['sms']];
  const launch = useApiMutation(() => campaignService.launch(id!, mode === 'schedule' && when ? new Date(when).toISOString() : null), {
    success: (d) => (d.status === 'SCHEDULED' ? 'Campaign scheduled' : `Campaign launched to ${fmtNumber(d.recipients)} recipients`),
    invalidate: inv,
    onSuccess: () => setLaunchOpen(false),
  });
  const cancel = useApiMutation(() => campaignService.cancel(id!), { success: 'Campaign cancelled', invalidate: inv, onSuccess: () => setConfirmCancel(false) });
  const remove = useApiMutation(() => campaignService.remove(id!), { success: 'Campaign deleted', invalidate: [['campaigns']], onSuccess: () => navigate('/app/campaigns') });
  const dup = useApiMutation(() => campaignService.duplicate(id!), { success: 'Campaign duplicated', invalidate: [['campaigns']], onSuccess: (d) => navigate(`/app/campaigns/${d.id}`) });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !c) return <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>;
  const s = c.stats;
  const pct = s.recipients ? Math.round(((s.delivered + s.failed) / s.recipients) * 100) : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3">{c.name} <StatusBadge status={c.status} /></span>}
        breadcrumbs={[{ label: 'Campaigns', to: '/app/campaigns' }, { label: c.name }]}
        description={<>From <span className="font-mono font-medium text-slate-700">{c.sender.name}</span> · created {fmtDateTime(c.createdAt)}</>}
        actions={
          <>
            {can('campaigns.create') && <Button variant="secondary" size="sm" icon={<Copy className="h-4 w-4" />} onClick={() => dup.mutate(undefined)} loading={dup.isPending}>Duplicate</Button>}
            {c.status === 'DRAFT' && can('campaigns.update') && <LinkButton to={`/app/campaigns/${c.id}/edit`} variant="secondary" size="sm" icon={<Pencil className="h-4 w-4" />}>Edit</LinkButton>}
            {['DRAFT', 'CANCELLED'].includes(c.status) && can('campaigns.delete') && <Button variant="ghost" size="sm" className="text-red-600" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmDelete(true)}>Delete</Button>}
            {['DRAFT', 'SCHEDULED'].includes(c.status) && can('campaigns.cancel') && <Button variant="secondary" size="sm" icon={<XCircle className="h-4 w-4" />} onClick={() => setConfirmCancel(true)}>Cancel</Button>}
            {c.status === 'DRAFT' && (can('campaigns.send') || can('campaigns.schedule')) && (
              <Button size="sm" icon={<Rocket className="h-4 w-4" />} onClick={() => { setMode(can('campaigns.send') ? 'now' : 'schedule'); setLaunchOpen(true); }}>Launch</Button>
            )}
          </>
        }
      />
      {c.status === 'SCHEDULED' && c.scheduledAt && <Alert tone="info" title={`Scheduled for ${fmtDateTime(c.scheduledAt)}`}>Credits are reserved. Our servers will send it automatically — no need to keep this page open.</Alert>}
      {c.failureReason && <Alert tone="danger">{c.failureReason}</Alert>}
      {c.sender.status !== 'APPROVED' && c.status === 'DRAFT' && <Alert tone="warning">Sender ID <strong>{c.sender.name}</strong> is not approved yet — you can launch once it is.</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Recipients" value={fmtNumber(s.recipients) || '—'} icon={<Users />} />
        <StatCard label="Sent" value={fmtNumber(s.sent)} tone="sky" />
        <StatCard label="Delivered" value={fmtNumber(s.delivered)} tone="emerald" />
        <StatCard label="Failed" value={fmtNumber(s.failed)} tone="red" />
        <StatCard label="Credits used" value={fmtNumber(s.creditsUsed)} tone="amber" hint={`${fmtNumber(s.pending)} pending`} />
      </div>
      {s.recipients > 0 && (
        <Card>
          <div className="mb-2 flex justify-between text-sm"><span className="font-medium text-slate-700">Progress</span><span className="tabular-nums text-slate-500">{pct}% finalized</span></div>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100">
            <div className="bg-emerald-500 transition-all" style={{ width: `${(s.delivered / s.recipients) * 100}%` }} />
            <div className="bg-red-500 transition-all" style={{ width: `${(s.failed / s.recipients) * 100}%` }} />
            <div className="bg-brand-300 transition-all" style={{ width: `${(s.pending / s.recipients) * 100}%` }} />
          </div>
        </Card>
      )}
      <Tabs tabs={[{ value: 'overview', label: 'Overview' }, { value: 'messages', label: 'Messages', count: s.recipients || undefined }]} value={tab} onChange={setTab} />
      {tab === 'overview' ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card padded={false}>
            <CardHeader title="Message" />
            <div className="p-5"><p className="whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm ring-1 ring-inset ring-slate-100">{c.message}</p></div>
          </Card>
          <Card padded={false}>
            <CardHeader title="Audience" />
            <div className="space-y-2 p-5">
              {c.groups?.map((g) => (
                <div key={g.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: g.color ?? '#94a3b8' }} />{g.name}</span>
                  <Badge>{fmtNumber(g.contactCount)} contacts</Badge>
                </div>
              ))}
              {(c.explicitRecipientCount ?? 0) > 0 && <p className="text-sm text-slate-600">+ {fmtNumber(c.explicitRecipientCount)} individually added number(s)</p>}
              {!c.groups?.length && !c.explicitRecipientCount && <p className="text-sm text-slate-500">No audience selected.</p>}
            </div>
          </Card>
        </div>
      ) : c.smsMessage ? (
        <Card padded={false}>
          <DataTable columns={recipientColumns()} rows={msgs.data?.data} loading={msgs.isLoading} error={msgs.error} onRowClick={(r) => setSelected(r.id)} empty={<EmptyState title="No messages" />} />
          <Pagination pagination={msgs.data?.pagination} onPage={setPage} />
        </Card>
      ) : (
        <Card><EmptyState icon={<Megaphone />} title="Not launched yet" description="Messages will appear here once the campaign is launched." /></Card>
      )}

      <Modal
        open={launchOpen}
        onClose={() => setLaunchOpen(false)}
        title="Launch campaign"
        description="Credits are deducted when you launch. Unsubscribed contacts are skipped automatically."
        footer={
          <>
            <Button variant="secondary" onClick={() => setLaunchOpen(false)}>Cancel</Button>
            <Button loading={launch.isPending} disabled={mode === 'schedule' && !when} onClick={() => launch.mutate(undefined)} icon={mode === 'now' ? <Rocket className="h-4 w-4" /> : <CalendarClock className="h-4 w-4" />}>
              {mode === 'now' ? 'Send now' : 'Schedule'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {can('campaigns.send') && (
            <label className={cn('flex cursor-pointer gap-3 rounded-xl border p-4', mode === 'now' ? 'border-brand-300 bg-brand-50/50' : 'border-slate-200')}>
              <input type="radio" checked={mode === 'now'} onChange={() => setMode('now')} className="mt-1 text-brand-600" />
              <span><span className="block text-sm font-medium">Send now</span><span className="text-xs text-slate-500">Messages are queued immediately.</span></span>
            </label>
          )}
          {can('campaigns.schedule') && (
            <label className={cn('flex cursor-pointer gap-3 rounded-xl border p-4', mode === 'schedule' ? 'border-brand-300 bg-brand-50/50' : 'border-slate-200')}>
              <input type="radio" checked={mode === 'schedule'} onChange={() => setMode('schedule')} className="mt-1 text-brand-600" />
              <span className="flex-1">
                <span className="block text-sm font-medium">Schedule</span>
                <span className="text-xs text-slate-500">Your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</span>
                {mode === 'schedule' && <Input type="datetime-local" className="mt-2" value={when} min={new Date(Date.now() + 120_000).toISOString().slice(0, 16)} onChange={(e) => setWhen(e.target.value)} />}
              </span>
            </label>
          )}
        </div>
      </Modal>
      <ConfirmDialog open={confirmCancel} onClose={() => setConfirmCancel(false)} title="Cancel this campaign?" description={c.status === 'SCHEDULED' ? 'It will not be sent and reserved credits will be refunded.' : 'The draft will be marked as cancelled.'} confirmLabel="Cancel campaign" loading={cancel.isPending} onConfirm={() => cancel.mutate(undefined)} />
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this campaign?" description="This cannot be undone." confirmLabel="Delete" loading={remove.isPending} onConfirm={() => remove.mutate(undefined)} />
      <MessageDrawer id={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
