import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Plug, Plus, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import type { ApiScope, IntegrationClient } from '@/services/adminService';
import { adminService } from '@/services/adminService';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert, EmptyState } from '@/components/ui/Feedback';
import { Field, Input, Switch } from '@/components/ui/Form';
import { ConfirmDialog, Drawer, Modal } from '@/components/ui/Overlay';
import { DataTable } from '@/components/ui/Table';
import { PageHeader } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { fmtDateTime, fmtNumber, fmtRelative, titleCase } from '@/utils/format';

const useScopes = () => useQuery({ queryKey: ['admin', 'api-scopes'], queryFn: adminService.apiScopes, staleTime: 5 * 60_000 });

function ScopeList({ scopes, selected, onToggle, disabled }: { scopes: ApiScope[]; selected: string[]; onToggle: (key: string) => void; disabled?: boolean }) {
  return (
    <div className="space-y-2">
      {scopes.map((s) => (
        <label key={s.key} className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
          <input type="checkbox" className="mt-1" disabled={disabled} checked={selected.includes(s.key)} onChange={() => onToggle(s.key)} />
          <span>
            <span className="block text-sm font-medium text-slate-900">{s.label} <code className="ml-1 font-mono text-xs text-slate-400">{s.key}</code></span>
            <span className="block text-xs text-slate-500">{s.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Platform permissions grouped by area, with select-all per group and a marker on high-risk ones. */
function GroupedScopeList({ scopes, selected, onChange }: { scopes: ApiScope[]; selected: string[]; onChange: (next: string[]) => void }) {
  const groups = [...new Set(scopes.map((s) => s.group))];
  const keysIn = (g: string) => scopes.filter((s) => s.group === g).map((s) => s.key);
  const preset = (pick: (s: ApiScope) => boolean) => onChange(scopes.filter(pick).map((s) => s.key));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="secondary" onClick={() => preset((s) => s.key.endsWith('.view'))}>Read-only</Button>
        <Button size="xs" variant="secondary" onClick={() => preset((s) => !s.highRisk)}>Everything except high-risk</Button>
        <Button size="xs" variant="secondary" onClick={() => preset(() => true)}>Everything</Button>
        <Button size="xs" variant="ghost" onClick={() => onChange([])}>Clear</Button>
        <span className="self-center text-xs text-slate-500">{selected.length} selected</span>
      </div>
      <div className="max-h-80 space-y-3 overflow-y-auto rounded-lg border border-slate-200 p-3">
        {groups.map((g) => {
          const keys = keysIn(g);
          const all = keys.every((k) => selected.includes(k));
          return (
            <div key={g}>
              <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <input type="checkbox" checked={all} onChange={() => onChange(all ? selected.filter((k) => !keys.includes(k)) : [...new Set([...selected, ...keys])])} />
                {g}
              </label>
              <div className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {scopes.filter((s) => s.group === g).map((s) => (
                  <label key={s.key} title={s.description} className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={selected.includes(s.key)} onChange={() => onChange(toggleIn(selected, s.key))} />
                    <code className="font-mono text-xs">{s.key}</code>
                    {s.highRisk && <span className="rounded bg-red-50 px-1 text-[10px] font-medium text-red-700">high-risk</span>}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const toggleIn = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

/** Super-admin management of credentials for trusted external systems (platform level). */
export function IntegrationsPage() {
  const { canAdmin } = usePermissions();
  const manage = canAdmin('integrations.manage');
  const list = useQuery({ queryKey: ['admin', 'integrations'], queryFn: adminService.integrations });
  const scopes = useScopes();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<IntegrationClient | null>(null);
  const [activity, setActivity] = useState<IntegrationClient | null>(null);
  const toggle = useApiMutation(({ id, enabled }: { id: string; enabled: boolean }) => adminService.setIntegrationEnabled(id, enabled), { success: (_d, v) => (v.enabled ? 'Credential enabled' : 'Credential disabled'), invalidate: [['admin', 'integrations']] });
  const revokeM = useApiMutation((id: string) => adminService.revokeIntegration(id), { success: 'Credential revoked', invalidate: [['admin', 'integrations']], onSuccess: () => setRevoke(null) });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Credentials for trusted external systems (for example the finance system). Each one has only the scopes you grant, can be limited to specific IP addresses, and can be disabled or revoked at any time."
        actions={manage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New credential</Button>}
      />
      <Card padded={false}>
        <DataTable
          rows={list.data}
          loading={list.isLoading}
          error={list.error}
          columns={[
            { key: 'n', header: 'System', cell: (c) => <span><span className="block font-medium">{c.name}</span><code className="font-mono text-xs text-slate-500">{c.maskedKey}</code></span> },
            { key: 's', header: 'Access', cell: (c) => <span className="flex flex-wrap gap-1">{c.scopes.map((s) => <code key={s} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px]">{s}</code>)}</span> },
            { key: 'i', header: 'Allowed IPs', cell: (c) => (c.allowedIps.length ? c.allowedIps.join(', ') : <span className="text-amber-700">Any IP</span>) },
            { key: 'u', header: 'Last used', cell: (c) => (c.lastUsedAt ? `${fmtRelative(c.lastUsedAt)} · ${fmtNumber(c.usageCount)} calls` : 'Never') },
            { key: 'e', header: 'Expires', cell: (c) => (c.expiresAt ? fmtDateTime(c.expiresAt) : 'Never') },
            { key: 't', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
            {
              key: 'a',
              header: '',
              className: 'text-right',
              cell: (c) => (
                <span className="inline-flex gap-2">
                  <Button size="xs" variant="secondary" onClick={() => setActivity(c)}>Activity</Button>
                  {manage && (c.status === 'ACTIVE' || c.status === 'DISABLED') && (
                    <>
                      <Button size="xs" variant="secondary" loading={toggle.isPending && toggle.variables?.id === c.id} onClick={() => toggle.mutate({ id: c.id, enabled: c.status === 'DISABLED' })}>{c.status === 'DISABLED' ? 'Enable' : 'Disable'}</Button>
                      <Button size="xs" variant="secondary" className="text-red-600" onClick={() => setRevoke(c)}>Revoke</Button>
                    </>
                  )}
                </span>
              ),
            },
          ]}
          empty={<EmptyState icon={<Plug />} title="No integrations yet" description="Create a credential to let an external system call the API." />}
        />
      </Card>

      <CreateCredentialModal open={creating} scopes={(scopes.data ?? []).filter((s) => s.level === 'PLATFORM')} onClose={() => setCreating(false)} onCreated={(s) => { setCreating(false); setSecret(s); }} />
      <Modal open={!!secret} onClose={() => setSecret(null)} title="Copy this key now" description="For security it is shown only once and cannot be retrieved later." footer={<Button onClick={() => setSecret(null)}>I have saved it</Button>}>
        <div className="flex items-center gap-2 rounded-lg bg-slate-900 p-3">
          <code className="min-w-0 flex-1 break-all font-mono text-xs text-slate-100">{secret}</code>
          <Button size="xs" variant="secondary" icon={<Copy className="h-3 w-3" />} onClick={() => secret && navigator.clipboard.writeText(secret).then(() => toast.success('Copied'))}>Copy</Button>
        </div>
        <p className="mt-3 text-xs text-slate-500">Send it as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code> over HTTPS only.</p>
      </Modal>
      <ConfirmDialog open={!!revoke} onClose={() => setRevoke(null)} title={`Revoke “${revoke?.name}”?`} description="The external system loses access immediately. This cannot be undone — issue a new credential if needed." confirmLabel="Revoke" loading={revokeM.isPending} onConfirm={() => revoke && revokeM.mutate(revoke.id)} />
      <ActivityDrawer client={activity} onClose={() => setActivity(null)} />
    </div>
  );
}

function CreateCredentialModal({ open, scopes, onClose, onCreated }: { open: boolean; scopes: ApiScope[]; onClose: () => void; onCreated: (secret: string) => void }) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [ips, setIps] = useState('');
  const [expires, setExpires] = useState('');
  useEffect(() => {
    if (open) (setName(''), setSelected([]), setIps(''), setExpires(''));
  }, [open]);
  const risky = scopes.filter((s) => s.highRisk && selected.includes(s.key)).map((s) => s.key);
  const missingLimits = risky.length > 0 && (!ips.trim() || !expires);
  const create = useApiMutation(
    () =>
      adminService.createIntegration({
        name,
        scopes: selected,
        allowedIps: ips.split(/[\s,]+/).filter(Boolean),
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
      }),
    { invalidate: [['admin', 'integrations']], onSuccess: (r) => onCreated((r as { secret: string }).secret) },
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New integration credential"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={create.isPending} disabled={name.trim().length < 2 || selected.length === 0 || missingLimits} onClick={() => create.mutate(undefined)}>Create credential</Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="System name" required hint="For example “Finance system”.">
          <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="What may it do?" required>
          <GroupedScopeList scopes={scopes} selected={selected} onChange={setSelected} />
        </Field>
        {risky.length > 0 && (
          <Alert tone="warning" title="High-risk permissions selected">
            {risky.join(', ')} can move money or change access. This credential must have allowed IP addresses and an expiry date.
          </Alert>
        )}
        <Field label="Allowed IP addresses" hint="Separate with commas or spaces. Required in production and for high-risk permissions.">
          <Input value={ips} placeholder="203.0.113.10, 203.0.113.11" onChange={(e) => setIps(e.target.value)} />
        </Field>
        <Field label={risky.length ? 'Expires on' : 'Expires on (optional)'} required={risky.length > 0}>
          <Input type="date" value={expires} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpires(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ActivityDrawer({ client, onClose }: { client: IntegrationClient | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['admin', 'integration-activity', client?.id], queryFn: () => adminService.integrationActivity(client!.id), enabled: !!client });
  return (
    <Drawer open={!!client} onClose={onClose} title={client?.name ?? ''} description="What this credential has read or changed (latest 100)">
      {q.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : !q.data?.length ? <EmptyState title="No activity yet" className="py-8" /> : (
        <ul className="divide-y divide-slate-100">
          {q.data.map((a) => (
            <li key={a.id} className="py-3 text-sm">
              <p className="font-medium text-slate-900">{titleCase(a.action.replace('INTEGRATION_', ''))}</p>
              <p className="text-xs text-slate-500">{fmtDateTime(a.createdAt)} · {a.ipAddress ?? 'unknown IP'}</p>
              {a.metadata?.decision != null && <p className="text-xs text-slate-600">Decision: {String(a.metadata.decision)}</p>}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

/** Platform control over an organization's own API keys: on/off and a cap on the scopes. */
export function OrganizationApiAccess({ organizationId }: { organizationId: string }) {
  const { canAdmin } = usePermissions();
  const editable = canAdmin('api_keys.revoke');
  const org = useQuery({ queryKey: ['admin', 'org', organizationId], queryFn: () => adminService.organization(organizationId) });
  const scopes = useScopes();
  const orgScopes = (scopes.data ?? []).filter((s) => s.level === 'ORGANIZATION');
  const [enabled, setEnabled] = useState(true);
  const [allowed, setAllowed] = useState<string[]>([]);
  useEffect(() => {
    if (!org.data || !scopes.data) return;
    setEnabled(org.data.apiAccessEnabled);
    setAllowed(org.data.apiAllowedScopes ?? orgScopes.map((s) => s.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.data, scopes.data]);
  const save = useApiMutation(
    () => adminService.setOrganizationApiAccess(organizationId, { enabled, allowedScopes: allowed.length === orgScopes.length ? null : allowed }),
    { success: 'API access updated', invalidate: [['admin', 'org', organizationId]] },
  );
  if (!org.data || !scopes.data) return null;
  return (
    <div className="border-b border-slate-100">
      <CardHeader title="API access" description="Controls every API key this organization creates. Changes apply immediately to existing keys." />
      <div className="space-y-4 px-5 pb-5">
        <div className="flex items-center gap-3 text-sm text-slate-700">
          <Switch checked={enabled} disabled={!editable} onChange={setEnabled} label="API access enabled" />
          {enabled ? 'API access is enabled' : <span className="text-red-600">API access is switched off — all keys are rejected</span>}
        </div>
        {enabled && (
          <>
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500"><ShieldCheck className="h-3.5 w-3.5" /> Scopes this organization may use</p>
            <ScopeList scopes={orgScopes} selected={allowed} disabled={!editable} onToggle={(k) => setAllowed((l) => toggleIn(l, k))} />
            {allowed.length === 0 && <Alert tone="warning" title="No scopes selected">Keys will authenticate but cannot do anything. Switch API access off instead if that is the intent.</Alert>}
          </>
        )}
        {editable && <Button size="sm" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save API access</Button>}
      </div>
    </div>
  );
}
