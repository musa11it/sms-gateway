import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Copy, FileText, Link2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Overlay';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { adminService, type CreateOrganizationBody, type OrganizationProfile } from '@/services/adminService';
import type { VerificationRequirement } from '@/services/organizationService';
import { cn, fmtBytes } from '@/utils/format';
import { ValueInput } from '../onboarding/OnboardingPage';

/**
 * Platform staff run an organization through the same stages a customer does —
 * Account → Organization → Verification → Review → Approved — filling everything in on its behalf.
 * Details are saved when leaving step 2, so a half-finished setup can be resumed later.
 */
const STEPS = ['Account', 'Organization', 'Verification', 'Review', 'Approved'];
const FORMAT_MIME = { PDF: 'application/pdf', PNG: 'image/png', JPEG: 'image/jpeg' } as const;
const REQUIRED: [keyof Profile, string][] = [
  ['name', 'Organization name'],
  ['businessType', 'Business type'],
  ['country', 'Country'],
  ['address', 'Address'],
  ['registrationNumber', 'Business registration number'],
  ['contactPersonName', 'Contact person'],
  ['contactPersonPhone', 'Contact phone'],
  ['smsPurpose', 'Purpose of SMS'],
];

interface Profile { name: string; businessType: string; country: string; city: string; address: string; registrationNumber: string; taxId: string; website: string; contactPersonName: string; contactPersonPhone: string; contactPersonEmail: string; smsPurpose: string; expectedMonthlyVolume: string }
const BLANK_PROFILE: Profile = { name: '', businessType: '', country: 'Rwanda', city: '', address: '', registrationNumber: '', taxId: '', website: '', contactPersonName: '', contactPersonPhone: '', contactPersonEmail: '', smsPurpose: '', expectedMonthlyVolume: '' };
const BLANK_OWNER = { fullName: '', email: '', phone: '' };
const clean = (v: string) => v.trim() || undefined;
const looksLikeEmail = (v: string) => /.+@.+\..+/.test(v.trim());

function toBody(p: Profile): OrganizationProfile {
  return {
    businessType: clean(p.businessType), country: clean(p.country), city: clean(p.city), address: clean(p.address), registrationNumber: clean(p.registrationNumber), taxId: clean(p.taxId),
    website: clean(p.website), contactPersonName: clean(p.contactPersonName), contactPersonPhone: clean(p.contactPersonPhone), contactPersonEmail: clean(p.contactPersonEmail),
    smsPurpose: clean(p.smsPurpose), expectedMonthlyVolume: p.expectedMonthlyVolume.trim() ? Number(p.expectedMonthlyVolume) : undefined,
  };
}

const ON_FILE_PREFIX = 'On file — ';

/** Optional note for an item that is already on file (where the original is kept, how it was checked). */
function OnFileNote({ initial, saving, onSave }: { initial: string; saving: boolean; onSave: (note: string) => void }) {
  const [note, setNote] = useState(initial);
  useEffect(() => setNote(initial), [initial]);
  return (
    <form className="flex w-full max-w-sm items-center gap-2" onSubmit={(e) => (e.preventDefault(), onSave(note.trim()))}>
      <Input value={note} maxLength={300} placeholder="Where is it kept? (optional)" aria-label="Note" onChange={(e) => setNote(e.target.value)} />
      <Button type="submit" size="sm" variant="secondary" loading={saving} disabled={note.trim() === initial}>Save</Button>
    </form>
  );
}

function StepBar({ current, canGo, onGo }: { current: number; canGo: (step: number) => boolean; onGo: (step: number) => void }) {
  return (
    <ol className="mb-6 flex items-center">
      {STEPS.map((label, i) => (
        <li key={label} className={cn('flex items-center', i < STEPS.length - 1 && 'flex-1')}>
          <button type="button" disabled={i === current || !canGo(i)} onClick={() => onGo(i)} className="flex items-center disabled:cursor-default" aria-label={`Go to ${label}`}>
            <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold', i < current ? 'bg-emerald-500 text-white' : i === current ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500')}>
              {i < current ? <Check className="h-4 w-4" /> : i + 1}
            </span>
            <span className={cn('ml-2 hidden text-xs font-medium sm:inline', i === current ? 'text-slate-900' : 'text-slate-400')}>{label}</span>
          </button>
          {i < STEPS.length - 1 && <span className={cn('mx-3 h-px flex-1', i < current ? 'bg-emerald-300' : 'bg-slate-200')} />}
        </li>
      ))}
    </ol>
  );
}

export function OrganizationWizard({ open, onClose, organizationId }: { open: boolean; onClose: () => void; /** Resume an existing organization at the Verification step. */ organizationId?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { canAdmin } = usePermissions();
  const [step, setStep] = useState(0);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [owner, setOwner] = useState(BLANK_OWNER);
  const [profile, setProfile] = useState(BLANK_PROFILE);
  const [apiEnabled, setApiEnabled] = useState(true);
  // Most organizations list their owner as the contact person, so that is the default (no second entry).
  const [sameAsOwner, setSameAsOwner] = useState(true);
  const [password, setPassword] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'SAVE_DRAFT' | 'SUBMIT' | 'APPROVE'>('SAVE_DRAFT');
  const [note, setNote] = useState('');
  const [finished, setFinished] = useState<'SAVE_DRAFT' | 'SUBMIT' | 'APPROVE' | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const resuming = !!organizationId;
  // The account is created once and then read-only, so a resumed setup goes back as far as the Organization step.
  const minStep = resuming ? 1 : 0;
  const prefilled = useRef(false);

  const businessTypes = useQuery({ queryKey: ['admin', 'business-types'], queryFn: async () => ((await adminService.settings()).find((s) => s.key === 'verification.businessTypes')?.value as string[]) ?? [], enabled: open, staleTime: 5 * 60_000 });
  const existing = useQuery({ queryKey: ['admin', 'org', organizationId], queryFn: () => adminService.organization(organizationId!), enabled: open && resuming });

  // (Re)start whenever the wizard is opened.
  useEffect(() => {
    if (!open) return;
    prefilled.current = false;
    setStep(resuming ? 2 : 0);
    setOrgId(organizationId ?? null);
    setOwner(BLANK_OWNER);
    setProfile(BLANK_PROFILE);
    setApiEnabled(true);
    setSameAsOwner(!resuming);
    setPassword(null);
    setOutcome('SAVE_DRAFT');
    setNote('');
    setFinished(null);
  }, [open, organizationId, resuming]);

  // Resuming: pre-fill from what is already saved.
  useEffect(() => {
    const o = existing.data;
    // Fill the form once per opening, so a refetch never overwrites what the admin has typed.
    if (!open || !o || prefilled.current) return;
    prefilled.current = true;
    setProfile({ ...BLANK_PROFILE, name: o.name, businessType: o.businessType ?? '', country: o.country ?? '', city: o.city ?? '', address: o.address ?? '', registrationNumber: o.registrationNumber ?? '', taxId: o.taxId ?? '', website: o.website ?? '', contactPersonName: o.contactPersonName ?? '', contactPersonPhone: o.contactPersonPhone ?? '', contactPersonEmail: o.contactPersonEmail ?? '', smsPurpose: o.smsPurpose ?? '', expectedMonthlyVolume: o.expectedMonthlyVolume != null ? String(o.expectedMonthlyVolume) : '' });
    const ownerMember = o.members.find((m) => m.isOwner);
    if (ownerMember) {
      setOwner({ fullName: ownerMember.user.fullName, email: ownerMember.user.email, phone: '' });
      setProfile((p) => ({ ...p, contactPersonName: p.contactPersonName || ownerMember.user.fullName, contactPersonEmail: p.contactPersonEmail || ownerMember.user.email }));
    }
    setSameAsOwner(false); // the owner's phone is not known here, so show the contact fields

  }, [open, existing.data]);

  const overview = useQuery({ queryKey: ['admin', 'org-verification', orgId], queryFn: () => adminService.orgVerification(orgId!), enabled: open && !!orgId && step >= 2 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'org-verification', orgId] });

  const setP = <K extends keyof Profile>(k: K, v: Profile[K]) => setProfile((p) => ({ ...p, [k]: v }));
  const accountOk = owner.fullName.trim().length >= 2 && looksLikeEmail(owner.email);
  // What is actually saved: the owner's details when "same as owner" is on, otherwise what was typed.
  const effective: Profile = sameAsOwner ? { ...profile, contactPersonName: owner.fullName, contactPersonPhone: owner.phone, contactPersonEmail: owner.email } : profile;
  const missingProfile = REQUIRED.filter(([k]) => !effective[k].trim()).map(([, label]) => label);

  // Step 2 → 3: create the organization and its owner, or save changes to the existing one.
  const saveOrganization = useApiMutation(
    async () => {
      if (orgId) {
        await adminService.updateOrganization(orgId, { name: effective.name.trim(), ...toBody(effective) });
        return null;
      }
      const body: CreateOrganizationBody = {
        name: effective.name.trim(),
        ...toBody(effective),
        owner: { fullName: owner.fullName.trim(), email: owner.email.trim(), phone: clean(owner.phone) },
        activate: false,
        ...(apiEnabled ? {} : { apiAccess: { enabled: false, allowedScopes: null } }),
      };
      return adminService.createOrganization(body);
    },
    {
      invalidate: [['admin', 'orgs']],
      onSuccess: (r) => {
        const created = r as { organization: { id: string }; owner: { temporaryPassword: string | null } } | null;
        if (created) {
          setOrgId(created.organization.id);
          setPassword(created.owner.temporaryPassword);
        }
        void refresh();
        setStep(2);
      },
    },
  );

  const upload = async (r: VerificationRequirement, file: File) => {
    const maxMb = r.maxSizeMb ?? 5;
    if (file.size > maxMb * 1024 * 1024) return toast.error(`File is larger than ${maxMb} MB`);
    setUploading(r.type);
    try {
      await adminService.uploadOrgDocument(orgId!, r.type, file);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(null);
    }
  };
  const saveValue = useApiMutation(({ type, value }: { type: string; value: string }) => adminService.submitOrgDocumentValue(orgId!, type, value), { success: 'Saved', onSuccess: () => void refresh() });
  const markOnFile = useApiMutation(({ type, note }: { type: string; note?: string }) => adminService.markOrgDocumentOnFile(orgId!, type, note), { success: 'Saved', onSuccess: () => void refresh() });
  const removeItem = useApiMutation((id: string) => adminService.deleteOrgDocument(orgId!, id), { success: 'Removed', onSuccess: () => void refresh() });
  const finalize = useApiMutation(() => adminService.finalizeOrganization(orgId!, { outcome, note: clean(note) }), {
    invalidate: [['admin', 'orgs'], ['admin', 'org', orgId], ['admin', 'verifications']],
    onSuccess: () => (setFinished(outcome), setStep(4)),
  });

  const ov = overview.data;
  const incomplete = !!ov && (ov.missingFields.length > 0 || ov.missingDocuments.length > 0);
  const closeWizard = () => {
    if (orgId && step < 4) toast.message('Saved as a draft — continue from the organization page (Complete setup).');
    onClose();
  };

  return (
    <Modal open={open} onClose={closeWizard} size="xl" title={resuming ? 'Complete organization setup' : 'Add organization'} description="Fill in each stage on the organization’s behalf, up to approval.">
      <StepBar current={step} canGo={(i) => i >= minStep && i <= 3 && !!(orgId || i < step)} onGo={setStep} />

      {/* 1 · Account */}
      {step === 0 && (
        <div className="space-y-5">
          <p className="text-sm text-slate-600">{orgId ? 'The account was created in the previous step and can no longer be changed here.' : 'The owner signs in with this account. A password is generated automatically and shown to you once at the end.'}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" required><Input value={owner.fullName} disabled={!!orgId} onChange={(e) => setOwner((o) => ({ ...o, fullName: e.target.value }))} /></Field>
            <Field label="Email" required hint="If this person already has an account, they become the owner of the new organization."><Input type="email" value={owner.email} disabled={!!orgId} onChange={(e) => setOwner((o) => ({ ...o, email: e.target.value }))} /></Field>
            <Field label="Phone"><Input value={owner.phone} disabled={!!orgId} placeholder="0788 123 456" onChange={(e) => setOwner((o) => ({ ...o, phone: e.target.value }))} /></Field>
          </div>
          <div className="flex items-start gap-3 border-t border-slate-100 pt-4">
            <Switch checked={apiEnabled} disabled={!canAdmin('api_keys.revoke') || !!orgId} onChange={setApiEnabled} label="API access" />
            <div className="text-sm"><p className="font-medium text-slate-900">Allow API access</p><p className="text-slate-500">Lets the organization create API keys. Scopes can be limited later on its API tab.</p></div>
          </div>
        </div>
      )}

      {/* 2 · Organization */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Organization name" required className="sm:col-span-2"><Input value={profile.name} maxLength={160} onChange={(e) => setP('name', e.target.value)} /></Field>
            <Field label="Business type" required>
              <Select value={profile.businessType} onChange={(e) => setP('businessType', e.target.value)}>
                <option value="">Choose…</option>
                {businessTypes.data?.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Business registration number" required><Input value={profile.registrationNumber} maxLength={80} onChange={(e) => setP('registrationNumber', e.target.value)} /></Field>
            <Field label="Tax ID"><Input value={profile.taxId} maxLength={80} onChange={(e) => setP('taxId', e.target.value)} /></Field>
            <Field label="Website"><Input value={profile.website} placeholder="https://" onChange={(e) => setP('website', e.target.value)} /></Field>
            <Field label="Country" required><Input value={profile.country} onChange={(e) => setP('country', e.target.value)} /></Field>
            <Field label="City"><Input value={profile.city} onChange={(e) => setP('city', e.target.value)} /></Field>
            <Field label="Address" required className="sm:col-span-2"><Input value={profile.address} onChange={(e) => setP('address', e.target.value)} /></Field>
            <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 sm:col-span-2">
              <input type="checkbox" className="mt-1" checked={sameAsOwner} onChange={(e) => setSameAsOwner(e.target.checked)} />
              <span className="text-sm">
                <span className="block font-medium text-slate-900">The contact person is the account owner</span>
                <span className="block text-xs text-slate-500">{sameAsOwner ? `Uses ${owner.fullName || 'the owner'}${owner.phone ? ` · ${owner.phone}` : ''}${owner.email ? ` · ${owner.email}` : ''}. ${!owner.phone.trim() ? 'The owner has no phone number yet — add it on the Account step, or untick this to enter a different contact.' : ''}` : 'Enter a different contact person below.'}</span>
              </span>
            </label>
            {!sameAsOwner && (
              <>
                <Field label="Contact Name" required><Input value={profile.contactPersonName} onChange={(e) => setP('contactPersonName', e.target.value)} /></Field>
                <Field label="Contact phone" required><Input value={profile.contactPersonPhone} onChange={(e) => setP('contactPersonPhone', e.target.value)} /></Field>
                <Field label="Contact email"><Input type="email" value={profile.contactPersonEmail} onChange={(e) => setP('contactPersonEmail', e.target.value)} /></Field>
              </>
            )}
            <Field label="Expected SMS per month"><Input type="number" min={0} value={profile.expectedMonthlyVolume} onChange={(e) => setP('expectedMonthlyVolume', e.target.value)} /></Field>
            <Field label="Purpose of SMS" required className="sm:col-span-2"><Textarea rows={3} maxLength={1000} value={profile.smsPurpose} onChange={(e) => setP('smsPurpose', e.target.value)} /></Field>
          </div>
        </div>
      )}

      {/* 3 · Verification */}
      {step === 2 && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Provide each item below on the organization’s behalf. Files are stored privately and checked exactly as if the customer had uploaded them.</p>
          {overview.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {ov?.requirements.map((r) => {
            const docs = ov.documents.filter((d) => d.documentType === r.type);
            const active = docs.find((d) => ['PENDING', 'APPROVED'].includes(d.status));
            const isFile = r.kind === 'FILE';
            const formats = r.allowedFormats ?? (['PDF', 'PNG', 'JPEG'] as const);
            const onFileMarker = docs.find((d) => d.onFile);
            const hasUploadedFile = docs.some((d) => !d.onFile && d.status !== 'REJECTED' && d.mimeType !== null);
            return (
              <div key={r.type} className={cn('rounded-xl border p-4', active ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-white')}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg', active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500')}>{active ? <Check className="h-5 w-5" /> : isFile ? <FileText className="h-5 w-5" /> : <Link2 className="h-5 w-5" />}</span>
                    <div>
                      <p className="text-sm font-medium text-slate-900">{r.label} {r.required ? <span className="text-red-500">*</span> : <span className="text-xs font-normal text-slate-400">(optional)</span>}</p>
                      {r.description && <p className="text-xs text-slate-500">{r.description}</p>}
                      {isFile && <p className="text-xs text-slate-400">{formats.join(', ')} · up to {r.maxSizeMb ?? 5} MB</p>}
                    </div>
                  </div>
                  {isFile ? (
                    onFileMarker ? (
                      <OnFileNote initial={onFileMarker.value?.startsWith(ON_FILE_PREFIX) ? onFileMarker.value.slice(ON_FILE_PREFIX.length) : ''} saving={markOnFile.isPending && markOnFile.variables?.type === r.type} onSave={(note) => markOnFile.mutate({ type: r.type, note: note || undefined })} />
                    ) : (
                      <>
                        <input type="file" className="hidden" accept={formats.map((f) => FORMAT_MIME[f]).join(',')} ref={(el) => (inputs.current[r.type] = el)} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(r, f); e.target.value = ''; }} />
                        <Button variant="secondary" size="sm" loading={uploading === r.type} icon={<Upload className="h-3.5 w-3.5" />} onClick={() => inputs.current[r.type]?.click()}>{docs.length ? 'Upload another' : 'Upload'}</Button>
                      </>
                    )
                  ) : (
                    <ValueInput requirement={r} current={active?.value} saving={saveValue.isPending && saveValue.variables?.type === r.type} onSave={(value) => saveValue.mutate({ type: r.type, value })} />
                  )}
                </div>
                {isFile && (
                  <label className={cn('mt-3 flex items-center gap-2 border-t border-slate-100 pt-3 text-sm text-slate-700', hasUploadedFile && 'opacity-50')} title={hasUploadedFile ? 'A file is uploaded — remove it first to use this' : undefined}>
                    <Switch
                      checked={!!onFileMarker}
                      disabled={hasUploadedFile || markOnFile.isPending || removeItem.isPending}
                      label={`We already have ${r.label}`}
                      onChange={(on) => (on ? markOnFile.mutate({ type: r.type }) : onFileMarker && removeItem.mutate(onFileMarker.id))}
                    />
                    We already have this document — no upload needed
                  </label>
                )}
                {docs.length > 0 && (
                  <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
                    {docs.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-slate-700">{d.onFile ? 'Already on file' : d.value ?? d.originalName}</span>
                          {d.sizeBytes != null && <span className="shrink-0 text-xs text-slate-400">{fmtBytes(d.sizeBytes)}</span>}
                          <StatusBadge status={d.status} />
                        </span>
                        {d.status !== 'APPROVED' && <button className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove" onClick={() => removeItem.mutate(d.id)}><Trash2 className="h-4 w-4" /></button>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 4 · Review */}
      {step === 3 && (
        <div className="space-y-5">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {[['Owner', `${owner.fullName} · ${owner.email}`], ['Organization', profile.name], ['Business type', profile.businessType], ['Registration no.', profile.registrationNumber], ['Address', [profile.address, profile.city, profile.country].filter(Boolean).join(', ')], ['Contact', `${effective.contactPersonName} · ${effective.contactPersonPhone}`], ['Purpose of SMS', profile.smsPurpose]].map(([k, v]) => (
              <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-medium text-slate-900">{v || '—'}</dd></div>
            ))}
            <div className="sm:col-span-2"><dt className="text-xs text-slate-500">Verification items provided</dt><dd className="font-medium text-slate-900">{ov?.documents.filter((d) => d.status !== 'REJECTED').length ?? 0}</dd></div>
          </dl>
          {incomplete && (
            <Alert tone="warning" title="Not complete yet">
              <p>Still missing: {[...(ov?.missingFields.map((f) => f.label) ?? []), ...(ov?.missingDocuments.map((d) => d.label) ?? [])].join(', ')}. You can save as a draft and finish later, or fix it now:</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(ov?.missingFields.length ?? 0) > 0 && <Button size="xs" variant="secondary" onClick={() => setStep(1)}>Go to Organization details</Button>}
                {(ov?.missingDocuments.length ?? 0) > 0 && <Button size="xs" variant="secondary" onClick={() => setStep(2)}>Go to Verification items</Button>}
              </div>
            </Alert>
          )}
          <div className="space-y-2">
            {([
              ['SAVE_DRAFT', 'Save as draft', 'The owner can finish verification themselves.'],
              ['SUBMIT', 'Submit for review', 'Goes to the verification queue for a staff decision.'],
              ['APPROVE', 'Approve now', 'Everything is verified: the organization becomes active immediately.'],
            ] as const).map(([value, title, text]) => {
              const blocked = (value !== 'SAVE_DRAFT' && incomplete) || (value === 'APPROVE' && !canAdmin('verification.approve'));
              return (
                <label key={value} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3', outcome === value ? 'border-brand-500 bg-brand-50/40' : 'border-slate-200', blocked && 'cursor-not-allowed opacity-50')}>
                  <input type="radio" className="mt-1" name="outcome" disabled={blocked} checked={outcome === value} onChange={() => setOutcome(value)} />
                  <span><span className="block text-sm font-medium text-slate-900">{title}</span><span className="block text-xs text-slate-500">{text}{value === 'APPROVE' && !canAdmin('verification.approve') ? ' Needs the verification.approve permission.' : ''}</span></span>
                </label>
              );
            })}
          </div>
          {outcome === 'APPROVE' && (
            <Field label="Approval note (optional)" hint="Recorded in the organization’s review history."><Input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></Field>
          )}
        </div>
      )}

      {/* 5 · Approved / done */}
      {step === 4 && (
        <div className="space-y-5">
          <Alert tone="success" title={finished === 'APPROVE' ? 'Organization approved' : finished === 'SUBMIT' ? 'Submitted for review' : 'Saved as a draft'}>
            {finished === 'APPROVE' ? `${profile.name} is verified and active. It can request a sender ID and buy credits.` : finished === 'SUBMIT' ? `${profile.name} is waiting in the verification queue.` : `${profile.name} was saved. Continue any time from the organization page.`}
          </Alert>
          {password && (
            <div className="space-y-2 rounded-lg border border-slate-200 p-4">
              <p className="text-sm font-medium text-slate-900">Owner sign-in details — shown only once</p>
              <pre className="whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">{`Email: ${owner.email}\nTemporary password: ${password}\nSign in: ${window.location.origin}/login`}</pre>
              <Button size="sm" variant="secondary" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => navigator.clipboard.writeText(`Email: ${owner.email}\nTemporary password: ${password}\nSign in: ${window.location.origin}/login`).then(() => toast.success('Copied'))}>Copy</Button>
              <p className="text-xs text-slate-500">They were also emailed a link to choose their own password. The password is stored only as a hash and is not in the email.</p>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between border-t border-slate-100 pt-4">
        {step === 4 ? (
          <span />
        ) : (
          <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} disabled={step <= minStep} onClick={() => setStep((s) => s - 1)}>Back</Button>
        )}
        {step === 0 && <Button icon={<ArrowRight className="h-4 w-4" />} disabled={!accountOk} onClick={() => setStep(1)}>Next</Button>}
        {step === 1 && (
          <Button icon={<ArrowRight className="h-4 w-4" />} loading={saveOrganization.isPending} disabled={missingProfile.length > 0} onClick={() => saveOrganization.mutate(undefined)} title={missingProfile.length ? `Missing: ${missingProfile.join(', ')}` : undefined}>
            {orgId ? 'Save & continue' : 'Create & continue'}
          </Button>
        )}
        {step === 2 && <Button icon={<ArrowRight className="h-4 w-4" />} onClick={() => setStep(3)}>Review</Button>}
        {step === 3 && <Button loading={finalize.isPending} icon={<Check className="h-4 w-4" />} onClick={() => finalize.mutate(undefined)}>{outcome === 'APPROVE' ? 'Approve organization' : outcome === 'SUBMIT' ? 'Submit for review' : 'Save draft'}</Button>}
        {step === 4 && <Button onClick={() => { const id = orgId; onClose(); if (id) navigate(`/admin/organizations/${id}`); }}>Open organization</Button>}
      </div>
    </Modal>
  );
}
