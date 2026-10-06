import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, Pencil, Play, ShieldCheck, Trash2, UserMinus, UserX, X } from 'lucide-react';
import type { SenderId } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Overlay';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { adminService } from '@/services/adminService';

/**
 * Operations platform staff perform on an organization's behalf. Each one asks for a reason, which is
 * recorded (with who did it, and before/after values where something changes) in the organization's audit log.
 */
const MIN_REASON = 5;

export function ReasonDialog({ open, title, description, confirmLabel, tone = 'primary', loading, onClose, onConfirm }: { open: boolean; title: string; description?: string; confirmLabel: string; tone?: 'primary' | 'danger'; loading?: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={loading} disabled={reason.trim().length < MIN_REASON} onClick={() => onConfirm(reason.trim())}>{confirmLabel}</Button>
        </>
      }
    >
      <Field label="Reason" required hint="Recorded in the organization’s audit log under your name.">
        <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you doing this on the organization’s behalf?" />
      </Field>
    </Modal>
  );
}

/** Create a sender ID for the organization, optionally approving it straight away. */
export function AddSenderModal({ organizationId, open, onClose }: { organizationId: string; open: boolean; onClose: () => void }) {
  const { canAdmin } = usePermissions();
  const BLANK = { name: '', purpose: '', sampleMessage: '', approveNow: false, reason: '' };
  const [f, setF] = useState(BLANK);
  useEffect(() => {
    if (open) setF(BLANK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const create = useApiMutation(() => adminService.createOrgSender(organizationId, { name: f.name.trim(), purpose: f.purpose.trim(), sampleMessage: f.sampleMessage.trim() || undefined, approveNow: f.approveNow, reason: f.reason.trim() }), {
    success: (s) => (s.status === 'APPROVED' ? 'Sender ID created and approved' : 'Sender ID created and sent for review'),
    invalidate: [['admin', 'org', organizationId], ['admin', 'senders']],
    onSuccess: onClose,
  });
  const valid = f.name.trim().length >= 3 && f.purpose.trim().length >= 3 && f.reason.trim().length >= MIN_REASON;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add sender ID"
      description="Create a sender ID for this organization."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={create.isPending} disabled={!valid} onClick={() => create.mutate(undefined)}>{f.approveNow ? 'Create & approve' : 'Create'}</Button></>}
    >
      <div className="space-y-4">
        <Field label="Sender name" required hint="3–11 characters: letters, digits, space, . - &"><Input value={f.name} maxLength={11} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Purpose" required><Input value={f.purpose} maxLength={500} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
        <Field label="Sample message"><Input value={f.sampleMessage} maxLength={500} onChange={(e) => setF({ ...f, sampleMessage: e.target.value })} /></Field>
        <div className="flex items-start gap-3">
          <Switch checked={f.approveNow} disabled={!canAdmin('senders.approve')} onChange={(v) => setF({ ...f, approveNow: v })} label="Approve immediately" />
          <div className="text-sm"><p className="font-medium text-slate-900">Approve immediately</p><p className="text-slate-500">{canAdmin('senders.approve') ? 'The organization can use it right away.' : 'Needs the senders.approve permission.'}</p></div>
        </div>
        <Field label="Reason" required hint="Recorded in the organization’s audit log under your name."><Textarea rows={2} maxLength={500} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Customer asked by phone; registration checked" /></Field>
      </div>
    </Modal>
  );
}

type SenderAction = { kind: 'approve' | 'reject' | 'suspend' | 'reactivate' | 'withdraw'; sender: SenderId };

/** Row actions for a sender ID, shown according to its status and the admin's permissions. */
export function SenderRowActions({ organizationId, sender }: { organizationId: string; sender: SenderId }) {
  const { canAdmin } = usePermissions();
  const [action, setAction] = useState<SenderAction | null>(null);
  const run = useApiMutation(
    (reason: string) => (action!.kind === 'withdraw' ? adminService.withdrawOrgSender(organizationId, sender.id, reason) : adminService.senderAction(sender.id, action!.kind, reason)),
    { success: 'Done', invalidate: [['admin', 'org', organizationId], ['admin', 'senders']], onSuccess: () => setAction(null) },
  );
  const open = ['PENDING', 'UNDER_REVIEW', 'NEEDS_INFORMATION'].includes(sender.status);
  const items = [
    open && canAdmin('senders.approve') && { kind: 'approve' as const, label: 'Approve', icon: <ShieldCheck className="h-3.5 w-3.5" /> },
    open && canAdmin('senders.reject') && { kind: 'reject' as const, label: 'Reject', icon: <X className="h-3.5 w-3.5" />, danger: true },
    sender.status === 'APPROVED' && canAdmin('senders.suspend') && { kind: 'suspend' as const, label: 'Suspend', icon: <Ban className="h-3.5 w-3.5" />, danger: true },
    sender.status === 'SUSPENDED' && canAdmin('senders.suspend') && { kind: 'reactivate' as const, label: 'Reactivate', icon: <Play className="h-3.5 w-3.5" /> },
    ['PENDING', 'NEEDS_INFORMATION', 'REJECTED'].includes(sender.status) && canAdmin('senders.review') && { kind: 'withdraw' as const, label: 'Withdraw', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true },
  ].filter(Boolean) as { kind: SenderAction['kind']; label: string; icon: JSX.Element; danger?: boolean }[];
  if (!items.length) return null;
  const labels: Record<SenderAction['kind'], string> = { approve: 'Approve', reject: 'Reject', suspend: 'Suspend', reactivate: 'Reactivate', withdraw: 'Withdraw' };
  return (
    <>
      <span className="inline-flex items-center justify-end gap-1.5">
        {items.map((i) => (
          <Button key={i.kind} size="xs" variant="secondary" className={i.danger ? 'text-red-600 hover:bg-red-50' : undefined} icon={i.icon} onClick={() => setAction({ kind: i.kind, sender })}>
            {i.label}
          </Button>
        ))}
      </span>
      <ReasonDialog open={!!action} title={action ? `${labels[action.kind]} “${sender.name}”` : ''} confirmLabel={action ? labels[action.kind] : ''} tone={action && ['reject', 'suspend', 'withdraw'].includes(action.kind) ? 'danger' : 'primary'} loading={run.isPending} onClose={() => setAction(null)} onConfirm={(reason) => run.mutate(reason)} />
    </>
  );
}

export interface OrgMember { id: string; isOwner: boolean; user: { fullName: string; email: string }; role: { name: string } }

/** Row actions for a team member: change role, disable/enable, remove. The owner is protected. */
export function MemberRowActions({ organizationId, member, disabled }: { organizationId: string; member: OrgMember; disabled: boolean }) {
  const { canAdmin } = usePermissions();
  const [dialog, setDialog] = useState<'role' | 'toggle' | 'remove' | null>(null);
  const [roleId, setRoleId] = useState('');
  const roles = useQuery({ queryKey: ['admin', 'org-roles', organizationId], queryFn: () => adminService.organizationRoles(organizationId), enabled: dialog === 'role' });
  useEffect(() => {
    if (dialog === 'role') setRoleId('');
  }, [dialog]);
  const refresh = [['admin', 'org', organizationId]];
  const update = useApiMutation(({ reason, ...body }: { reason: string; roleId?: string; status?: 'ACTIVE' | 'DISABLED' }) => adminService.updateOrgMember(organizationId, member.id, { ...body, reason }), { success: 'Member updated', invalidate: refresh, onSuccess: () => setDialog(null) });
  const remove = useApiMutation((reason: string) => adminService.removeOrgMember(organizationId, member.id, reason), { success: 'Access removed', invalidate: refresh, onSuccess: () => setDialog(null) });
  if (member.isOwner || !canAdmin('organizations.update')) return null;
  return (
    <>
      <span className="inline-flex items-center justify-end gap-1.5">
        <Button size="xs" variant="secondary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setDialog('role')}>Change role</Button>
        <Button size="xs" variant="secondary" icon={disabled ? <Play className="h-3.5 w-3.5" /> : <UserX className="h-3.5 w-3.5" />} onClick={() => setDialog('toggle')}>{disabled ? 'Enable' : 'Disable'}</Button>
        <Button size="xs" variant="secondary" className="text-red-600 hover:bg-red-50" icon={<UserMinus className="h-3.5 w-3.5" />} onClick={() => setDialog('remove')}>Remove</Button>
      </span>
      <Modal
        open={dialog === 'role'}
        onClose={() => setDialog(null)}
        size="sm"
        title={`Change role for ${member.user.fullName}`}
        description={`Currently ${member.role.name}.`}
        footer={<RoleFooter roleId={roleId} loading={update.isPending} onCancel={() => setDialog(null)} onConfirm={(reason) => update.mutate({ roleId, reason })} />}
      >
        <Field label="New role" required>
          <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">Choose a role…</option>
            {roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
      </Modal>
      <ReasonDialog open={dialog === 'toggle'} title={`${disabled ? 'Enable' : 'Disable'} access for ${member.user.fullName}`} description={disabled ? 'They can sign in to this organization again.' : 'They stay on the team but can no longer use this organization.'} confirmLabel={disabled ? 'Enable' : 'Disable'} tone={disabled ? 'primary' : 'danger'} loading={update.isPending} onClose={() => setDialog(null)} onConfirm={(reason) => update.mutate({ status: disabled ? 'ACTIVE' : 'DISABLED', reason })} />
      <ReasonDialog open={dialog === 'remove'} title={`Remove ${member.user.fullName}`} description="They lose access to this organization. Their account remains." confirmLabel="Remove" tone="danger" loading={remove.isPending} onClose={() => setDialog(null)} onConfirm={(reason) => remove.mutate(reason)} />
    </>
  );
}

/** Modal footer with its own reason field, so the role dialog stays a single step. */
function RoleFooter({ roleId, loading, onCancel, onConfirm }: { roleId: string; loading: boolean; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="flex w-full flex-col gap-3">
      <Input value={reason} maxLength={500} placeholder="Reason (required, recorded in the audit log)" onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button loading={loading} disabled={!roleId || reason.trim().length < MIN_REASON} onClick={() => onConfirm(reason.trim())}>Change role</Button>
      </div>
    </div>
  );
}
