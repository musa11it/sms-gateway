import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Switch } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Overlay';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { adminService, type CreateOrganizationBody } from '@/services/adminService';

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

const BLANK = { name: '', businessType: '', country: 'Rwanda', city: '', registrationNumber: '', ownerName: '', ownerEmail: '', ownerPhone: '', activate: false, apiEnabled: true };
const clean = (v: string) => v.trim() || undefined;

/** Platform staff create an organization and its owner; the owner gets an email to choose a password. */
export function CreateOrganizationModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { canAdmin } = usePermissions();
  const [f, setF] = useState(BLANK);
  const [done, setDone] = useState<{ id: string; credentials: { email: string; password: string } | null } | null>(null);
  useEffect(() => {
    if (open) setF(BLANK);
  }, [open]);
  const set = <K extends keyof typeof BLANK>(k: K, v: (typeof BLANK)[K]) => setF((s) => ({ ...s, [k]: v }));
  const businessTypes = useQuery({ queryKey: ['admin', 'business-types'], queryFn: async () => ((await adminService.settings()).find((s) => s.key === 'verification.businessTypes')?.value as string[]) ?? [], enabled: open, staleTime: 5 * 60_000 });

  const create = useApiMutation(
    () => {
      const body: CreateOrganizationBody = {
        name: f.name.trim(),
        businessType: clean(f.businessType),
        country: clean(f.country),
        city: clean(f.city),
        registrationNumber: clean(f.registrationNumber),
        owner: { fullName: f.ownerName.trim(), email: f.ownerEmail.trim(), phone: clean(f.ownerPhone) },
        activate: f.activate,
        // Only sent when it differs from the default, because it needs a separate permission.
        ...(f.apiEnabled ? {} : { apiAccess: { enabled: false, allowedScopes: null } }),
      };
      return adminService.createOrganization(body);
    },
    {
      success: 'Organization created',
      invalidate: [['admin', 'orgs']],
      onSuccess: (r) => {
        onClose();
        const credentials = r.owner.temporaryPassword ? { email: r.owner.email, password: r.owner.temporaryPassword } : null;
        if (credentials) setDone({ id: r.organization.id, credentials });
        else navigate(`/admin/organizations/${r.organization.id}`);
      },
    },
  );
  const valid = f.name.trim().length >= 2 && f.ownerName.trim().length >= 2 && /.+@.+\..+/.test(f.ownerEmail);
  return (
    <>
    <CredentialsDialog credentials={done?.credentials ?? null} onDone={() => { const id = done?.id; setDone(null); if (id) navigate(`/admin/organizations/${id}`); }} />
    <Modal
      open={open}
      onClose={onClose}
      title="Add organization"
      description="Create the organization and its owner. A password is generated for the owner automatically."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={create.isPending} disabled={!valid} onClick={() => create.mutate(undefined)}>Create organization</Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Organization name" required className="sm:col-span-2"><Input value={f.name} maxLength={160} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Business type">
            <Select value={f.businessType} onChange={(e) => set('businessType', e.target.value)}>
              <option value="">—</option>
              {businessTypes.data?.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Registration number"><Input value={f.registrationNumber} maxLength={80} onChange={(e) => set('registrationNumber', e.target.value)} /></Field>
          <Field label="Country"><Input value={f.country} onChange={(e) => set('country', e.target.value)} /></Field>
          <Field label="City"><Input value={f.city} onChange={(e) => set('city', e.target.value)} /></Field>
        </div>
        <div className="grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-2">
          <p className="text-sm font-medium text-slate-900 sm:col-span-2">Owner</p>
          <Field label="Full name" required><Input value={f.ownerName} onChange={(e) => set('ownerName', e.target.value)} /></Field>
          <Field label="Email" required hint="If this person already has an account they are made owner of the new organization."><Input type="email" value={f.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)} /></Field>
          <Field label="Phone"><Input value={f.ownerPhone} placeholder="0788 123 456" onChange={(e) => set('ownerPhone', e.target.value)} /></Field>
        </div>
        <div className="space-y-3 border-t border-slate-100 pt-5">
          <div className="flex items-start gap-3">
            <Switch checked={f.activate} disabled={!canAdmin('verification.approve')} onChange={(v) => set('activate', v)} label="Approve immediately" />
            <div className="text-sm">
              <p className="font-medium text-slate-900">Approve immediately</p>
              <p className="text-slate-500">Skips business verification: the organization can send SMS as soon as it has a sender ID and credits. {canAdmin('verification.approve') ? 'Leave off to let the owner complete verification.' : 'Needs the verification.approve permission.'}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Switch checked={f.apiEnabled} disabled={!canAdmin('api_keys.revoke')} onChange={(v) => set('apiEnabled', v)} label="API access" />
            <div className="text-sm">
              <p className="font-medium text-slate-900">Allow API access</p>
              <p className="text-slate-500">Lets the organization create API keys. Scopes can be limited later on its API tab.</p>
            </div>
          </div>
          {f.activate && <Alert tone="warning" title="Verification will be skipped">This is recorded in the organization’s review history and audit log under your name.</Alert>}
        </div>
      </div>
    </Modal>
    </>
  );
}

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
