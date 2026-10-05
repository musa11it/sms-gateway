import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { BadgeCheck, Plus, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import type { SenderId } from '@/api/types';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, TableSkeleton } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Overlay';
import { PageHeader } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { useMe, usePermissions } from '@/hooks/useAuth';
import { senderService } from '@/services/senderService';
import { fmtDate } from '@/utils/format';
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
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 font-mono text-xs font-bold text-white">{s.name.slice(0, 3).toUpperCase()}</span>
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
      <ConfirmDialog open={!!withdraw} onClose={() => setWithdraw(null)} title={`Withdraw "${withdraw?.name}"?`} description="The request will be removed." confirmLabel="Withdraw" loading={del.isPending} onConfirm={() => withdraw && del.mutate(withdraw.id)} />
    </div>
  );
}
