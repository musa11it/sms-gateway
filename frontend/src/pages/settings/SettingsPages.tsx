import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { Bell, CheckCheck, Laptop, Lock, Mail, MoreHorizontal, Plus, ScrollText, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import type { Organization, PermissionDef, Role } from '@/api/types';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Overlay';
import { DataTable, Pagination } from '@/components/ui/Table';
import { Avatar, Dropdown, MenuItem, PageHeader, Tabs } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { useMe, usePermissions } from '@/hooks/useAuth';
import { authService } from '@/services/authService';
import { notificationService } from '@/services/notificationService';
import { organizationService } from '@/services/organizationService';
import { reportService } from '@/services/reportService';
import { cn, fmtDateTime, fmtRelative, titleCase } from '@/utils/format';
import { handleFormError } from '@/utils/forms';
import { PhoneVerification } from '../onboarding/OnboardingPage';

// ── Personal settings ───────────────────────────────────────────────────

export function SettingsPage() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  useEffect(() => {
    if (me) {
      setFullName(me.user.fullName);
      setPhone(me.user.phone ?? '');
    }
  }, [me]);
  const saveProfile = useApiMutation(() => authService.updateProfile({ fullName, phone: phone || null }), { success: 'Profile saved', onSuccess: () => void qc.invalidateQueries({ queryKey: ['me'] }) });
  const pwSchema = z
    .object({ currentPassword: z.string().min(1, 'Required'), newPassword: z.string().min(8, 'At least 8 characters').regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number'), confirm: z.string() })
    .refine((v) => v.newPassword === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });
  const pwForm = useForm<z.infer<typeof pwSchema>>({ resolver: zodResolver(pwSchema) });
  const changePw = useApiMutation((v: z.infer<typeof pwSchema>) => authService.changePassword(v.currentPassword, v.newPassword), {
    success: 'Password changed — other sessions were signed out',
    silentError: true,
    invalidate: [['sessions']],
    onSuccess: () => pwForm.reset(),
  });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: authService.sessions });
  const revoke = useApiMutation((id: string) => authService.revokeSession(id), { success: 'Session signed out', invalidate: [['sessions']] });

  return (
    <div className="space-y-6">
      <PageHeader title="Account settings" description="Your personal profile and security." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card padded={false}>
          <CardHeader title="Profile" />
          <div className="space-y-4 p-5">
            <div className="flex items-center gap-4">
              <Avatar name={me?.user.fullName ?? ''} size="lg" />
              <div>
                <p className="font-medium text-slate-900">{me?.user.fullName}</p>
                <p className="flex items-center gap-1.5 text-sm text-slate-500"><Mail className="h-3.5 w-3.5" />{me?.user.email} {me?.user.emailVerifiedAt && <Badge color="green">verified</Badge>}</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name"><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
              <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+250…" /></Field>
            </div>
            <div className="flex justify-end"><Button loading={saveProfile.isPending} onClick={() => saveProfile.mutate(undefined)}>Save profile</Button></div>
            {me?.user.phone && <PhoneVerification />}
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Change password" description="You’ll stay signed in here; other sessions are signed out." />
          <form className="space-y-4 p-5" onSubmit={pwForm.handleSubmit((v) => changePw.mutate(v, { onError: (e) => handleFormError(e, pwForm.setError) }))}>
            <Field label="Current password" error={pwForm.formState.errors.currentPassword?.message}><Input type="password" autoComplete="current-password" {...pwForm.register('currentPassword')} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="New password" error={pwForm.formState.errors.newPassword?.message}><Input type="password" autoComplete="new-password" {...pwForm.register('newPassword')} /></Field>
              <Field label="Confirm" error={pwForm.formState.errors.confirm?.message}><Input type="password" autoComplete="new-password" {...pwForm.register('confirm')} /></Field>
            </div>
            <div className="flex justify-end"><Button type="submit" icon={<Lock className="h-4 w-4" />} loading={changePw.isPending}>Update password</Button></div>
          </form>
        </Card>
      </div>
      <Card padded={false}>
        <CardHeader title="Active sessions" description="Devices currently signed in to your account." />
        <DataTable
          rows={sessions.data}
          loading={sessions.isLoading}
          error={sessions.error}
          columns={[
            { key: 'device', header: 'Device', cell: (s) => <span className="flex items-center gap-2"><Laptop className="h-4 w-4 text-slate-400" /><span className="block max-w-md truncate text-slate-700">{s.userAgent ?? 'Unknown device'}</span>{s.current && <Badge color="green">This device</Badge>}</span> },
            { key: 'ip', header: 'IP address', cell: (s) => <span className="font-mono text-xs">{s.ipAddress ?? '—'}</span> },
            { key: 'last', header: 'Last active', cell: (s) => fmtRelative(s.lastUsedAt) },
            { key: 'act', header: '', className: 'text-right', cell: (s) => !s.current && <Button size="xs" variant="secondary" onClick={() => revoke.mutate(s.id)}>Sign out</Button> },
          ]}
          empty={<EmptyState title="No sessions" />}
        />
      </Card>
    </div>
  );
}

// ── Organization ────────────────────────────────────────────────────────

function OrgProfileTab() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['organization'], queryFn: organizationService.get });
  const [form, setForm] = useState<Partial<Organization>>({});
  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);
  const save = useApiMutation(
    () =>
      organizationService.update({
        website: form.website || null,
        address: form.address,
        city: form.city,
        contactPersonName: form.contactPersonName,
        contactPersonPhone: form.contactPersonPhone,
        contactPersonEmail: form.contactPersonEmail || null,
        smsPurpose: form.smsPurpose,
        timezone: form.timezone,
      } as Partial<Organization>),
    { success: 'Organization updated', onSuccess: () => { void qc.invalidateQueries({ queryKey: ['organization'] }); void qc.invalidateQueries({ queryKey: ['me'] }); } },
  );
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const editable = can('organizations.update');
  const set = (k: keyof Organization) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Card padded={false}>
      <CardHeader title="Organization profile" description="Verified fields (name, registration, tax ID) can only be changed by support." action={<StatusBadge status={q.data.status} />} />
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Name"><Input value={q.data.name} disabled /></Field>
        <Field label="Business type"><Input value={q.data.businessType ?? ''} disabled /></Field>
        <Field label="Registration number"><Input value={q.data.registrationNumber ?? ''} disabled /></Field>
        <Field label="Tax ID"><Input value={q.data.taxId ?? ''} disabled /></Field>
        <Field label="Address"><Input value={form.address ?? ''} onChange={set('address')} disabled={!editable} /></Field>
        <Field label="City"><Input value={form.city ?? ''} onChange={set('city')} disabled={!editable} /></Field>
        <Field label="Website"><Input value={form.website ?? ''} onChange={set('website')} disabled={!editable} /></Field>
        <Field label="Timezone" hint="Used for reports and schedules"><Input value={form.timezone ?? ''} onChange={set('timezone')} disabled={!editable} /></Field>
        <Field label="Contact person"><Input value={form.contactPersonName ?? ''} onChange={set('contactPersonName')} disabled={!editable} /></Field>
        <Field label="Contact phone"><Input value={form.contactPersonPhone ?? ''} onChange={set('contactPersonPhone')} disabled={!editable} /></Field>
        <Field label="Contact email"><Input value={form.contactPersonEmail ?? ''} onChange={set('contactPersonEmail')} disabled={!editable} /></Field>
        <Field label="Purpose of SMS" className="sm:col-span-2"><Textarea rows={2} value={form.smsPurpose ?? ''} onChange={set('smsPurpose')} disabled={!editable} /></Field>
      </div>
      {editable && <div className="flex justify-end border-t border-slate-100 px-5 py-3"><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save changes</Button></div>}
    </Card>
  );
}

function TeamTab() {
  const { can } = usePermissions();
  const { data: me } = useMe();
  const members = useQuery({ queryKey: ['members'], queryFn: organizationService.members });
  const invitations = useQuery({ queryKey: ['invitations'], queryFn: organizationService.invitations, enabled: can('team.view') });
  const roles = useQuery({ queryKey: ['org-roles'], queryFn: organizationService.roles, enabled: can('roles.view') || can('team.invite') });
  const assignable = (roles.data ?? []).filter((r) => r.code !== 'CUSTOMER_OWNER');
  const [invite, setInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [remove, setRemove] = useState<string | null>(null);
  const sendInvite = useApiMutation(() => organizationService.invite(email, roleId), { success: `Invitation sent to ${email}`, invalidate: [['invitations']], onSuccess: () => { setInvite(false); setEmail(''); } });
  const revoke = useApiMutation((id: string) => organizationService.revokeInvitation(id), { success: 'Invitation revoked', invalidate: [['invitations']] });
  const update = useApiMutation(({ id, body }: { id: string; body: { roleId?: string; status?: 'ACTIVE' | 'DISABLED' } }) => organizationService.updateMember(id, body), { success: 'Member updated', invalidate: [['members']] });
  const del = useApiMutation((id: string) => organizationService.removeMember(id), { success: 'Member removed', invalidate: [['members']], onSuccess: () => setRemove(null) });
  const canManage = can('team.manage');
  return (
    <div className="space-y-6">
      <Card padded={false}>
        <CardHeader title="Members" description="People who can access this organization." action={can('team.invite') && <Button size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => { setRoleId(assignable.find((r) => r.code === 'CUSTOMER_STAFF')?.id ?? assignable[0]?.id ?? ''); setInvite(true); }}>Invite member</Button>} />
        <DataTable
          rows={members.data}
          loading={members.isLoading}
          error={members.error}
          columns={[
            { key: 'user', header: 'Member', cell: (m) => <span className="flex items-center gap-3"><Avatar name={m.user.fullName} size="sm" /><span><span className="block font-medium text-slate-900">{m.user.fullName} {m.user.id === me?.user.id && <span className="text-xs text-slate-400">(you)</span>}</span><span className="text-xs text-slate-500">{m.user.email}</span></span></span> },
            {
              key: 'role',
              header: 'Role',
              cell: (m) =>
                m.isOwner ? <Badge color="violet">Owner</Badge> : canManage && m.user.id !== me?.user.id ? (
                  <Select value={m.role.id} onChange={(e) => update.mutate({ id: m.id, body: { roleId: e.target.value } })} className="h-8 w-40 py-1 text-xs">
                    {assignable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </Select>
                ) : <Badge>{m.role.name}</Badge>,
            },
            { key: 'status', header: 'Status', cell: (m) => <StatusBadge status={m.status} /> },
            { key: 'last', header: 'Last sign-in', cell: (m) => <span className="text-slate-500">{m.user.lastLoginAt ? fmtRelative(m.user.lastLoginAt) : 'Never'}</span> },
            {
              key: 'act',
              header: '',
              className: 'text-right',
              cell: (m) =>
                canManage && !m.isOwner && m.user.id !== me?.user.id && (
                  <Dropdown trigger={<IconButton label="Actions"><MoreHorizontal className="h-4 w-4" /></IconButton>}>
                    {(close) => (
                      <>
                        <MenuItem onClick={() => { close(); update.mutate({ id: m.id, body: { status: m.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' } }); }}>{m.status === 'ACTIVE' ? 'Disable access' : 'Enable access'}</MenuItem>
                        <MenuItem danger icon={<Trash2 />} onClick={() => { close(); setRemove(m.id); }}>Remove</MenuItem>
                      </>
                    )}
                  </Dropdown>
                ),
            },
          ]}
          empty={<EmptyState icon={<Users />} title="No members" />}
        />
      </Card>
      {can('team.view') && (
        <Card padded={false}>
          <CardHeader title="Invitations" />
          <DataTable
            rows={invitations.data}
            loading={invitations.isLoading}
            columns={[
              { key: 'email', header: 'Email', cell: (i) => i.email },
              { key: 'role', header: 'Role', cell: (i) => <Badge>{i.role.name}</Badge> },
              { key: 'status', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
              { key: 'by', header: 'Invited by', cell: (i) => <span className="text-slate-500">{i.invitedBy.fullName} · {fmtRelative(i.createdAt)}</span> },
              { key: 'act', header: '', className: 'text-right', cell: (i) => i.status === 'PENDING' && can('team.invite') && <Button size="xs" variant="secondary" onClick={() => revoke.mutate(i.id)}>Revoke</Button> },
            ]}
            empty={<EmptyState icon={<Mail />} title="No invitations" description="Invite teammates and choose what they can do with roles." className="py-10" />}
          />
        </Card>
      )}
      <Modal open={invite} onClose={() => setInvite(false)} title="Invite a team member" footer={<><Button variant="secondary" onClick={() => setInvite(false)}>Cancel</Button><Button disabled={!email || !roleId} loading={sendInvite.isPending} onClick={() => sendInvite.mutate(undefined)}>Send invitation</Button></>}>
        <div className="space-y-4">
          <Field label="Email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@company.com" /></Field>
          <Field label="Role" required hint="You can only assign roles with access equal to or less than your own.">
            <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {assignable.map((r) => <option key={r.id} value={r.id}>{r.name}{r.isCustom ? ' (custom)' : ''}</option>)}
            </Select>
          </Field>
          {!import.meta.env.PROD && <Alert tone="info">Development: the invitation link appears in the <a className="font-medium underline" href="/dev/mailbox" target="_blank" rel="noreferrer">dev mailbox</a>.</Alert>}
        </div>
      </Modal>
      <ConfirmDialog open={!!remove} onClose={() => setRemove(null)} title="Remove this member?" description="They will immediately lose access to this organization." confirmLabel="Remove" loading={del.isPending} onConfirm={() => remove && del.mutate(remove)} />
    </div>
  );
}

export function PermissionMatrix({ roles, permissions, onToggle, canEdit }: { roles: Role[]; permissions: PermissionDef[]; onToggle?: (role: Role, key: string, on: boolean) => void; canEdit?: (role: Role) => boolean }) {
  const groups = useMemo(() => {
    const m = new Map<string, PermissionDef[]>();
    for (const p of permissions) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()];
  }, [permissions]);
  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="sticky top-0 z-10">
          <tr className="border-b border-slate-200 bg-slate-50">
            <th className="sticky left-0 bg-slate-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Permission</th>
            {roles.map((r) => (
              <th key={r.id} className="whitespace-nowrap px-3 py-3 text-center text-xs font-semibold text-slate-700">
                {r.name}
                {r.fullAccess && <span className="block text-[10px] font-normal text-violet-600">full access</span>}
                {r.isCustom && <span className="block text-[10px] font-normal text-slate-400">custom</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map(([group, perms]) => (
            <GroupRows key={group} group={group} perms={perms} roles={roles} onToggle={onToggle} canEdit={canEdit} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ group, perms, roles, onToggle, canEdit }: { group: string; perms: PermissionDef[]; roles: Role[]; onToggle?: (role: Role, key: string, on: boolean) => void; canEdit?: (role: Role) => boolean }) {
  return (
    <>
      <tr className="bg-slate-50/50"><td colSpan={roles.length + 1} className="sticky left-0 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{group}</td></tr>
      {perms.map((p) => (
        <tr key={p.key} className="border-b border-slate-100 hover:bg-slate-50/60">
          <td className="sticky left-0 bg-white px-4 py-2">
            <span className="block font-mono text-xs text-slate-800">{p.key}</span>
            <span className="text-xs text-slate-500">{p.description}</span>
          </td>
          {roles.map((r) => {
            const on = r.permissions.includes(p.key);
            const editable = !!onToggle && !!canEdit?.(r);
            return (
              <td key={r.id} className="px-3 py-2 text-center">
                {editable ? (
                  <input type="checkbox" checked={on} onChange={(e) => onToggle!(r, p.key, e.target.checked)} className="h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500/30" />
                ) : (
                  <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px]', on ? 'bg-emerald-100 text-emerald-700' : 'text-slate-300')}>{on ? '✓' : '–'}</span>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function RolesTab() {
  const { can } = usePermissions();
  const roles = useQuery({ queryKey: ['org-roles'], queryFn: organizationService.roles });
  const perms = useQuery({ queryKey: ['org-permissions'], queryFn: organizationService.permissions });
  const [create, setCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [del, setDel] = useState<Role | null>(null);
  const inv = [['org-roles']];
  const createRole = useApiMutation(() => organizationService.createRole({ name, description, permissions: picked }), { success: 'Role created', invalidate: inv, onSuccess: () => { setCreate(false); setName(''); setPicked([]); } });
  const toggle = useApiMutation(({ role, key, on }: { role: Role; key: string; on: boolean }) => organizationService.updateRole(role.id, { permissions: on ? [...role.permissions, key] : role.permissions.filter((k) => k !== key) }), { invalidate: inv, success: 'Permissions updated' });
  const remove = useApiMutation((id: string) => organizationService.deleteRole(id), { success: 'Role deleted', invalidate: inv, onSuccess: () => setDel(null) });
  if (roles.isLoading || perms.isLoading) return <PageLoader />;
  const custom = roles.data?.filter((r) => r.isCustom) ?? [];
  return (
    <div className="space-y-6">
      <Alert tone="info">Built-in roles (Owner, Manager, Staff) are managed by the platform. Create custom roles to fine-tune what teammates can do — permissions are enforced by the server on every request.</Alert>
      <Card padded={false}>
        <CardHeader title="Permission matrix" description="Tick boxes to change custom roles." action={can('roles.create') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreate(true)}>Custom role</Button>} />
        <PermissionMatrix roles={roles.data ?? []} permissions={perms.data ?? []} canEdit={(r) => r.editable && can('roles.update')} onToggle={(role, key, on) => toggle.mutate({ role, key, on })} />
      </Card>
      {custom.length > 0 && can('roles.delete') && (
        <Card padded={false}>
          <CardHeader title="Custom roles" />
          <ul className="divide-y divide-slate-100">
            {custom.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-5 py-3 text-sm">
                <span><span className="font-medium">{r.name}</span> <span className="text-slate-500">· {r.permissions.length} permissions · {r.assignedCount} member(s)</span></span>
                <Button size="xs" variant="ghost" className="text-red-600" onClick={() => setDel(r)}>Delete</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Modal open={create} onClose={() => setCreate(false)} title="Create custom role" size="lg" footer={<><Button variant="secondary" onClick={() => setCreate(false)}>Cancel</Button><Button disabled={name.trim().length < 2} loading={createRole.isPending} onClick={() => createRole.mutate(undefined)}>Create role</Button></>}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Role name" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing" /></Field>
            <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {perms.data?.map((p) => <Checkbox key={p.key} label={<span className="font-mono text-xs">{p.key}</span>} description={p.description} checked={picked.includes(p.key)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, p.key] : x.filter((k) => k !== p.key)))} />)}
          </div>
        </div>
      </Modal>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={`Delete role "${del?.name}"?`} description="Roles assigned to members can’t be deleted — reassign them first." confirmLabel="Delete" loading={remove.isPending} onConfirm={() => del && remove.mutate(del.id)} />
    </div>
  );
}

function OrgAuditTab() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['org-audit', page], queryFn: () => reportService.auditLogs({ page, limit: 20 }) });
  return (
    <Card padded={false}>
      <CardHeader title="Activity log" description="Sensitive actions in your organization. Records are immutable." />
      <DataTable
        rows={q.data?.data}
        loading={q.isLoading}
        error={q.error}
        columns={[
          { key: 'time', header: 'Time', cell: (a) => <span className="text-slate-500">{fmtDateTime(a.createdAt)}</span> },
          { key: 'action', header: 'Action', cell: (a) => <Badge color="violet">{a.action}</Badge> },
          { key: 'actor', header: 'Actor', cell: (a) => (a.actorType === 'USER' ? a.actor?.fullName ?? a.actorEmail : a.actorType === 'API_KEY' ? 'API key' : 'System') },
          { key: 'res', header: 'Resource', cell: (a) => <span className="text-slate-500">{titleCase(a.resource)}</span> },
          { key: 'ip', header: 'IP', cell: (a) => <span className="font-mono text-xs text-slate-500">{a.ipAddress ?? '—'}</span> },
        ]}
        empty={<EmptyState icon={<ScrollText />} title="No activity yet" />}
      />
      <Pagination pagination={q.data?.pagination} onPage={setPage} />
    </Card>
  );
}

export function OrganizationPage() {
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const tabs = [
    { value: 'profile' as const, label: 'Profile', show: true },
    { value: 'team' as const, label: 'Team', show: can('team.view') },
    { value: 'roles' as const, label: 'Roles & permissions', show: can('roles.view') },
    { value: 'audit' as const, label: 'Activity log', show: can('audit_logs.view') },
  ].filter((t) => t.show);
  type T = (typeof tabs)[number]['value'];
  const tab = (tabs.find((t) => t.value === params.get('tab'))?.value ?? 'profile') as T;
  return (
    <div className="space-y-6">
      <PageHeader title="Organization" description="Profile, team members, roles and activity." />
      <Tabs tabs={tabs} value={tab} onChange={(v) => setParams({ tab: v })} />
      {tab === 'profile' && <OrgProfileTab />}
      {tab === 'team' && <TeamTab />}
      {tab === 'roles' && <RolesTab />}
      {tab === 'audit' && <OrgAuditTab />}
    </div>
  );
}

// ── Notifications ───────────────────────────────────────────────────────

export function NotificationsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [unread, setUnread] = useState(false);
  const q = useQuery({ queryKey: ['notifications', 'page', page, unread], queryFn: () => notificationService.list({ page, limit: 20, unread }) });
  const readAll = useApiMutation(() => notificationService.markAllRead(), { success: 'All marked as read', invalidate: [['notifications']] });
  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" actions={<><Button variant="secondary" size="sm" onClick={() => { setUnread(!unread); setPage(1); }}>{unread ? 'Show all' : 'Unread only'}</Button><Button variant="secondary" size="sm" icon={<CheckCheck className="h-4 w-4" />} onClick={() => readAll.mutate(undefined)}>Mark all read</Button></>} />
      <Card padded={false}>
        {q.isLoading ? <PageLoader /> : q.error ? <ErrorState error={q.error} /> : !q.data?.data.length ? (
          <EmptyState icon={<Bell />} title="No notifications" description="Approvals, payments, low balance alerts and campaign results show up here." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {q.data.data.map((n) => (
              <li key={n.id}>
                <button
                  className={cn('flex w-full gap-4 px-5 py-4 text-left hover:bg-slate-50', !n.readAt && 'bg-brand-50/30')}
                  onClick={async () => {
                    if (!n.readAt) await notificationService.markRead(n.id);
                    void qc.invalidateQueries({ queryKey: ['notifications'] });
                    if (n.link) navigate(n.link);
                  }}
                >
                  <span className={cn('mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full', n.readAt ? 'bg-slate-100 text-slate-400' : 'bg-brand-100 text-brand-600')}><ShieldCheck className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2"><span className="font-medium text-slate-900">{n.title}</span><span className="shrink-0 text-xs text-slate-400">{fmtRelative(n.createdAt)}</span></span>
                    <span className="mt-0.5 block text-sm text-slate-600">{n.body}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}
