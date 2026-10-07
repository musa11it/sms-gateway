import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { BadgeCheck, Bell, PieChart, Plus, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import type { AllocationOverview, SenderAllocation, SenderId } from '@/api/types';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, TableSkeleton } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Overlay';
import { PageHeader, ProgressBar } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { useMe, usePermissions } from '@/hooks/useAuth';
import { senderService } from '@/services/senderService';
import { fmtDate, fmtNumber } from '@/utils/format';
import { handleFormError } from '@/utils/forms';

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(3, 'At least 3 characters')
    .max(11, 'At most 11 characters')
    .regex(/^[A-Za-z0-9 .\-&]+$/, 'Letters, digits, spaces, . - & only')
    .regex(/[A-Za-z]/, 'Must contain a letter'),
  purpose: z.string().trim().min(10, 'Describe the purpose (at least 10 characters)'),
  useCase: z.string().optional(),
  sampleMessage: z.string().max(640).optional(),
});
type V = z.infer<typeof schema>;

function SenderForm({ open, onClose, editing }: { open: boolean; onClose: () => void; editing?: SenderId | null }) {
  const form = useForm<V>({
    resolver: zodResolver(schema),
    values: editing
      ? { name: editing.name, purpose: editing.purpose, useCase: editing.useCase ?? '', sampleMessage: editing.sampleMessage ?? '' }
      : { name: '', purpose: '', useCase: 'Transactional', sampleMessage: '' },
  });
  const save = useApiMutation((v: V) => (editing ? senderService.update(editing.id, v) : senderService.request(v)), {
    success: editing ? 'Sender ID updated' : 'Sender ID submitted for review',
    invalidate: [['senders']],
    silentError: true,
    onSuccess: () => {
      form.reset();
      onClose();
    },
  });
  const e = form.formState.errors;
  const name = form.watch('name') ?? '';
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${editing.name}` : 'Request a sender ID'}
      description="The name recipients see as the sender. Our team reviews every request."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} onClick={form.handleSubmit((v) => save.mutate(v, { onError: (err) => handleFormError(err, form.setError) }))}>
            {editing ? 'Save changes' : 'Submit request'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Sender name" required error={e.name?.message} hint={`${name.length}/11 characters. Usually your brand, e.g. "ACMESHOP".`}>
          <Input {...form.register('name')} maxLength={11} className="font-mono uppercase tracking-wide" invalid={!!e.name} />
        </Field>
        <Field label="Use case">
          <Select {...form.register('useCase')}>
            <option>Transactional</option>
            <option>Marketing / promotional</option>
            <option>One-time passwords</option>
            <option>Alerts & notifications</option>
          </Select>
        </Field>
        <Field label="Purpose" required error={e.purpose?.message} hint="Who receives these messages and why?">
          <Textarea rows={3} {...form.register('purpose')} invalid={!!e.purpose} />
        </Field>
        <Field label="Sample message" hint="Helps reviewers approve faster.">
          <Textarea rows={2} {...form.register('sampleMessage')} />
        </Field>
      </div>
    </Modal>
  );
}

export function SendersPage() {
  const { can } = usePermissions();
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['senders'], queryFn: senderService.list });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SenderId | null>(null);
  const [withdraw, setWithdraw] = useState<SenderId | null>(null);
  const resubmit = useApiMutation((id: string) => senderService.resubmit(id), { success: 'Resubmitted for review', invalidate: [['senders']] });
  const del = useApiMutation((id: string) => senderService.withdraw(id), { success: 'Request withdrawn', invalidate: [['senders']], onSuccess: () => setWithdraw(null) });
  const canRequest = can('senders.request') && me?.organization?.status === 'ACTIVE';
  const allocations = useQuery({ queryKey: ['senders', 'allocations'], queryFn: senderService.allocations });
  const [allocating, setAllocating] = useState<SenderId | null>(null);
  const allocationOf = (id: string) => allocations.data?.allocations.find((a) => a.senderId === id);
  const hasApproved = !!q.data?.some((s) => s.status === 'APPROVED');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sender IDs"
        description="Only approved sender IDs can be used to send SMS."
        actions={canRequest && <Button icon={<Plus className="h-4 w-4" />} onClick={() => { setEditing(null); setOpen(true); }}>Request sender ID</Button>}
      />
      <Alert tone="info" title="How approval works">
        Submit your brand name and how you’ll use it. Our team checks it against your verified business and approves, rejects or asks for more information. You’ll get a notification either way.
      </Alert>
      {hasApproved && allocations.data && (
        <Card className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div><p className="text-xs font-medium text-slate-500">Wallet balance</p><p className="text-xl font-semibold tabular-nums text-slate-900">{fmtNumber(allocations.data.balance)}</p></div>
          <div><p className="text-xs font-medium text-slate-500">Allocated to sender IDs</p><p className="text-xl font-semibold tabular-nums text-slate-900">{fmtNumber(allocations.data.reserved)}</p></div>
          <div><p className="text-xs font-medium text-slate-500">Unallocated</p><p className="text-xl font-semibold tabular-nums text-slate-900">{fmtNumber(allocations.data.unallocated)}</p></div>
          <p className="min-w-[16rem] flex-1 text-xs text-slate-500">Allocations reserve part of your wallet for a sender ID — they never add credits. Sender IDs without an allocation share the unallocated credits.</p>
        </Card>
      )}
      {q.isLoading ? (
        <Card padded={false}><TableSkeleton rows={3} /></Card>
      ) : q.error ? (
        <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>
      ) : !q.data?.length ? (
        <Card>
          <EmptyState icon={<ShieldCheck />} title="No sender IDs yet" description="Request your first sender ID — it’s the name your customers see on every message." action={canRequest && <Button onClick={() => setOpen(true)} icon={<Plus className="h-4 w-4" />}>Request sender ID</Button>} />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data.map((s) => (
            <Card key={s.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 font-mono text-xs font-bold text-white">{s.name.slice(0, 3).toUpperCase()}</span>
                  <div>
                    <p className="flex items-center gap-1.5 font-mono text-[15px] font-semibold text-slate-900">
                      {s.name} {s.status === 'APPROVED' && <BadgeCheck className="h-4 w-4 text-emerald-500" />}
                    </p>
                    <p className="text-xs text-slate-500">{s.useCase ?? 'Sender ID'} · requested {fmtDate(s.createdAt)}</p>
                  </div>
                </div>
                <StatusBadge status={s.status} />
              </div>
              <p className="mt-4 line-clamp-3 flex-1 text-sm text-slate-600">{s.purpose}</p>
              {s.reviewNote && ['REJECTED', 'NEEDS_INFORMATION', 'SUSPENDED'].includes(s.status) && (
                <Alert tone={s.status === 'NEEDS_INFORMATION' ? 'warning' : 'danger'} className="mt-4">
                  <strong>Reviewer note:</strong> {s.reviewNote}
                </Alert>
              )}
              {s.status === 'APPROVED' && allocations.data && (
                <AllocationBlock allocation={allocationOf(s.id)} canManage={can('senders.allocate')} onManage={() => setAllocating(s)} />
              )}
              {can('senders.request') && ['PENDING', 'NEEDS_INFORMATION', 'REJECTED'].includes(s.status) && (
                <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                  <Button size="xs" variant="secondary" onClick={() => { setEditing(s); setOpen(true); }}>Edit</Button>
                  {['NEEDS_INFORMATION', 'REJECTED'].includes(s.status) && (
                    <Button size="xs" icon={<RotateCcw className="h-3 w-3" />} loading={resubmit.isPending} onClick={() => resubmit.mutate(s.id)}>Resubmit</Button>
                  )}
                  <Button size="xs" variant="ghost" className="text-red-600" icon={<Trash2 className="h-3 w-3" />} onClick={() => setWithdraw(s)}>Withdraw</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      <SenderForm open={open} onClose={() => setOpen(false)} editing={editing} />
      <AllocationModal sender={allocating} allocation={allocating ? allocationOf(allocating.id) : undefined} overview={allocations.data} onClose={() => setAllocating(null)} />
      <ConfirmDialog open={!!withdraw} onClose={() => setWithdraw(null)} title={`Withdraw "${withdraw?.name}"?`} description="The request will be removed." confirmLabel="Withdraw" loading={del.isPending} onConfirm={() => withdraw && del.mutate(withdraw.id)} />
    </div>
  );
}

// ── Credit allocations ──────────────────────────────────────────────────

const PRESET_THRESHOLDS = [50, 25, 10];

function allocationTone(a: SenderAllocation): 'brand' | 'amber' | 'red' {
  const remainingPct = a.allocated ? (a.remaining / a.allocated) * 100 : 0;
  if (remainingPct <= Math.min(...a.alertThresholds, 100)) return 'red';
  if (remainingPct <= Math.max(...a.alertThresholds, 0)) return 'amber';
  return 'brand';
}

function AllocationBlock({ allocation, canManage, onManage }: { allocation?: SenderAllocation; canManage: boolean; onManage: () => void }) {
  if (!allocation?.isActive) {
    return (
      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5 ring-1 ring-inset ring-slate-100">
        <p className="text-xs text-slate-500">Uses your shared wallet credits.</p>
        {canManage && <Button size="xs" variant="secondary" icon={<PieChart className="h-3 w-3" />} onClick={onManage}>Allocate credits</Button>}
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
      <dl className="grid grid-cols-3 gap-2 text-center">
        <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Allocated</dt><dd className="font-semibold tabular-nums text-slate-900">{fmtNumber(allocation.allocated)}</dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Used</dt><dd className="font-semibold tabular-nums text-slate-900">{fmtNumber(allocation.used)}</dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Remaining</dt><dd className="font-semibold tabular-nums text-slate-900">{fmtNumber(allocation.remaining)}</dd></div>
      </dl>
      <div className="mt-3 flex items-center gap-2" aria-label={`${allocation.usagePercent}% used`}>
        <ProgressBar value={allocation.usagePercent} tone={allocationTone(allocation)} className="flex-1" />
        <span className="w-12 text-right text-xs font-medium tabular-nums text-slate-600">{allocation.usagePercent}%</span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-xs text-slate-500"><Bell className="h-3 w-3" /> Alerts at {allocation.alertThresholds.map((t) => `${t}%`).join(', ')} remaining</p>
        {canManage && <Button size="xs" variant="secondary" onClick={onManage}>Manage</Button>}
      </div>
    </div>
  );
}

function AllocationModal({ sender, allocation, overview, onClose }: { sender: SenderId | null; allocation?: SenderAllocation; overview?: AllocationOverview; onClose: () => void }) {
  const [form, setForm] = useState<{ allocated: string; thresholds: number[]; custom: string }>({ allocated: '', thresholds: PRESET_THRESHOLDS, custom: '' });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  if (sender && loadedFor !== sender.id) {
    setLoadedFor(sender.id);
    const active = allocation?.isActive ? allocation : undefined;
    const custom = active?.alertThresholds.find((t) => !PRESET_THRESHOLDS.includes(t));
    setForm({ allocated: active ? String(active.allocated) : '', thresholds: active ? active.alertThresholds.filter((t) => PRESET_THRESHOLDS.includes(t)) : PRESET_THRESHOLDS, custom: custom ? String(custom) : '' });
  }
  const close = () => { setLoadedFor(null); setConfirmRemove(false); onClose(); };
  const used = allocation?.isActive ? allocation.used : (allocation?.used ?? 0);
  const currentRemaining = allocation?.isActive ? allocation.remaining : 0;
  const max = overview ? used + overview.unallocated + currentRemaining : undefined;
  const amount = Number(form.allocated);
  const customValue = form.custom.trim() ? Number(form.custom) : null;
  const customValid = customValue === null || (Number.isInteger(customValue) && customValue >= 1 && customValue <= 99);
  const thresholds = [...new Set([...form.thresholds, ...(customValue && customValid ? [customValue] : [])])].sort((a, b) => b - a);
  const amountError = !form.allocated ? undefined : !Number.isInteger(amount) || amount < 1 ? 'Enter a whole number of credits' : amount < used ? `At least ${fmtNumber(used)} (already used)` : max !== undefined && amount > max ? `At most ${fmtNumber(max)} with your current balance` : undefined;
  const save = useApiMutation(() => senderService.setAllocation(sender!.id, { allocated: amount, alertThresholds: thresholds }), { success: 'Allocation saved', invalidate: [['senders'], ['senders', 'allocations']], onSuccess: close });
  const remove = useApiMutation(() => senderService.removeAllocation(sender!.id), { success: 'Allocation removed', invalidate: [['senders'], ['senders', 'allocations']], onSuccess: close });
  const toggle = (t: number) => setForm((f) => ({ ...f, thresholds: f.thresholds.includes(t) ? f.thresholds.filter((x) => x !== t) : [...f.thresholds, t] }));

  return (
    <>
      <Modal
        open={!!sender && !confirmRemove}
        onClose={close}
        title={`Allocate credits · ${sender?.name ?? ''}`}
        footer={
          <>
            {allocation?.isActive && <Button variant="ghost" className="mr-auto text-red-600" onClick={() => setConfirmRemove(true)}>Remove allocation</Button>}
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button disabled={!form.allocated || !!amountError || !customValid || thresholds.length === 0} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save allocation</Button>
          </>
        }
      >
        <div className="space-y-5">
          <p className="text-sm text-slate-600">
            Reserve part of your wallet for this sender ID. Allocations never add credits: messages from <span className="font-mono font-medium">{sender?.name}</span> use its allocation, and other sender IDs can only use the credits that are not allocated.
          </p>
          {overview && (
            <dl className="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 text-center ring-1 ring-inset ring-slate-100">
              <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Wallet</dt><dd className="font-semibold tabular-nums">{fmtNumber(overview.balance)}</dd></div>
              <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Already used</dt><dd className="font-semibold tabular-nums">{fmtNumber(used)}</dd></div>
              <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Max allocation</dt><dd className="font-semibold tabular-nums">{max !== undefined ? fmtNumber(max) : '—'}</dd></div>
            </dl>
          )}
          <Field label="Allocated credits" required error={amountError} hint="Total credits for this sender ID, including those already used.">
            <Input type="number" min={Math.max(1, used)} max={max} value={form.allocated} onChange={(e) => setForm((f) => ({ ...f, allocated: e.target.value }))} className="max-w-xs tabular-nums" invalid={!!amountError} />
          </Field>
          <fieldset>
            <legend className="label">Low-balance reminders</legend>
            <p className="mb-2 text-xs text-slate-500">You’ll get one notification when the remaining allocation falls to each level.</p>
            <div className="flex flex-wrap items-center gap-4">
              {PRESET_THRESHOLDS.map((t) => (
                <Checkbox key={t} label={`${t}% left`} checked={form.thresholds.includes(t)} onChange={() => toggle(t)} />
              ))}
              <Field error={customValid ? undefined : '1–99'}>
                <Input type="number" min={1} max={99} placeholder="Custom %" value={form.custom} onChange={(e) => setForm((f) => ({ ...f, custom: e.target.value }))} className="w-28" invalid={!customValid} aria-label="Custom reminder threshold in percent" />
              </Field>
            </div>
          </fieldset>
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove the allocation for ${sender?.name}?`}
        description={`The ${fmtNumber(currentRemaining)} remaining allocated credits go back to your shared wallet balance. Usage history is kept.`}
        confirmLabel="Remove allocation"
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
    </>
  );
}
