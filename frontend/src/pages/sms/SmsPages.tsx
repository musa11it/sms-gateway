import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarClock, CheckCircle2, Clock, Coins, History, Inbox, Send, ShieldAlert, Users, XCircle } from 'lucide-react';
import type { SmsRecipient } from '@/api/types';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader, Skeleton } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Switch, Textarea } from '@/components/ui/Form';
import { ConfirmDialog, Drawer } from '@/components/ui/Overlay';
import { DataTable, Pagination, type Column } from '@/components/ui/Table';
import { CopyButton, PageHeader, Tabs } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { contactService } from '@/services/contactService';
import { senderService } from '@/services/senderService';
import { smsService } from '@/services/smsService';
import { cn, estimateSegments, fmtDateTime, fmtNumber, fmtRelative, titleCase } from '@/utils/format';

function parseNumbers(text: string) {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function PhonePreview({ sender, message }: { sender: string; message: string }) {
  return (
    <div className="mx-auto w-full max-w-[280px] rounded-[2.2rem] bg-slate-900 p-2.5 shadow-pop">
      <div className="overflow-hidden rounded-[1.8rem] bg-gradient-to-b from-slate-50 to-slate-100">
        <div className="flex flex-col items-center border-b border-slate-200 bg-white/80 px-4 pb-3 pt-6">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-300 text-xs font-semibold text-white">{(sender || '?').slice(0, 2).toUpperCase()}</span>
          <span className="mt-1 text-xs font-medium text-slate-800">{sender || 'Sender ID'}</span>
        </div>
        <div className="min-h-[220px] p-3">
          {message ? (
            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-white px-3 py-2 text-[13px] leading-snug text-slate-800 shadow-sm">{message}</div>
          ) : (
            <p className="mt-16 text-center text-xs text-slate-400">Your message preview</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function SendSmsPage() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const senders = useQuery({ queryKey: ['senders'], queryFn: senderService.list });
  const groups = useQuery({ queryKey: ['contact-groups'], queryFn: contactService.groups, enabled: can('contacts.view') });
  const approved = (senders.data ?? []).filter((s) => s.status === 'APPROVED');

  const [senderId, setSenderId] = useState('');
  const [tab, setTab] = useState<'numbers' | 'groups'>('numbers');
  const [numbersText, setNumbersText] = useState('');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [schedule, setSchedule] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!senderId && approved.length) setSenderId(approved[0].id);
  }, [approved, senderId]);

  const numbers = useMemo(() => parseNumbers(numbersText), [numbersText]);
  const local = estimateSegments(message);
  const quoteInput = useDebounce({ message, recipients: numbers, groupIds }, 400);
  const quote = useQuery({
    queryKey: ['sms-quote', quoteInput],
    queryFn: () => smsService.quote(quoteInput),
    enabled: quoteInput.message.length > 0 && (quoteInput.recipients.length > 0 || quoteInput.groupIds.length > 0),
    placeholderData: (prev) => prev,
  });
  const q = quote.data;

  const send = useApiMutation(
    () =>
      smsService.send({
        senderId,
        message,
        recipients: numbers,
        groupIds,
        scheduledAt: schedule && scheduledAt ? new Date(scheduledAt).toISOString() : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        idempotencyKey,
      }),
    {
      success: (d) => (d.status === 'SCHEDULED' ? 'Message scheduled' : `Message queued for ${fmtNumber(d.recipientCount)} recipient(s)`),
      invalidate: [['wallet'], ['sms'], ['reports']],
      onSuccess: (d) => {
        setIdempotencyKey(crypto.randomUUID());
        navigate(d.status === 'SCHEDULED' ? '/app/sms/scheduled' : `/app/sms/history?batch=${d.id}`);
      },
    },
  );

  if (senders.isLoading) return <PageLoader />;
  if (approved.length === 0)
    return (
      <div className="space-y-6">
        <PageHeader title="Send SMS" breadcrumbs={[{ label: 'Messaging' }, { label: 'Send SMS' }]} />
        <Card>
          <EmptyState
            icon={<ShieldAlert />}
            title="You need an approved sender ID"
            description="Every SMS is sent from a sender ID that our team has approved for your organization. Request one to get started — approval is usually quick."
            action={<LinkButton to="/app/senders">Request a sender ID</LinkButton>}
          />
        </Card>
      </div>
    );

  const hasRecipients = numbers.length > 0 || groupIds.length > 0;
  const canSend = !!senderId && message.trim().length > 0 && hasRecipients && (!schedule || !!scheduledAt) && !!q && q.recipientCount > 0 && q.invalid.length === 0 && q.sufficientBalance;
  const senderName = approved.find((s) => s.id === senderId)?.name ?? '';

  return (
    <div className="space-y-6">
      <PageHeader title="Send SMS" description="Compose a message to individual numbers or whole contact groups." breadcrumbs={[{ label: 'Messaging' }, { label: 'Send SMS' }]} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="space-y-6 p-6">
          <Field label="Sender ID" required hint="Only approved sender IDs are listed.">
            <Select value={senderId} onChange={(e) => setSenderId(e.target.value)}>
              {approved.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>

          <div>
            <p className="label">Recipients</p>
            <Tabs
              tabs={[
                { value: 'numbers', label: 'Phone numbers', count: numbers.length || undefined },
                { value: 'groups', label: 'Contact groups', count: groupIds.length || undefined },
              ]}
              value={tab}
              onChange={setTab}
              className="mb-3"
            />
            {tab === 'numbers' ? (
              <Field hint="One per line, or separated by commas. Local numbers like 0788 123 456 are converted to international format.">
                <Textarea rows={4} value={numbersText} onChange={(e) => setNumbersText(e.target.value)} placeholder={'+250788123456\n0782123456'} className="font-mono text-[13px]" />
              </Field>
            ) : groups.data?.length ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {groups.data.map((g) => (
                  <label key={g.id} className={cn('flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition', groupIds.includes(g.id) ? 'border-brand-300 bg-brand-50/50' : 'border-slate-200 hover:bg-slate-50')}>
                    <Checkbox checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((i) => i !== g.id)))} />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: g.color ?? '#94a3b8' }} />
                    <span className="flex-1 text-sm font-medium text-slate-800">{g.name}</span>
                    <span className="text-xs text-slate-500">{fmtNumber(g.contactCount)}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">
                No groups yet. <Link to="/app/contacts/groups" className="link">Create a group</Link> to message many contacts at once.
              </p>
            )}
            {q && q.invalid.length > 0 && (
              <Alert tone="danger" className="mt-3" title={`${q.invalid.length} invalid number(s)`}>
                {q.invalid.slice(0, 5).map((i) => i.message).join(' · ')}
              </Alert>
            )}
          </div>

          <Field label="Message" required>
            <Textarea rows={6} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Hi! Your order #1234 is ready for pickup." />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span className="flex items-center gap-2">
                <Badge color={local.encoding === 'GSM7' ? 'gray' : 'amber'}>{local.encoding === 'GSM7' ? 'GSM-7' : 'Unicode (UCS-2)'}</Badge>
                {local.encoding === 'UCS2' && <span>Emoji or special characters reduce characters per SMS to 70.</span>}
              </span>
              <span className="tabular-nums">
                {local.characters} chars · {local.segments} SMS segment{local.segments === 1 ? '' : 's'}
              </span>
            </div>
          </Field>

          <div className="rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium text-slate-800">
                <CalendarClock className="h-4 w-4 text-slate-400" /> Schedule for later
              </span>
              <Switch checked={schedule} onChange={setSchedule} label="Schedule" />
            </div>
            {schedule && (
              <Field className="mt-3" hint="Credits are reserved now and refunded if you cancel. Sending happens on our servers — you can close the browser.">
                <Input type="datetime-local" value={scheduledAt} min={new Date(Date.now() + 120_000).toISOString().slice(0, 16)} onChange={(e) => setScheduledAt(e.target.value)} />
              </Field>
            )}
          </div>
        </Card>

        <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <PhonePreview sender={senderName} message={message} />
          <Card className="p-5">
            <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Coins className="h-4 w-4 text-amber-500" /> Cost summary
            </p>
            {quote.isFetching && !q ? (
              <Skeleton className="h-24" />
            ) : q ? (
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-slate-500">Recipients</dt><dd className="font-medium tabular-nums">{fmtNumber(q.recipientCount)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Segments per SMS</dt><dd className="font-medium tabular-nums">{q.segments}</dd></div>
                {(q.duplicates > 0 || q.optedOut > 0) && (
                  <div className="flex justify-between text-xs"><dt className="text-slate-500">Skipped</dt><dd>{q.duplicates} duplicate · {q.optedOut} opted-out</dd></div>
                )}
                <div className="flex justify-between border-t border-slate-100 pt-2"><dt className="font-medium text-slate-700">Total credits</dt><dd className="text-lg font-semibold tabular-nums text-slate-900">{fmtNumber(q.totalCredits)}</dd></div>
                <div className="flex justify-between text-xs"><dt className="text-slate-500">Balance after</dt><dd className={cn('tabular-nums', !q.sufficientBalance && 'font-semibold text-red-600')}>{fmtNumber(q.balance - q.totalCredits)}</dd></div>
              </dl>
            ) : (
              <p className="text-sm text-slate-500">Add recipients and a message to see the cost. Pricing is calculated by our servers.</p>
            )}
            {q && !q.sufficientBalance && (
              <Alert tone="warning" className="mt-3" action={can('wallet.purchase') && <LinkButton to="/app/wallet/buy" size="xs">Buy SMS</LinkButton>}>
                Not enough credits.
              </Alert>
            )}
            <Button size="lg" className="mt-4 w-full" disabled={!canSend} loading={send.isPending} onClick={() => setConfirm(true)} icon={schedule ? <CalendarClock className="h-4 w-4" /> : <Send className="h-4 w-4" />}>
              {schedule ? 'Schedule message' : 'Send now'}
            </Button>
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        tone="primary"
        title={schedule ? 'Schedule this message?' : 'Send this message?'}
        description={
          <>
            <strong>{fmtNumber(q?.totalCredits)}</strong> credits will be deducted for {fmtNumber(q?.recipientCount)} recipient(s)
            {schedule && scheduledAt ? <> on {fmtDateTime(new Date(scheduledAt))}</> : null}.
          </>
        }
        confirmLabel={schedule ? 'Schedule' : 'Send'}
        loading={send.isPending}
        onConfirm={() => {
          setConfirm(false);
          send.mutate(undefined);
        }}
      />
    </div>
  );
}

// ── History ─────────────────────────────────────────────────────────────

const STATUS_FLOW = ['QUEUED', 'PROCESSING', 'SENT', 'DELIVERED'];

export function MessageDrawer({ id, onClose, fetcher }: { id: string | null; onClose: () => void; fetcher?: (id: string) => Promise<SmsRecipient> }) {
  const { data: m, isLoading, error } = useQuery({
    queryKey: ['sms', 'message', id],
    queryFn: () => (fetcher ?? smsService.message)(id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ['QUEUED', 'PROCESSING', 'SENT'].includes(q.state.data.status) ? 3000 : false),
  });
  const failed = m && ['FAILED', 'EXPIRED', 'CANCELLED'].includes(m.status);
  // Furthest step reached; failed messages were rejected at submission (no provider id) or later.
  const reached = !m ? -1 : m.status === 'CANCELLED' ? 0 : failed ? (m.providerMessageId ? 2 : 1) : STATUS_FLOW.indexOf(m.status);
  return (
    <Drawer open={!!id} onClose={onClose} title="Message details" description={m ? <span className="font-mono">{m.phone}</span> : undefined}>
      {isLoading ? (
        <PageLoader />
      ) : error || !m ? (
        <ErrorState error={error} />
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <StatusBadge status={m.status} />
            <span className="text-xs text-slate-500">{fmtDateTime(m.createdAt)}</span>
          </div>
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Lifecycle</p>
            <ol className="space-y-0">
              {STATUS_FLOW.map((s, i) => {
                const done = i <= reached;
                const isFail = failed && i === STATUS_FLOW.length - 1;
                return (
                  <li key={s} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className={cn('flex h-6 w-6 items-center justify-center rounded-full ring-2', isFail ? 'bg-red-500 text-white ring-red-500' : done ? 'bg-emerald-500 text-white ring-emerald-500' : 'bg-white ring-slate-200')}>
                        {isFail ? <XCircle className="h-3.5 w-3.5" /> : done ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock className="h-3 w-3 text-slate-300" />}
                      </span>
                      {i < STATUS_FLOW.length - 1 && <span className={cn('h-6 w-0.5', done ? 'bg-emerald-300' : 'bg-slate-200')} />}
                    </div>
                    <div className="pb-2">
                      <p className={cn('text-sm font-medium', isFail ? 'text-red-700' : done ? 'text-slate-900' : 'text-slate-400')}>{isFail ? titleCase(m.status) : titleCase(s)}</p>
                      {s === 'SENT' && m.sentAt && <p className="text-xs text-slate-500">{fmtDateTime(m.sentAt)}</p>}
                      {s === 'DELIVERED' && m.deliveredAt && <p className="text-xs text-slate-500">{fmtDateTime(m.deliveredAt)}</p>}
                      {isFail && <p className="text-xs text-red-600">{m.errorCode}: {m.errorMessage}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Message</p>
            <p className="whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm text-slate-800 ring-1 ring-inset ring-slate-100">{m.message.body}</p>
          </div>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div><dt className="text-xs text-slate-500">Sender</dt><dd className="font-medium">{m.message.senderName}</dd></div>
            <div><dt className="text-xs text-slate-500">Credits</dt><dd className="font-medium">{m.credits}{m.refunded && <Badge color="green" className="ml-2">refunded</Badge>}</dd></div>
            <div><dt className="text-xs text-slate-500">Segments</dt><dd className="font-medium">{m.message.segments}</dd></div>
            <div><dt className="text-xs text-slate-500">Source</dt><dd className="font-medium">{titleCase(m.message.source)}</dd></div>
            <div className="col-span-2"><dt className="text-xs text-slate-500">Message ID</dt><dd className="flex items-center gap-1 font-mono text-xs">{m.id}<CopyButton value={m.id} label="" /></dd></div>
            {m.providerMessageId && (
              <div className="col-span-2"><dt className="text-xs text-slate-500">Provider reference ({m.provider})</dt><dd className="font-mono text-xs">{m.providerMessageId}</dd></div>
            )}
          </dl>
          {m.deliveryReports && m.deliveryReports.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Delivery reports</p>
              <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
                {m.deliveryReports.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                    <span className="flex items-center gap-2"><StatusBadge status={r.status} /><span className="text-slate-500">{r.providerStatus} · via {r.source.toLowerCase()}</span></span>
                    <span className="text-slate-400">{fmtDateTime(r.occurredAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

export const recipientColumns = (extra: Column<SmsRecipient>[] = []): Column<SmsRecipient>[] => [
  { key: 'to', header: 'To', cell: (m) => <span className="font-mono text-[13px] text-slate-900">{m.phone}</span> },
  ...extra,
  { key: 'msg', header: 'Message', cell: (m) => <span className="block max-w-[320px] truncate text-slate-600">{m.message.body}</span> },
  { key: 'sender', header: 'Sender', cell: (m) => <Badge>{m.message.senderName}</Badge> },
  { key: 'status', header: 'Status', cell: (m) => <StatusBadge status={m.status} /> },
  { key: 'credits', header: 'Credits', cell: (m) => <span className="tabular-nums">{m.credits}{m.refunded && <span className="ml-1 text-xs text-emerald-600">(refunded)</span>}</span> },
  { key: 'time', header: 'Created', cell: (m) => <span className="text-slate-500" title={fmtDateTime(m.createdAt)}>{fmtRelative(m.createdAt)}</span> },
];

export function SmsHistoryPage() {
  const [params, setParams] = useSearchParams();
  const batchId = params.get('batch') ?? undefined;
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['sms', 'history', { page, status, source, debounced, batchId }],
    queryFn: () => smsService.history({ page, limit: 20, status: status || undefined, source: source || undefined, search: debounced || undefined, batchId }),
    refetchInterval: 5000,
    placeholderData: (p) => p,
  });
  return (
    <div className="space-y-6">
      <PageHeader title="SMS history" description="Every message with its live delivery status. Updates automatically." breadcrumbs={[{ label: 'Messaging' }, { label: 'History' }]} actions={<LinkButton to="/app/sms/send" icon={<Send className="h-4 w-4" />}>Send SMS</LinkButton>} />
      {batchId && (
        <Alert tone="info" action={<Button size="xs" variant="secondary" onClick={() => setParams({})}>Show all</Button>}>
          Showing messages from one send request. Statuses update as delivery reports arrive from the provider.
        </Alert>
      )}
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <Input placeholder="Search phone number…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="max-w-xs" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All statuses</option>
            {['QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED', 'CANCELLED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
          <Select value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All sources</option>
            <option value="DASHBOARD">Dashboard</option>
            <option value="CAMPAIGN">Campaign</option>
            <option value="API">API</option>
          </Select>
        </div>
        <DataTable
          columns={recipientColumns()}
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          onRowClick={(r) => setSelected(r.id)}
          empty={<EmptyState icon={<History />} title="No messages found" description="Messages you send from the dashboard, campaigns or the API will appear here." action={<LinkButton to="/app/sms/send">Send your first SMS</LinkButton>} />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
      <MessageDrawer id={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export function ScheduledPage() {
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['sms', 'scheduled'], queryFn: smsService.scheduled });
  const [cancelId, setCancelId] = useState<string | null>(null);
  const cancel = useApiMutation((id: string) => smsService.cancel(id), { success: 'Cancelled — credits refunded', invalidate: [['sms'], ['wallet'], ['campaigns']], onSuccess: () => setCancelId(null) });
  return (
    <div className="space-y-6">
      <PageHeader title="Scheduled" description="Messages and campaigns waiting to be sent by our servers." breadcrumbs={[{ label: 'Messaging' }, { label: 'Scheduled' }]} />
      <Card padded={false}>
        <CardHeader title="Upcoming sends" description="Credits are reserved; cancelling refunds them in full." />
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'when', header: 'Scheduled for', cell: (b) => <span className="font-medium text-slate-900">{fmtDateTime(b.scheduledAt)}</span> },
            { key: 'what', header: 'Message', cell: (b) => (
              <span className="block max-w-sm truncate">
                {b.campaign && <Link to={`/app/campaigns/${b.campaign.id}`} className="link mr-2">{b.campaign.name}</Link>}
                <span className="text-slate-600">{b.body}</span>
              </span>
            ) },
            { key: 'sender', header: 'Sender', cell: (b) => <Badge>{b.senderName}</Badge> },
            { key: 'rcpt', header: 'Recipients', cell: (b) => <span className="flex items-center gap-1 tabular-nums"><Users className="h-3.5 w-3.5 text-slate-400" />{fmtNumber(b.recipientCount)}</span> },
            { key: 'credits', header: 'Credits', cell: (b) => <span className="tabular-nums">{fmtNumber(b.totalCredits)}</span> },
            { key: 'actions', header: '', className: 'text-right', cell: (b) => can('sms.cancel') && <Button size="xs" variant="secondary" onClick={() => setCancelId(b.id)}>Cancel</Button> },
          ]}
          empty={<EmptyState icon={<Inbox />} title="Nothing scheduled" description="Schedule a message or campaign and it will appear here until it’s sent." action={<LinkButton to="/app/sms/send" variant="secondary">Schedule a message</LinkButton>} />}
        />
      </Card>
      <ConfirmDialog open={!!cancelId} onClose={() => setCancelId(null)} title="Cancel scheduled send?" description="The message will not be sent and all reserved credits will be refunded to your wallet." confirmLabel="Cancel send" loading={cancel.isPending} onConfirm={() => cancelId && cancel.mutate(cancelId)} />
    </div>
  );
}
