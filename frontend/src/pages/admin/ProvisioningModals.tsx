import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Overlay';
import { useApiMutation } from '@/hooks/useApiMutation';
import { adminService } from '@/services/adminService';

/** The generated password is shown exactly once: the server keeps only a hash of it. */
function CredentialsDialog({ credentials, onDone }: { credentials: { email: string; password: string } | null; onDone: () => void }) {
  const text = credentials ? `Email: ${credentials.email}\nTemporary password: ${credentials.password}\nSign in: ${window.location.origin}/login` : '';
  return (
    <Modal open={!!credentials} onClose={onDone} title="Sign-in details" description="Pass these to the new user securely. This is the only time the password is shown." footer={<Button onClick={onDone}>I have copied it</Button>}>
      <div className="space-y-3">
        <pre className="whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">{text}</pre>
        <Button size="sm" variant="secondary" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => navigator.clipboard.writeText(text).then(() => toast.success('Copied'))}>Copy</Button>
        <p className="text-xs text-slate-500">They were also emailed a link to choose their own password instead. The password is not stored in readable form and is not included in the email.</p>
      </div>
    </Modal>
  );
}

const clean = (v: string) => v.trim() || undefined;

/** Gives a person (existing or new) access to an existing organization. */
export function GiveAccessModal({ organizationId, open, onClose }: { organizationId: string; open: boolean; onClose: () => void }) {
  const [person, setPerson] = useState({ fullName: '', email: '', phone: '' });
  const [roleId, setRoleId] = useState('');
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);
  const roles = useQuery({ queryKey: ['admin', 'org-roles', organizationId], queryFn: () => adminService.organizationRoles(organizationId), enabled: open });
  useEffect(() => {
    if (open) (setPerson({ fullName: '', email: '', phone: '' }), setRoleId(''));
  }, [open]);
  const grant = useApiMutation(() => adminService.grantOrganizationAccess(organizationId, { person: { fullName: person.fullName.trim(), email: person.email.trim(), phone: clean(person.phone) }, roleId }), {
    success: 'Access granted',
    invalidate: [['admin', 'org', organizationId]],
    onSuccess: (r) => {
      onClose();
      if (r.user.temporaryPassword) setCredentials({ email: r.user.email, password: r.user.temporaryPassword });
    },
  });
  return (
    <>
    <CredentialsDialog credentials={credentials} onDone={() => setCredentials(null)} />
    <Modal
      open={open}
      onClose={onClose}
      title="Give access"
      description="Add a person to this organization with a role. New people get a generated password."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={grant.isPending} disabled={person.fullName.trim().length < 2 || !/.+@.+\..+/.test(person.email) || !roleId} onClick={() => grant.mutate(undefined)}>Give access</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Full name" required><Input value={person.fullName} onChange={(e) => setPerson((p) => ({ ...p, fullName: e.target.value }))} /></Field>
        <Field label="Email" required><Input type="email" value={person.email} onChange={(e) => setPerson((p) => ({ ...p, email: e.target.value }))} /></Field>
        <Field label="Phone (optional)"><Input value={person.phone} onChange={(e) => setPerson((p) => ({ ...p, phone: e.target.value }))} /></Field>
        <Field label="Role" required hint={roles.data?.find((r) => r.id === roleId)?.description ?? undefined}>
          <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">Choose a role…</option>
            {roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
    </>
  );
}
