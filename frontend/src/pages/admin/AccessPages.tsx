import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FlaskConical, KeyRound, Plus, Radio, ScrollText, Server, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AuditLog, Role } from '@/api/types';
import type { Setting } from '@/services/adminService';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Switch, Textarea } from '@/components/ui/Form';
import { ConfirmDialog, Drawer, Modal } from '@/components/ui/Overlay';
import { DataTable, Pagination } from '@/components/ui/Table';
import { PageHeader, Tabs } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { adminService } from '@/services/adminService';
import { businessService } from '@/services/businessService';
import { fmtDateTime, fmtNumber, fmtRelative, titleCase } from '@/utils/format';
import { SegmentationSummaryCard } from './SmsConfigurationPage';
import { PermissionMatrix } from '../settings/SettingsPages';
import { RequirementsEditor } from './RequirementsEditor';

export function AdminApiKeysPage() {
  const { canAdmin } = usePermissions();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('active');
  const [revoke, setRevoke] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['admin', 'api-keys', page, status], queryFn: () => adminService.apiKeys({ page, limit: 20, status: status || undefined }) });
  const toggle = useApiMutation(({ id, enabled }: { id: string; enabled: boolean }) => adminService.setApiKeyEnabled(id, enabled), { success: (_d, v) => (v.enabled ? 'API key enabled' : 'API key disabled'), invalidate: [['admin', 'api-keys']] });
  const revokeM = useApiMutation((id: string) => adminService.revokeApiKey(id), { success: 'API key revoked', invalidate: [['admin', 'api-keys']], onSuccess: () => setRevoke(null) });
  return (
    <div className="space-y-6">
      <PageHeader title="API keys" description="Customer API keys across the platform (secrets are never visible)." />
      <Card padded={false}>
        <div className="border-b border-slate-100 p-4">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto"><option value="active">Active</option><option value="revoked">Revoked</option><option value="">All</option></Select>
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'n', header: 'Key', cell: (k) => <span><span className="block font-medium">{k.name}</span><code className="font-mono text-xs text-slate-500">{k.maskedKey}</code></span> },
            { key: 'o', header: 'Organization', cell: (k) => <Link to={`/admin/organizations/${k.organization?.id}`} className="link">{k.organization?.name}</Link> },
            { key: 'u', header: 'Requests', cell: (k) => fmtNumber(k.usageCount) },
            { key: 'l', header: 'Last used', cell: (k) => (k.lastUsedAt ? `${fmtRelative(k.lastUsedAt)} · ${k.lastUsedIp ?? ''}` : 'Never') },
            { key: 's', header: 'Status', cell: (k) => <StatusBadge status={k.status} /> },
            { key: 'a', header: '', className: 'text-right', cell: (k) => canAdmin('api_keys.revoke') && (k.status === 'ACTIVE' || k.status === 'DISABLED') && (
              <span className="inline-flex gap-2">
                <Button size="xs" variant="secondary" loading={toggle.isPending && toggle.variables?.id === k.id} onClick={() => toggle.mutate({ id: k.id, enabled: k.status === 'DISABLED' })}>{k.status === 'DISABLED' ? 'Enable' : 'Disable'}</Button>
                <Button size="xs" variant="secondary" className="text-red-600" onClick={() => setRevoke(k.id)}>Revoke</Button>
              </span>
            ) },
          ]}
          empty={<EmptyState icon={<KeyRound />} title="No API keys" />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
      <ConfirmDialog open={!!revoke} onClose={() => setRevoke(null)} title="Revoke this API key?" description="The customer’s integration will stop working immediately." confirmLabel="Revoke" loading={revokeM.isPending} onConfirm={() => revoke && revokeM.mutate(revoke)} />
    </div>
  );
}

export function RolesPage() {
  const { canAdmin } = usePermissions();
  const [tab, setTab] = useState<'platform' | 'org'>('platform');
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: adminService.roles });
  const perms = useQuery({ queryKey: ['admin', 'permissions', 'PLATFORM'], queryFn: () => adminService.permissions('PLATFORM') });
  const orgRoles = useQuery({ queryKey: ['admin', 'org-roles'], queryFn: adminService.orgRoleTemplates, enabled: tab === 'org' });
  const orgPerms = useQuery({ queryKey: ['admin', 'permissions', 'ORGANIZATION'], queryFn: () => adminService.permissions('ORGANIZATION'), enabled: tab === 'org' });
  const [create, setCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [del, setDel] = useState<Role | null>(null);
  const inv = [['admin', 'roles']];
  const toggle = useApiMutation(({ role, key, on }: { role: Role; key: string; on: boolean }) => adminService.updateRole(role.id, { permissions: on ? [...role.permissions, key] : role.permissions.filter((k) => k !== key) }), { success: 'Permissions updated', invalidate: inv });
  const createRole = useApiMutation(() => adminService.createRole({ name, description, permissions: picked }), { success: 'Role created', invalidate: inv, onSuccess: () => { setCreate(false); setName(''); setDescription(''); setPicked([]); } });
  const remove = useApiMutation((id: string) => adminService.deleteRole(id), { success: 'Role deleted', invalidate: inv, onSuccess: () => setDel(null) });

  return (
    <div className="space-y-6">
      <PageHeader title="Roles & permissions" description="Permission-based access control. Changes apply immediately to every request." actions={tab === 'platform' && canAdmin('roles.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreate(true)}>New role</Button>} />
      <Tabs tabs={[{ value: 'platform', label: 'Platform roles' }, { value: 'org', label: 'Customer role templates' }]} value={tab} onChange={setTab} />
      {tab === 'platform' ? (
        roles.isLoading || perms.isLoading ? <PageLoader /> : roles.error ? <Card><ErrorState error={roles.error} /></Card> : (
          <>
            <Alert tone="info">Super Admin always holds every permission. You can only grant permissions you hold yourself; changes are recorded in the audit log.</Alert>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              {roles.data?.map((r) => (
                <Card key={r.id} className="p-4">
                  <div className="flex items-start justify-between">
                    <p className="font-semibold text-slate-900">{r.name}</p>
                    {r.fullAccess ? <Badge color="violet">full</Badge> : r.isSystem ? <Badge>system</Badge> : <Badge color="blue">custom</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-500">{r.description}</p>
                  <p className="mt-3 text-xs text-slate-600">{r.permissions.length} permissions · {r.assignedCount} user(s)</p>
                  {!r.isSystem && canAdmin('roles.delete') && <button className="mt-2 flex items-center gap-1 text-xs font-medium text-red-600 hover:underline" onClick={() => setDel(r)}><Trash2 className="h-3 w-3" />Delete</button>}
                </Card>
              ))}
            </div>
            <Card padded={false}>
              <CardHeader title="Permission matrix" description={canAdmin('roles.update') ? 'Tick to grant, untick to revoke.' : 'Read-only'} />
              <PermissionMatrix roles={roles.data ?? []} permissions={perms.data ?? []} canEdit={(r) => r.editable && canAdmin('roles.update')} onToggle={(role, key, on) => toggle.mutate({ role, key, on })} />
            </Card>
          </>
        )
      ) : orgRoles.isLoading || orgPerms.isLoading ? <PageLoader /> : (
        <Card padded={false}>
          <CardHeader title="Built-in customer roles" description="Owner, Manager and Staff roles available to every organization. Organizations can add custom roles of their own." />
          <PermissionMatrix roles={orgRoles.data ?? []} permissions={orgPerms.data ?? []} />
        </Card>
      )}
      <Modal open={create} onClose={() => setCreate(false)} title="New platform role" size="lg" footer={<><Button variant="secondary" onClick={() => setCreate(false)}>Cancel</Button><Button disabled={name.trim().length < 2} loading={createRole.isPending} onClick={() => createRole.mutate(undefined)}>Create role</Button></>}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Compliance" /></Field>
            <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">{perms.data?.map((p) => <Checkbox key={p.key} label={<span className="font-mono text-xs">{p.key}</span>} description={p.description} checked={picked.includes(p.key)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, p.key] : x.filter((k) => k !== p.key)))} />)}</div>
        </div>
      </Modal>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={`Delete "${del?.name}"?`} description="Only roles with no assigned users can be deleted." confirmLabel="Delete" loading={remove.isPending} onConfirm={() => del && remove.mutate(del.id)} />
    </div>
  );
}

export function AuditLogsPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const debounced = useDebounce(action);
  const [selected, setSelected] = useState<AuditLog | null>(null);
  const q = useQuery({ queryKey: ['admin', 'audit', page, debounced], queryFn: () => adminService.auditLogs({ page, limit: 25, action: debounced || undefined }), placeholderData: (p) => p });
  return (
    <div className="space-y-6">
      <PageHeader title="Audit logs" description="Immutable record of sensitive actions. Entries cannot be edited or deleted — even at the database level." />
      <Card padded={false}>
        <div className="border-b border-slate-100 p-4"><Input placeholder="Filter by action, e.g. WALLET or APPROVED" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} className="max-w-sm" /></div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          onRowClick={setSelected}
          columns={[
            { key: 't', header: 'Time', cell: (a) => <span className="text-slate-500">{fmtDateTime(a.createdAt)}</span> },
            { key: 'a', header: 'Action', cell: (a) => <Badge color={/REJECT|SUSPEND|REVOKE|DEBIT|FAILED|REUSE/.test(a.action) ? 'red' : /APPROV|CREDIT|VERIFIED|SUCCESS/.test(a.action) ? 'green' : 'violet'}>{a.action}</Badge> },
            { key: 'ac', header: 'Actor', cell: (a) => (a.actorType === 'USER' ? <span>{a.actor?.fullName ?? a.actorEmail}<span className="block text-xs text-slate-400">{a.actor?.email}</span></span> : <Badge>{a.actorType === 'API_KEY' ? 'API key' : 'System'}</Badge>) },
            { key: 'o', header: 'Organization', cell: (a) => (a.organization ? <Link to={`/admin/organizations/${a.organization.id}`} onClick={(e) => e.stopPropagation()} className="link">{a.organization.name}</Link> : '—') },
            { key: 'r', header: 'Resource', cell: (a) => <span className="text-slate-500">{titleCase(a.resource)}</span> },
            { key: 'ip', header: 'IP', cell: (a) => <span className="font-mono text-xs text-slate-500">{a.ipAddress ?? '—'}</span> },
          ]}
          empty={<EmptyState icon={<ScrollText />} title="No audit records" />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected?.action ?? ''} description={selected ? fmtDateTime(selected.createdAt) : undefined}>
        {selected && (
          <pre className="whitespace-pre-wrap break-all rounded-xl bg-ink-950 p-4 font-mono text-xs text-slate-200">{JSON.stringify({ ...selected, actor: selected.actor?.email }, null, 2)}</pre>
        )}
      </Drawer>
    </div>
  );
}

function SettingRow({ s, editable }: { s: Setting; editable: boolean }) {
  const isBool = typeof s.value === 'boolean';
  const isNum = typeof s.value === 'number';
  const isStr = typeof s.value === 'string';
  const [draft, setDraft] = useState<string>(isStr ? (s.value as string) : isBool ? '' : JSON.stringify(s.value, null, isNum ? 0 : 2));
  useEffect(() => {
    setDraft(isStr ? (s.value as string) : isBool ? '' : JSON.stringify(s.value, null, isNum ? 0 : 2));
  }, [s.value, isStr, isBool, isNum]);
  const save = useApiMutation((value: unknown) => adminService.updateSetting(s.key, value), { success: 'Setting saved', invalidate: [['admin', 'settings']] });
  const submit = () => {
    try {
      save.mutate(isStr ? draft : isNum ? Number(draft) : JSON.parse(draft));
    } catch {
      toast.error('Invalid JSON value');
    }
  };
  return (
    <div className="grid gap-3 px-5 py-4 md:grid-cols-[280px_1fr]">
      <div>
        <p className="font-mono text-xs font-medium text-slate-800">{s.key}</p>
        <p className="mt-0.5 text-xs text-slate-500">{s.description}</p>
        {s.isDefault && <Badge className="mt-1">default</Badge>}
      </div>
      <div className="flex items-start gap-2">
        {isBool ? (
          <Switch checked={s.value as boolean} disabled={!editable || save.isPending} onChange={(v) => save.mutate(v)} label={s.key} />
        ) : (
          <>
            {isStr || isNum ? <Input value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!editable} type={isNum ? 'number' : 'text'} className="max-w-sm" /> : <Textarea rows={Math.min(10, draft.split('\n').length + 1)} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!editable} className="font-mono text-xs" />}
            {editable && <Button size="sm" variant="secondary" loading={save.isPending} onClick={submit}>Save</Button>}
          </>
        )}
      </div>
    </div>
  );
}

const REQUIREMENTS_KEY = 'verification.requiredDocuments';

export function SystemSettingsPage() {
  const { canAdmin } = usePermissions();
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: adminService.settings, enabled: canAdmin('settings.view') });
  const providers = useQuery({ queryKey: ['admin', 'provider-status'], queryFn: adminService.providers, enabled: canAdmin('providers.view'), refetchInterval: 30_000 });
  const accounts = useQuery({ queryKey: ['admin', 'providers'], queryFn: businessService.providers, enabled: canAdmin('providers.view') });
  const p = providers.data;
  const requirements = settings.data?.find((s) => s.key === REQUIREMENTS_KEY);
  return (
    <div className="space-y-6">
      <PageHeader title="System settings" description="Provider configuration and platform-wide business settings." />
      <SegmentationSummaryCard />
      {canAdmin('providers.view') && (
        <div className="grid gap-6 xl:grid-cols-2">
          <Card padded={false}>
            <CardHeader title="SMS providers" action={p && <Badge color={p.sms.isSimulation ? 'amber' : 'green'} dot>{p.sms.isSimulation ? 'Simulation' : 'Production'}</Badge>} />
            <div className="space-y-4 p-5 text-sm">
              <div className="flex items-center gap-3"><Radio className="h-5 w-5 text-brand-600" /><span>Mode: <strong className="font-mono">SMS_PROVIDER_MODE={p?.sms.mode}</strong></span></div>
              <p className="text-slate-500">
                Installed adapters: <span className="font-mono">{p?.sms.adapters.join(', ')}</span>. Each provider account chooses its mode in{' '}
                <Link to="/admin/providers" className="link">SMS providers</Link>; credentials live only in the server environment.
              </p>
              <div className="grid grid-cols-3 gap-3">
                {(accounts.data ?? []).map((a) => (
                  <div key={a.id} className="rounded-lg bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">{a.name}</p>
                    <p className="text-lg font-semibold tabular-nums">{fmtNumber(a.capacityBalance)}</p>
                    <p className="text-[11px] text-slate-400">SMS capacity</p>
                  </div>
                ))}
              </div>
              {p?.simulation && (
                <Alert tone="warning" title="Simulation rules">
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">{p.simulation.rules.map((r) => <li key={r}>{r}</li>)}</ul>
                </Alert>
              )}
            </div>
          </Card>
          <Card padded={false}>
            <CardHeader title="Payments & infrastructure" action={p && <Badge color={p.payments.isSimulation ? 'amber' : 'green'} dot>{p.payments.isSimulation ? 'Simulation' : 'Live'}</Badge>} />
            <div className="space-y-3 p-5 text-sm">
              <p className="flex items-center gap-2"><FlaskConical className="h-4 w-4 text-slate-400" />Payment provider: <strong className="font-mono">{p?.payments.active}</strong> <span className="text-slate-400">(PAYMENT_PROVIDER_MODE={p?.payments.mode})</span></p>
              <p className="flex items-center gap-2"><Server className="h-4 w-4 text-slate-400" />Job queue driver: <strong className="font-mono">{p?.queue}</strong> <span className="text-slate-400">(memory in dev, bullmq/Redis in production)</span></p>
              <p className="flex items-center gap-2"><Server className="h-4 w-4 text-slate-400" />Environment: <strong className="font-mono">{p?.environment}</strong></p>
            </div>
          </Card>
        </div>
      )}
      {canAdmin('settings.view') && requirements && <RequirementsEditor setting={requirements} editable={canAdmin('settings.update')} />}
      {canAdmin('settings.view') && (
        <Card padded={false}>
          <CardHeader title="Business settings" description="Validated on the server. Changes are audit logged." />
          {settings.isLoading ? <PageLoader /> : settings.error ? <ErrorState error={settings.error} /> : (
            <div className="divide-y divide-slate-100">{settings.data?.filter((s) => s.key !== REQUIREMENTS_KEY).map((s) => <SettingRow key={s.key} s={s} editable={canAdmin('settings.update')} />)}</div>
          )}
        </Card>
      )}
    </div>
  );
}
