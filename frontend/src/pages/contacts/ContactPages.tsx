import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { Download, FileSpreadsheet, FolderPlus, MoreHorizontal, Pencil, Plus, Trash2, Upload, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import type { Contact, ContactGroup } from '@/api/types';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button, IconButton, LinkButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, TableSkeleton } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Overlay';
import { DataTable, Pagination } from '@/components/ui/Table';
import { Dropdown, MenuItem, PageHeader } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { contactService, type ImportAnalysis } from '@/services/contactService';
import { cn, fmtNumber, fmtRelative } from '@/utils/format';
import { handleFormError } from '@/utils/forms';

const contactSchema = z.object({
  name: z.string().trim().max(120).optional(),
  phone: z.string().trim().min(6, 'Enter a phone number'),
  email: z.string().trim().email('Invalid email').optional().or(z.literal('')),
  tags: z.string().optional(),
  status: z.enum(['ACTIVE', 'UNSUBSCRIBED', 'BLOCKED']),
});
type ContactForm = z.infer<typeof contactSchema>;

function ContactModal({ open, onClose, contact, groups }: { open: boolean; onClose: () => void; contact: Contact | null; groups: ContactGroup[] }) {
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const form = useForm<ContactForm>({
    resolver: zodResolver(contactSchema),
    values: contact
      ? { name: contact.name ?? '', phone: contact.phone, email: contact.email ?? '', tags: contact.tags.join(', '), status: contact.status }
      : { name: '', phone: '', email: '', tags: '', status: 'ACTIVE' },
  });
  const [lastId, setLastId] = useState<string | null | undefined>(undefined);
  if (open && lastId !== (contact?.id ?? null)) {
    setLastId(contact?.id ?? null);
    setGroupIds(contact?.groups.map((g) => g.id) ?? []);
  }
  const save = useApiMutation(
    (v: ContactForm) => {
      const body = { name: v.name || null, phone: v.phone, email: v.email || null, status: v.status, tags: (v.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean), groupIds };
      return contact ? contactService.update(contact.id, body) : contactService.create(body);
    },
    { success: contact ? 'Contact updated' : 'Contact added', invalidate: [['contacts'], ['contact-groups']], silentError: true, onSuccess: () => { onClose(); setLastId(undefined); } },
  );
  const e = form.formState.errors;
  return (
    <Modal
      open={open}
      onClose={() => { onClose(); setLastId(undefined); }}
      title={contact ? 'Edit contact' : 'Add contact'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} onClick={form.handleSubmit((v) => save.mutate(v, { onError: (err) => handleFormError(err, form.setError) }))}>Save</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={e.name?.message}><Input {...form.register('name')} /></Field>
        <Field label="Phone" required error={e.phone?.message} hint="E.g. +250788123456 or 0788123456"><Input {...form.register('phone')} invalid={!!e.phone} className="font-mono" /></Field>
        <Field label="Email" error={e.email?.message}><Input {...form.register('email')} /></Field>
        <Field label="Status">
          <Select {...form.register('status')}>
            <option value="ACTIVE">Active</option>
            <option value="UNSUBSCRIBED">Unsubscribed (opted out)</option>
            <option value="BLOCKED">Blocked</option>
          </Select>
        </Field>
        <Field label="Tags" hint="Comma separated" className="sm:col-span-2"><Input {...form.register('tags')} placeholder="vip, kigali" /></Field>
        {groups.length > 0 && (
          <div className="sm:col-span-2">
            <p className="label">Groups</p>
            <div className="flex flex-wrap gap-2">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGroupIds((ids) => (ids.includes(g.id) ? ids.filter((i) => i !== g.id) : [...ids, g.id]))}
                  className={cn('rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition', groupIds.includes(g.id) ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50')}
                >
                  {g.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function ContactsPage() {
  const { can } = usePermissions();
  const [searchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState(searchParams.get('group') ?? '');
  const [status, setStatus] = useState('');
  const debounced = useDebounce(search);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{ open: boolean; contact: Contact | null }>({ open: false, contact: null });
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [addToGroup, setAddToGroup] = useState(false);
  const [targetGroup, setTargetGroup] = useState('');
  const params = { search: debounced || undefined, groupId: groupId || undefined, status: status || undefined };
  const q = useQuery({ queryKey: ['contacts', { page, ...params }], queryFn: () => contactService.list({ page, limit: 20, ...params }), placeholderData: (p) => p });
  const groups = useQuery({ queryKey: ['contact-groups'], queryFn: contactService.groups });
  const del = useApiMutation((ids: string[]) => (ids.length === 1 ? contactService.remove(ids[0]).then(() => ({ deleted: 1 })) : contactService.bulkDelete(ids)), {
    success: (d) => `${d.deleted} contact(s) deleted`,
    invalidate: [['contacts'], ['contact-groups']],
    onSuccess: () => { setConfirmDelete(null); setSelected(new Set()); },
  });
  const addGroup = useApiMutation(() => contactService.addToGroup(targetGroup, [...selected]), {
    success: (d) => `${d.added} contact(s) added to group`,
    invalidate: [['contacts'], ['contact-groups']],
    onSuccess: () => { setAddToGroup(false); setSelected(new Set()); },
  });
  const rows = q.data?.data ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contacts"
        description="Your audience. Unsubscribed and blocked contacts are never messaged."
        actions={
          <>
            {can('contacts.view') && <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => contactService.exportCsv(params).catch((e) => toast.error(errorMessage(e)))}>Export</Button>}
            {can('contacts.import') && <LinkButton to="/app/contacts/import" variant="secondary" icon={<Upload className="h-4 w-4" />}>Import CSV</LinkButton>}
            {can('contacts.create') && <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setModal({ open: true, contact: null })}>Add contact</Button>}
          </>
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <Input placeholder="Search name, phone or email…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="max-w-xs" />
          <Select value={groupId} onChange={(e) => { setGroupId(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All groups</option>
            {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="UNSUBSCRIBED">Unsubscribed</option>
            <option value="BLOCKED">Blocked</option>
          </Select>
          {selected.size > 0 && (
            <div className="ml-auto flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm">
              <span className="font-medium text-brand-800">{selected.size} selected</span>
              {can('contacts.update') && <Button size="xs" variant="secondary" icon={<FolderPlus className="h-3 w-3" />} onClick={() => setAddToGroup(true)}>Add to group</Button>}
              {can('contacts.delete') && <Button size="xs" variant="danger" icon={<Trash2 className="h-3 w-3" />} onClick={() => setConfirmDelete([...selected])}>Delete</Button>}
            </div>
          )}
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          columns={[
            {
              key: 'sel',
              header: <Checkbox checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all" />,
              cell: (c) => <Checkbox checked={selected.has(c.id)} onChange={() => setSelected((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} aria-label="Select" />,
              className: 'w-10',
            },
            { key: 'name', header: 'Name', cell: (c) => <span className="font-medium text-slate-900">{c.name || <span className="text-slate-400">—</span>}</span> },
            { key: 'phone', header: 'Phone', cell: (c) => <span className="font-mono text-[13px]">{c.phone}</span> },
            { key: 'groups', header: 'Groups', cell: (c) => <span className="flex flex-wrap gap-1">{c.groups.map((g) => <Badge key={g.id} color="violet">{g.name}</Badge>)}</span> },
            { key: 'tags', header: 'Tags', cell: (c) => <span className="text-xs text-slate-500">{c.tags.join(', ')}</span> },
            { key: 'status', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
            { key: 'added', header: 'Added', cell: (c) => <span className="text-slate-500">{fmtRelative(c.createdAt)}</span> },
            {
              key: 'act',
              header: '',
              className: 'text-right',
              cell: (c) =>
                (can('contacts.update') || can('contacts.delete')) && (
                  <Dropdown trigger={<IconButton label="Actions"><MoreHorizontal className="h-4 w-4" /></IconButton>}>
                    {(close) => (
                      <>
                        {can('contacts.update') && <MenuItem icon={<Pencil />} onClick={() => { close(); setModal({ open: true, contact: c }); }}>Edit</MenuItem>}
                        {can('contacts.delete') && <MenuItem icon={<Trash2 />} danger onClick={() => { close(); setConfirmDelete([c.id]); }}>Delete</MenuItem>}
                      </>
                    )}
                  </Dropdown>
                ),
            },
          ]}
          empty={
            <EmptyState
              icon={<Users />}
              title={debounced || groupId || status ? 'No contacts match your filters' : 'No contacts yet'}
              description="Add contacts one by one or import a CSV with name and phone columns."
              action={can('contacts.create') && !debounced && <><Button onClick={() => setModal({ open: true, contact: null })}>Add contact</Button><LinkButton to="/app/contacts/import" variant="secondary">Import CSV</LinkButton></>}
            />
          }
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
      <ContactModal open={modal.open} contact={modal.contact} groups={groups.data ?? []} onClose={() => setModal({ open: false, contact: null })} />
      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title={`Delete ${confirmDelete?.length ?? 0} contact(s)?`} description="They will be removed from all groups. Message history is kept." confirmLabel="Delete" loading={del.isPending} onConfirm={() => confirmDelete && del.mutate(confirmDelete)} />
      <Modal open={addToGroup} onClose={() => setAddToGroup(false)} title="Add to group" size="sm" footer={<><Button variant="secondary" onClick={() => setAddToGroup(false)}>Cancel</Button><Button disabled={!targetGroup} loading={addGroup.isPending} onClick={() => addGroup.mutate(undefined)}>Add</Button></>}>
        <Field label="Group">
          <Select value={targetGroup} onChange={(e) => setTargetGroup(e.target.value)}>
            <option value="">Select a group…</option>
            {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </Field>
      </Modal>
    </div>
  );
}

const COLORS = ['#4f46e5', '#7c3aed', '#059669', '#d97706', '#dc2626', '#0891b2', '#475569'];

export function GroupsPage() {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['contact-groups'], queryFn: contactService.groups });
  const [edit, setEdit] = useState<{ open: boolean; group: ContactGroup | null }>({ open: false, group: null });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [del, setDel] = useState<ContactGroup | null>(null);
  const openEdit = (g: ContactGroup | null) => {
    setName(g?.name ?? '');
    setDescription(g?.description ?? '');
    setColor(g?.color ?? COLORS[0]);
    setEdit({ open: true, group: g });
  };
  const save = useApiMutation(() => (edit.group ? contactService.updateGroup(edit.group.id, { name, description, color }) : contactService.createGroup({ name, description, color })), {
    success: edit.group ? 'Group updated' : 'Group created',
    invalidate: [['contact-groups']],
    onSuccess: () => setEdit({ open: false, group: null }),
  });
  const remove = useApiMutation((id: string) => contactService.deleteGroup(id), { success: 'Group deleted', invalidate: [['contact-groups'], ['contacts']], onSuccess: () => setDel(null) });

  return (
    <div className="space-y-6">
      <PageHeader title="Groups" description="Segment contacts to target campaigns — e.g. Customers, Students, VIP." breadcrumbs={[{ label: 'Contacts', to: '/app/contacts' }, { label: 'Groups' }]} actions={can('contacts.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => openEdit(null)}>New group</Button>} />
      {q.isLoading ? (
        <Card padded={false}><TableSkeleton rows={3} /></Card>
      ) : q.error ? (
        <Card><ErrorState error={q.error} /></Card>
      ) : !q.data?.length ? (
        <Card><EmptyState icon={<Users />} title="No groups yet" description="Create groups such as Customers, Employees or Subscribers." action={can('contacts.create') && <Button onClick={() => openEdit(null)}>Create group</Button>} /></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {q.data.map((g) => (
            <Card key={g.id} className="group relative">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ background: g.color ?? '#475569' }}><Users className="h-5 w-5" /></span>
                  <div>
                    <p className="font-semibold text-slate-900">{g.name}</p>
                    <p className="text-sm text-slate-500">{fmtNumber(g.contactCount)} contacts</p>
                  </div>
                </div>
                {(can('contacts.update') || can('contacts.delete')) && (
                  <Dropdown trigger={<IconButton label="Actions"><MoreHorizontal className="h-4 w-4" /></IconButton>}>
                    {(close) => (
                      <>
                        {can('contacts.update') && <MenuItem icon={<Pencil />} onClick={() => { close(); openEdit(g); }}>Edit</MenuItem>}
                        {can('contacts.delete') && <MenuItem icon={<Trash2 />} danger onClick={() => { close(); setDel(g); }}>Delete</MenuItem>}
                      </>
                    )}
                  </Dropdown>
                )}
              </div>
              {g.description && <p className="mt-3 text-sm text-slate-600">{g.description}</p>}
              <button onClick={() => navigate(`/app/contacts?group=${g.id}`)} className="mt-4 text-sm font-medium text-brand-600 hover:underline">
                View contacts →
              </button>
            </Card>
          ))}
        </div>
      )}
      <Modal open={edit.open} onClose={() => setEdit({ open: false, group: null })} title={edit.group ? 'Edit group' : 'New group'} size="sm" footer={<><Button variant="secondary" onClick={() => setEdit({ open: false, group: null })}>Cancel</Button><Button disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></>}>
        <div className="space-y-4">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="VIP customers" /></Field>
          <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <div>
            <p className="label">Color</p>
            <div className="flex gap-2">{COLORS.map((c) => <button key={c} type="button" onClick={() => setColor(c)} className={cn('h-7 w-7 rounded-full ring-2 ring-offset-2 transition', color === c ? 'ring-slate-900' : 'ring-transparent')} style={{ background: c }} aria-label={c} />)}</div>
          </div>
        </div>
      </Modal>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={`Delete "${del?.name}"?`} description="Contacts in the group are kept. Groups used by campaigns can’t be deleted." confirmLabel="Delete group" loading={remove.isPending} onConfirm={() => del && remove.mutate(del.id)} />
    </div>
  );
}

const ROW_STATUS: Record<string, { label: string; color: 'green' | 'red' | 'amber' | 'gray' | 'blue' }> = {
  valid: { label: 'Valid', color: 'green' },
  invalid: { label: 'Invalid', color: 'red' },
  duplicate: { label: 'Duplicate', color: 'amber' },
  missing: { label: 'Missing phone', color: 'red' },
  existing: { label: 'Already exists', color: 'blue' },
};

export function ImportContactsPage() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [groupId, setGroupId] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const groups = useQuery({ queryKey: ['contact-groups'], queryFn: contactService.groups });

  const pick = async (f: File) => {
    setFile(f);
    setAnalysis(null);
    setBusy(true);
    try {
      setAnalysis(await contactService.previewImport(f));
    } catch (e) {
      toast.error(errorMessage(e));
      setFile(null);
    } finally {
      setBusy(false);
    }
  };
  const commit = useApiMutation(() => contactService.commitImport(file!, { groupId: groupId || undefined, updateExisting }), {
    success: (r) => r.message,
    invalidate: [['contacts'], ['contact-groups']],
    onSuccess: () => navigate('/app/contacts'),
  });
  const rows = analysis?.rows.filter((r) => filter === 'all' || r.status === filter) ?? [];
  const importable = (analysis?.summary.valid ?? 0) + (updateExisting ? analysis?.summary.existing ?? 0 : 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Import contacts" description="Upload a CSV. We validate every row before anything is saved." breadcrumbs={[{ label: 'Contacts', to: '/app/contacts' }, { label: 'Import' }]} />
      {!analysis ? (
        <Card className="p-0">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void pick(f); }}
            className="m-6 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/50 px-6 py-16 text-center transition hover:border-brand-400 hover:bg-brand-50/30"
          >
            <FileSpreadsheet className="h-12 w-12 text-brand-500" />
            <p className="mt-4 text-base font-semibold text-slate-900">Drop your CSV here</p>
            <p className="mt-1 text-sm text-slate-500">or choose a file (max 5 MB, 20,000 rows)</p>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }} />
            <Button className="mt-5" loading={busy} onClick={() => fileRef.current?.click()} icon={<Upload className="h-4 w-4" />}>Choose CSV</Button>
          </div>
          <div className="border-t border-slate-100 px-6 py-5">
            <p className="text-sm font-medium text-slate-800">Expected format</p>
            <pre className="mt-2 rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">{'name,phone,email,tags\nJohn,+250788123456,john@example.com,vip;kigali\nAlice,0782123456,,'}</pre>
            <p className="mt-2 text-xs text-slate-500">Only <code>phone</code> is required. Local numbers are converted to international format.</p>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ['all', 'Total rows', analysis.summary.total, 'text-slate-900'],
              ['valid', 'Valid', analysis.summary.valid, 'text-emerald-600'],
              ['existing', 'Already exist', analysis.summary.existing, 'text-brand-600'],
              ['duplicate', 'Duplicates', analysis.summary.duplicate, 'text-amber-600'],
              ['invalid', 'Invalid', analysis.summary.invalid, 'text-red-600'],
              ['missing', 'Missing phone', analysis.summary.missing, 'text-red-600'],
            ].map(([k, l, v, c]) => (
              <button key={k as string} onClick={() => setFilter(k as string)} className={cn('card p-4 text-left transition', filter === k && 'ring-2 ring-brand-500')}>
                <p className="text-xs font-medium text-slate-500">{l}</p>
                <p className={cn('mt-1 text-2xl font-semibold tabular-nums', c as string)}>{fmtNumber(v as number)}</p>
              </button>
            ))}
          </div>
          {analysis.summary.invalid + analysis.summary.missing > 0 && <Alert tone="warning">Invalid rows and rows without a phone number will be skipped — they are never silently imported.</Alert>}
          <Card padded={false}>
            <CardHeader title={`Preview · ${file?.name}`} description="Showing up to 200 rows" action={<Button variant="ghost" size="sm" onClick={() => { setAnalysis(null); setFile(null); }}>Choose another file</Button>} />
            <DataTable
              rows={rows.slice(0, 200).map((r) => ({ ...r, id: String(r.line) }))}
              columns={[
                { key: 'line', header: 'Line', cell: (r) => <span className="text-slate-400">{r.line}</span> },
                { key: 'name', header: 'Name', cell: (r) => r.name ?? '—' },
                { key: 'phone', header: 'Phone', cell: (r) => <span className="font-mono text-[13px]">{r.phone ?? r.rawPhone ?? '—'}</span> },
                { key: 'email', header: 'Email', cell: (r) => r.email ?? '—' },
                { key: 'status', header: 'Result', cell: (r) => <Badge color={ROW_STATUS[r.status].color}>{ROW_STATUS[r.status].label}</Badge> },
                { key: 'reason', header: '', cell: (r) => <span className="text-xs text-slate-500">{r.reason}</span> },
              ]}
              empty={<EmptyState title="No rows in this category" className="py-8" />}
            />
          </Card>
          <Card className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-wrap items-end gap-4">
              <Field label="Add imported contacts to group">
                <Select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="w-56">
                  <option value="">No group</option>
                  {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </Select>
              </Field>
              <Checkbox label="Update existing contacts" description="Overwrite name/email/tags for numbers you already have" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} />
            </div>
            <div className="flex gap-2">
              <Button disabled={importable === 0} loading={commit.isPending} onClick={() => commit.mutate(undefined)}>Import {fmtNumber(importable)} contact(s)</Button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
