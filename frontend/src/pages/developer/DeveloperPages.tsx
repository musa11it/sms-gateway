import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, KeyRound, MoreHorizontal, Play, Plus, Power, RefreshCw, RotateCw, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { CountBarChart, INK, RED } from '@/components/charts/Charts';
import type { ApiKey, Webhook } from '@/api/types';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button, IconButton, LinkButton } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, TableSkeleton } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Switch } from '@/components/ui/Form';
import { ConfirmDialog, Drawer, Modal } from '@/components/ui/Overlay';
import { DataTable, Pagination } from '@/components/ui/Table';
import { CopyButton, Dropdown, MenuItem, PageHeader } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { useMe, usePermissions } from '@/hooks/useAuth';
import { developerService } from '@/services/developerService';
import { cn, fmtDateTime, fmtNumber, fmtRelative } from '@/utils/format';

function SecretReveal({ open, onClose, title, secret, note }: { open: boolean; onClose: () => void; title: string; secret: string; note: string }) {
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<Button onClick={onClose}>I’ve stored it safely</Button>}>
      <Alert tone="warning" title="Copy it now">{note}</Alert>
      <div className="mt-4 flex items-center gap-2 rounded-xl bg-ink-950 p-3">
        <code className="flex-1 break-all font-mono text-[13px] text-emerald-300">{secret}</code>
        <CopyButton value={secret} className="text-slate-300 hover:bg-white/10 hover:text-white" />
      </div>
    </Modal>
  );
}

const SCOPES = [
  { key: 'sms.send', label: 'Send SMS' },
  { key: 'sms.read', label: 'Read message status' },
  { key: 'balance.read', label: 'Read balance' },
];

export function ApiKeysPage() {
  const { can } = usePermissions();
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['api-keys'], queryFn: developerService.apiKeys });
  const [create, setCreate] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(SCOPES.map((s) => s.key));
  const [ips, setIps] = useState('');
  const [environment, setEnvironment] = useState('production');
  const [limit, setLimit] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<ApiKey | null>(null);
  const [regen, setRegen] = useState<ApiKey | null>(null);
  const createKey = useApiMutation(
    () => developerService.createApiKey({ name, scopes, allowedIps: ips.split(/[\s,]+/).filter(Boolean), environment, rateLimitPerMinute: limit ? Number(limit) : null }),
    { invalidate: [['api-keys']], onSuccess: (d) => { setCreate(false); setName(''); setIps(''); setSecret(d.secret); } },
  );
  const revokeKey = useApiMutation((id: string) => developerService.revokeApiKey(id), { success: 'API key revoked', invalidate: [['api-keys']], onSuccess: () => setRevoke(null) });
  const regenKey = useApiMutation((id: string) => developerService.regenerateApiKey(id), { invalidate: [['api-keys']], onSuccess: (d) => { setRegen(null); setSecret(d.secret); } });
  const toggleKey = useApiMutation((k: ApiKey) => developerService.setApiKeyEnabled(k.id, !k.isEnabled), { success: (_d, k) => (k.isEnabled ? 'API key disabled' : 'API key enabled'), invalidate: [['api-keys']] });
  const active = me?.organization?.status === 'ACTIVE';

  return (
    <div className="space-y-6">
      <PageHeader
        title="API keys"
        description="Authenticate requests to the public SMS API. Keys are shown once and stored hashed."
        breadcrumbs={[{ label: 'Developer' }, { label: 'API keys' }]}
        actions={<>
          <LinkButton to="/app/developer/docs" variant="secondary">API docs</LinkButton>
          {can('api_keys.create') && active && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreate(true)}>Create key</Button>}
        </>}
      />
      <Card padded={false}>
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'name', header: 'Name', cell: (k) => <div><p className="font-medium text-slate-900">{k.name} <Badge color={k.environment === 'production' ? 'blue' : 'gray'}>{k.environment}</Badge></p><p className="text-xs text-slate-500">by {k.createdBy ?? '—'} · {fmtRelative(k.createdAt)}{k.rateLimitPerMinute ? ` · ${k.rateLimitPerMinute}/min` : ''}</p></div> },
            { key: 'key', header: 'Key', cell: (k) => <code className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">{k.maskedKey}</code> },
            { key: 'scopes', header: 'Scopes', cell: (k) => <span className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</span> },
            { key: 'usage', header: 'Requests', cell: (k) => <span className="tabular-nums">{fmtNumber(k.usageCount)}</span> },
            { key: 'last', header: 'Last used', cell: (k) => <span className="text-slate-500" title={k.lastUsedIp ?? undefined}>{k.lastUsedAt ? fmtRelative(k.lastUsedAt) : 'Never'}</span> },
            { key: 'status', header: 'Status', cell: (k) => <StatusBadge status={k.status} /> },
            {
              key: 'act',
              header: '',
              className: 'text-right',
              cell: (k) =>
                ['ACTIVE', 'DISABLED'].includes(k.status) && (can('api_keys.revoke') || can('api_keys.create')) && (
                  <Dropdown trigger={<IconButton label="Actions"><MoreHorizontal className="h-4 w-4" /></IconButton>}>
                    {(close) => (
                      <>
                        {can('api_keys.revoke') && <MenuItem icon={<Power />} onClick={() => { close(); toggleKey.mutate(k); }}>{k.isEnabled ? 'Disable' : 'Enable'}</MenuItem>}
                        {can('api_keys.create') && can('api_keys.revoke') && <MenuItem icon={<RotateCw />} onClick={() => { close(); setRegen(k); }}>Rotate (regenerate)</MenuItem>}
                        {can('api_keys.revoke') && <MenuItem icon={<Trash2 />} danger onClick={() => { close(); setRevoke(k); }}>Revoke</MenuItem>}
                      </>
                    )}
                  </Dropdown>
                ),
            },
          ]}
          empty={<EmptyState icon={<KeyRound />} title="No API keys yet" description="Create a key to send SMS from your own application." action={can('api_keys.create') && active && <Button onClick={() => setCreate(true)}>Create API key</Button>} />}
        />
      </Card>
      <Modal open={create} onClose={() => setCreate(false)} title="Create API key" footer={<><Button variant="secondary" onClick={() => setCreate(false)}>Cancel</Button><Button disabled={name.trim().length < 2 || !scopes.length} loading={createKey.isPending} onClick={() => createKey.mutate(undefined)}>Create key</Button></>}>
        <div className="space-y-4">
          <Field label="Name" required hint="Where will this key be used?"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production website" /></Field>
          <div>
            <p className="label">Scopes</p>
            <div className="space-y-2">{SCOPES.map((s) => <Checkbox key={s.key} label={s.label} description={s.key} checked={scopes.includes(s.key)} onChange={(e) => setScopes((x) => (e.target.checked ? [...x, s.key] : x.filter((i) => i !== s.key)))} />)}</div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Environment">
              <Select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
                <option value="production">Production</option>
                <option value="staging">Staging</option>
                <option value="development">Development</option>
              </Select>
            </Field>
            <Field label="Rate limit (requests/min)" hint="Optional, overrides the default"><Input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
          </div>
          <Field label="Allowed IP addresses" hint="Optional. Comma or space separated. Leave empty to allow any IP."><Input value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.10" className="font-mono" /></Field>
        </div>
      </Modal>
      <SecretReveal open={!!secret} onClose={() => setSecret(null)} title="Your new API key" secret={secret ?? ''} note="For your security we only store a hash of this key. You won’t be able to see it again — create a new key if you lose it." />
      <ConfirmDialog open={!!revoke} onClose={() => setRevoke(null)} title={`Revoke "${revoke?.name}"?`} description="Applications using this key will immediately receive 401 errors." confirmLabel="Revoke key" loading={revokeKey.isPending} onConfirm={() => revoke && revokeKey.mutate(revoke.id)} />
      <ConfirmDialog open={!!regen} onClose={() => setRegen(null)} tone="primary" title={`Regenerate "${regen?.name}"?`} description="The current key stops working immediately and a new one is issued with the same settings." confirmLabel="Regenerate" loading={regenKey.isPending} onConfirm={() => regen && regenKey.mutate(regen.id)} />
    </div>
  );
}

export function ApiLogsPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [path, setPath] = useState('');
  const [requestId, setRequestId] = useState('');
  const [apiKeyId, setApiKeyId] = useState('');
  const [day, setDay] = useState('');
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: developerService.apiKeys });
  const usage = useQuery({ queryKey: ['api-usage'], queryFn: developerService.usage, refetchInterval: 15_000 });
  const filters = {
    status: status || undefined,
    path: path || undefined,
    requestId: requestId || undefined,
    apiKeyId: apiKeyId || undefined,
    from: day ? new Date(`${day}T00:00:00`).toISOString() : undefined,
    to: day ? new Date(`${day}T23:59:59`).toISOString() : undefined,
  };
  const q = useQuery({ queryKey: ['api-logs', page, filters], queryFn: () => developerService.logs({ page, limit: 20, ...filters }), refetchInterval: 10_000, placeholderData: (p) => p });
  return (
    <div className="space-y-6">
      <PageHeader title="API logs & usage" description="Requests made with your API keys." breadcrumbs={[{ label: 'Developer' }, { label: 'API logs' }]} />
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Requests (24h)" icon={<Activity />} value={fmtNumber(usage.data?.last24h.requests)} loading={usage.isLoading} />
        <StatCard label="Errors (24h)" icon={<AlertTriangle />} tone="red" value={fmtNumber(usage.data?.last24h.errors)} loading={usage.isLoading} />
        <StatCard label="SMS via API (14d)" icon={<Send />} tone="emerald" value={fmtNumber(usage.data?.smsViaApi14d)} loading={usage.isLoading} />
      </div>
      <Card padded={false}>
        <CardHeader title="Requests per day" description="Last 14 days" />
        <div className="p-4">
          {usage.data?.daily.length ? (
            <CountBarChart
              data={usage.data.daily}
              xKey="date"
              xFormat={(d) => d.slice(5)}
              series={[
                { key: 'requests', label: 'Requests', color: INK },
                { key: 'errors', label: 'Errors', color: RED },
              ]}
            />
          ) : (
            <p className="py-12 text-center text-sm text-slate-400">No API traffic yet</p>
          )}
        </div>
      </Card>
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All responses</option>
            <option value="success">Success (2xx)</option>
            <option value="error">Errors (4xx/5xx)</option>
          </Select>
          <Select value={apiKeyId} onChange={(e) => { setApiKeyId(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All API keys</option>
            {keys.data?.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </Select>
          <Input value={path} onChange={(e) => { setPath(e.target.value); setPage(1); }} placeholder="Endpoint, e.g. /sms/send" className="w-52" />
          <Input value={requestId} onChange={(e) => { setRequestId(e.target.value.trim()); setPage(1); }} placeholder="Request ID" className="w-52 font-mono" />
          <Input type="date" value={day} onChange={(e) => { setDay(e.target.value); setPage(1); }} className="w-auto" />
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'time', header: 'Time', cell: (l) => <span className="text-slate-500">{fmtDateTime(l.createdAt)}</span> },
            { key: 'req', header: 'Request', cell: (l) => <span className="font-mono text-xs"><span className="mr-2 font-semibold text-brand-700">{l.method}</span>{l.path}</span> },
            { key: 'status', header: 'Status', cell: (l) => <Badge color={l.statusCode < 400 ? 'green' : l.statusCode < 500 ? 'amber' : 'red'}>{l.statusCode}{l.errorCode ? ` · ${l.errorCode}` : ''}</Badge> },
            { key: 'dur', header: 'Duration', cell: (l) => <span className="tabular-nums text-slate-500">{l.durationMs} ms</span> },
            { key: 'key', header: 'Key', cell: (l) => l.apiKey ? <span className="text-xs">{l.apiKey.name} <span className="font-mono text-slate-400">{l.apiKey.prefix}</span></span> : '—' },
            { key: 'ip', header: 'IP', cell: (l) => <span className="font-mono text-xs text-slate-500">{l.ipAddress}</span> },
            { key: 'rid', header: 'Request ID', cell: (l) => <span className="font-mono text-xs text-slate-400" title={l.requestId ?? undefined}>{l.requestId?.slice(0, 13)}</span> },
          ]}
          empty={<EmptyState icon={<Activity />} title="No API requests yet" description="Make your first request using the examples in the documentation." action={<LinkButton to="/app/developer/docs" variant="secondary">Open docs</LinkButton>} />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

function DeliveriesDrawer({ hook, onClose }: { hook: Webhook | null; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['webhook-deliveries', hook?.id, page], queryFn: () => developerService.deliveries(hook!.id, { page, limit: 15 }), enabled: !!hook, refetchInterval: 4000 });
  const redeliver = useApiMutation((id: string) => developerService.redeliver(id), { success: 'Redelivery queued', invalidate: [['webhook-deliveries']] });
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Drawer open={!!hook} onClose={onClose} title="Recent deliveries" description={hook?.url} width="max-w-2xl">
      {q.isLoading ? <TableSkeleton rows={5} cols={3} /> : !q.data?.data.length ? <EmptyState icon={<WebhookIcon />} title="No deliveries yet" description="Send a test event or trigger an event (e.g. send an SMS)." /> : (
        <div className="space-y-2">
          {q.data.data.map((d) => (
            <div key={d.id} className="rounded-xl border border-slate-200">
              <button className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                <span className="flex items-center gap-3"><StatusBadge status={d.status} /><span className="font-mono text-xs font-medium">{d.event}</span></span>
                <span className="text-xs text-slate-500">{d.responseStatus ? `HTTP ${d.responseStatus} · ` : ''}{d.attempts} attempt(s) · {fmtRelative(d.createdAt)}</span>
              </button>
              {expanded === d.id && (
                <div className="space-y-3 border-t border-slate-100 p-4 text-xs">
                  {d.lastError && <p className="text-red-600">Last error: {d.lastError}</p>}
                  {d.nextAttemptAt && <p className="text-slate-500">Next retry: {fmtDateTime(d.nextAttemptAt)}</p>}
                  <pre className="scrollbar-thin max-h-60 overflow-auto rounded-lg bg-ink-950 p-3 font-mono text-xs text-slate-200">{JSON.stringify(d.payload, null, 2)}</pre>
                  {d.status !== 'SUCCESS' && <Button size="xs" variant="secondary" icon={<RefreshCw className="h-3 w-3" />} onClick={() => redeliver.mutate(d.id)}>Redeliver</Button>}
                </div>
              )}
            </div>
          ))}
          <Pagination pagination={q.data.pagination} onPage={setPage} />
        </div>
      )}
    </Drawer>
  );
}

export function WebhooksPage() {
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['webhooks'], queryFn: developerService.webhooks });
  const events = useQuery({ queryKey: ['webhook-events'], queryFn: developerService.webhookEvents });
  const [modal, setModal] = useState(false);
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['sms.delivered', 'sms.failed']);
  const [secret, setSecret] = useState<string | null>(null);
  const [del, setDel] = useState<Webhook | null>(null);
  const [deliveries, setDeliveries] = useState<Webhook | null>(null);
  const inv = [['webhooks']];
  const create = useApiMutation(() => developerService.createWebhook({ url, description, events: selectedEvents }), { invalidate: inv, onSuccess: (d) => { setModal(false); setUrl(''); setDescription(''); setSecret(d.secret); } });
  const toggle = useApiMutation((h: Webhook) => developerService.updateWebhook(h.id, { isActive: !h.isActive }), { invalidate: inv, success: 'Webhook updated' });
  const test = useApiMutation((id: string) => developerService.testWebhook(id), { success: 'Test event queued — check deliveries', invalidate: [['webhook-deliveries']] });
  const rotate = useApiMutation((id: string) => developerService.rotateSecret(id), { onSuccess: (d) => setSecret(d.secret) });
  const remove = useApiMutation((id: string) => developerService.deleteWebhook(id), { success: 'Webhook deleted', invalidate: inv, onSuccess: () => setDel(null) });

  return (
    <div className="space-y-6">
      <PageHeader title="Webhooks" description="Receive signed HTTP callbacks when messages are delivered, campaigns finish or payments complete." breadcrumbs={[{ label: 'Developer' }, { label: 'Webhooks' }]} actions={can('webhooks.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setModal(true)}>Add endpoint</Button>} />
      {q.isLoading ? <Card padded={false}><TableSkeleton rows={2} /></Card> : q.error ? <Card><ErrorState error={q.error} /></Card> : !q.data?.length ? (
        <Card><EmptyState icon={<WebhookIcon />} title="No webhook endpoints" description="Add an HTTPS endpoint to receive delivery reports in real time." action={can('webhooks.create') && <Button onClick={() => setModal(true)}>Add endpoint</Button>} /></Card>
      ) : (
        <div className="space-y-3">
          {q.data.map((h) => (
            <Card key={h.id} className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={cn('h-2 w-2 rounded-full', h.isActive ? 'bg-emerald-500' : 'bg-slate-300')} />
                  <p className="truncate font-mono text-sm font-medium text-slate-900">{h.url}</p>
                </div>
                {h.description && <p className="mt-0.5 text-sm text-slate-500">{h.description}</p>}
                <div className="mt-2 flex flex-wrap gap-1">{h.events.map((e) => <Badge key={e} color="violet">{e}</Badge>)}</div>
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-500">
                <span>7d: <strong className="text-emerald-600">{h.stats7d?.success ?? 0}</strong> ok · <strong className="text-red-600">{h.stats7d?.failed ?? 0}</strong> failed · <strong>{h.stats7d?.pending ?? 0}</strong> pending</span>
                {can('webhooks.update') && <Switch checked={h.isActive} onChange={() => toggle.mutate(h)} label="Active" />}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setDeliveries(h)}>Deliveries</Button>
                {can('webhooks.update') && <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} loading={test.isPending && test.variables === h.id} onClick={() => test.mutate(h.id)}>Test</Button>}
                <Dropdown trigger={<IconButton label="More"><MoreHorizontal className="h-4 w-4" /></IconButton>}>
                  {(close) => (
                    <>
                      {can('webhooks.update') && <MenuItem icon={<RotateCw />} onClick={() => { close(); rotate.mutate(h.id); }}>Rotate signing secret</MenuItem>}
                      {can('webhooks.delete') && <MenuItem icon={<Trash2 />} danger onClick={() => { close(); setDel(h); }}>Delete</MenuItem>}
                    </>
                  )}
                </Dropdown>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Modal open={modal} onClose={() => setModal(false)} title="Add webhook endpoint" footer={<><Button variant="secondary" onClick={() => setModal(false)}>Cancel</Button><Button disabled={!url || !selectedEvents.length} loading={create.isPending} onClick={() => create.mutate(undefined)}>Add endpoint</Button></>}>
        <div className="space-y-4">
          <Field label="Endpoint URL" required hint="Must be HTTPS in production."><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhooks/sms" className="font-mono" /></Field>
          <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <div>
            <p className="label">Events</p>
            <div className="grid gap-2 sm:grid-cols-2">{(events.data ?? []).map((e) => <Checkbox key={e} label={<span className="font-mono text-xs">{e}</span>} checked={selectedEvents.includes(e)} onChange={(ev) => setSelectedEvents((x) => (ev.target.checked ? [...x, e] : x.filter((i) => i !== e)))} />)}</div>
          </div>
        </div>
      </Modal>
      <SecretReveal open={!!secret} onClose={() => setSecret(null)} title="Signing secret" secret={secret ?? ''} note="Use this secret to verify the X-SmsGateway-Signature header on every webhook request. It won’t be shown again." />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title="Delete this endpoint?" description="No further events will be delivered to it." confirmLabel="Delete" loading={remove.isPending} onConfirm={() => del && remove.mutate(del.id)} />
      <DeliveriesDrawer hook={deliveries} onClose={() => setDeliveries(null)} />
    </div>
  );
}
