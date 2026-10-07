import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { ArrowLeft, ArrowRight, Check, Clock3, FileText, Hourglass, Link2, LogOut, MailCheck, PartyPopper, RefreshCw, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import type { Organization } from '@/api/types';
import { LogoMark } from '@/components/layout/Brand';
import { StatusBadge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert, PageLoader } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Form';
import { DescriptionList } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { useLogout, useMe } from '@/hooks/useAuth';
import { authService } from '@/services/authService';
import { organizationService, type VerificationOverview, type VerificationRequirement } from '@/services/organizationService';
import { cn, fmtBytes, fmtDateTime } from '@/utils/format';
import { handleFormError } from '@/utils/forms';

const STEPS = ['Account', 'Organization', 'Verification', 'Review', 'Approved'];

function Stepper({ current, completed }: { current: number; completed: number }) {
  return (
    <ol className="flex items-center">
      {STEPS.map((s, i) => {
        const done = i < completed;
        const active = i === current;
        return (
          <li key={s} className={cn('flex items-center', i < STEPS.length - 1 && 'flex-1')}>
            <div className="flex flex-col items-center gap-1.5 sm:flex-row sm:gap-2.5">
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-2 transition',
                  done ? 'bg-brand-600 text-white ring-brand-600' : active ? 'bg-white text-brand-700 ring-brand-600' : 'bg-white text-slate-400 ring-slate-200',
                )}
              >
                {done ? <Check className="h-4 w-4" /> : i + 1}
              </span>
              <span className={cn('text-xs font-medium sm:text-sm', active ? 'text-slate-900' : done ? 'text-slate-700' : 'text-slate-400')}>{s}</span>
            </div>
            {i < STEPS.length - 1 && <span className={cn('mx-2 h-0.5 flex-1 rounded sm:mx-4', done ? 'bg-brand-600' : 'bg-slate-200')} />}
          </li>
        );
      })}
    </ol>
  );
}

/** Optional phone verification with a 6-digit code (dev: code appears in the dev outbox). */
export function PhoneVerification() {
  const { data: me, refetch } = useMe();
  const [phone, setPhone] = useState(me?.user.phone ?? '');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const save = useApiMutation(() => authService.updateProfile({ phone }), { success: 'Phone number saved', onSuccess: () => void refetch() });
  const send = useApiMutation(() => authService.sendPhoneCode(), { success: 'Code sent', onSuccess: () => setSent(true) });
  const verify = useApiMutation(() => authService.verifyPhone(code), { success: 'Phone verified', onSuccess: () => void refetch() });
  if (!me) return null;
  if (me.user.phoneVerifiedAt) return <Alert tone="success" title="Phone verified">{me.user.phone}</Alert>;
  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <p className="text-sm font-medium text-slate-900">Verify your phone <span className="font-normal text-slate-400">(recommended)</span></p>
      <p className="mt-0.5 text-xs text-slate-500">We use it for security alerts about your account.</p>
      {!me.user.phone ? (
        <div className="mt-3 flex gap-2">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+250 788 000 000" className="max-w-xs" />
          <Button variant="secondary" loading={save.isPending} disabled={phone.trim().length < 9} onClick={() => save.mutate(undefined)}>Save</Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-slate-700">{me.user.phone}</span>
          <Button size="sm" variant="secondary" loading={send.isPending} onClick={() => send.mutate(undefined)}>{sent ? 'Resend code' : 'Send code'}</Button>
          {sent && (
            <>
              <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit code" className="w-32 font-mono" />
              <Button size="sm" loading={verify.isPending} disabled={code.length !== 6} onClick={() => verify.mutate(undefined)}>Verify</Button>
            </>
          )}
          {sent && !import.meta.env.PROD && (
            <Link to="/dev/mailbox" target="_blank" className="link text-xs">Open dev outbox</Link>
          )}
        </div>
      )}
    </div>
  );
}

function AccountStep({ onNext }: { onNext: () => void }) {
  const { data: me, refetch } = useMe();
  const resend = useApiMutation(() => authService.resendVerification(), { success: 'Verification email sent' });
  const verified = !!me?.user.emailVerifiedAt;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Verify your email</h2>
        <p className="mt-1 text-sm text-slate-500">We need a confirmed email address to secure your account and send delivery alerts.</p>
      </div>
      {verified ? (
        <Alert tone="success" title="Email verified">
          {me?.user.email} is confirmed.
        </Alert>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-6 text-center">
          <MailCheck className="mx-auto h-10 w-10 text-brand-500" />
          <p className="mt-3 font-medium text-slate-900">Check your inbox</p>
          <p className="mt-1 text-sm text-slate-500">
            We sent a verification link to <strong>{me?.user.email}</strong>.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => resend.mutate(undefined)} loading={resend.isPending}>
              Resend email
            </Button>
            <Button variant="ghost" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void refetch()}>
              I’ve verified
            </Button>
          </div>
          {!import.meta.env.PROD && (
            <p className="mt-4 text-xs text-slate-500">
              Development: emails are not delivered.{' '}
              <Link to="/dev/mailbox" target="_blank" className="link">
                Open the dev mailbox
              </Link>{' '}
              to click the link.
            </p>
          )}
        </div>
      )}
      <PhoneVerification />
      <div className="flex justify-end">
        <Button onClick={onNext} disabled={!verified} icon={<ArrowRight className="h-4 w-4" />}>
          Continue
        </Button>
      </div>
    </div>
  );
}

const orgSchema = z.object({
  name: z.string().trim().min(2, 'Required'),
  businessType: z.string().min(1, 'Select a business type'),
  country: z.string().trim().min(2, 'Required'),
  city: z.string().trim().optional(),
  address: z.string().trim().min(3, 'Required'),
  registrationNumber: z.string().trim().min(2, 'Required'),
  taxId: z.string().trim().optional(),
  website: z.string().trim().url('Enter a full URL, e.g. https://example.com').optional().or(z.literal('')),
  contactPersonName: z.string().trim().min(2, 'Required'),
  contactPersonPhone: z.string().trim().min(6, 'Required'),
  contactPersonEmail: z.string().trim().email('Invalid email').optional().or(z.literal('')),
  smsPurpose: z.string().trim().min(10, 'Tell us a bit more (at least 10 characters)'),
  expectedMonthlyVolume: z.coerce.number().int().min(0).optional(),
});
type OrgForm = z.infer<typeof orgSchema>;

function OrganizationStep({ org, overview, onBack, onNext }: { org: Organization; overview: VerificationOverview; onBack: () => void; onNext: () => void }) {
  const qc = useQueryClient();
  const locked = !overview.canEdit;
  const form = useForm<OrgForm>({
    resolver: zodResolver(orgSchema),
    defaultValues: {
      name: org.name,
      businessType: org.businessType ?? '',
      country: org.country ?? 'Rwanda',
      city: org.city ?? '',
      address: org.address ?? '',
      registrationNumber: org.registrationNumber ?? '',
      taxId: org.taxId ?? '',
      website: org.website ?? '',
      contactPersonName: org.contactPersonName ?? '',
      contactPersonPhone: org.contactPersonPhone ?? '',
      contactPersonEmail: org.contactPersonEmail ?? '',
      smsPurpose: org.smsPurpose ?? '',
      expectedMonthlyVolume: org.expectedMonthlyVolume ?? undefined,
    },
  });
  const [saving, setSaving] = useState(false);
  const save = form.handleSubmit(async (v) => {
    setSaving(true);
    try {
      await organizationService.update({ ...v, website: v.website || null, contactPersonEmail: v.contactPersonEmail || null, taxId: v.taxId || null, city: v.city || null } as Partial<Organization>);
      await qc.invalidateQueries({ queryKey: ['verification'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('Organization profile saved');
      onNext();
    } catch (e) {
      handleFormError(e, form.setError);
    } finally {
      setSaving(false);
    }
  });
  const e = form.formState.errors;
  return (
    <form onSubmit={save} className="space-y-6" noValidate>
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Tell us about your organization</h2>
        <p className="mt-1 text-sm text-slate-500">This information is reviewed by our compliance team and appears on your invoices.</p>
      </div>
      <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2">
        <Field label="Organization name" required error={e.name?.message}>
          <Input {...form.register('name')} invalid={!!e.name} />
        </Field>
        <Field label="Business type" required error={e.businessType?.message}>
          <Select {...form.register('businessType')} invalid={!!e.businessType}>
            <option value="">Select…</option>
            {overview.businessTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <Field label="Business registration number" required error={e.registrationNumber?.message}>
          <Input {...form.register('registrationNumber')} placeholder="e.g. RDB company code" invalid={!!e.registrationNumber} />
        </Field>
        <Field label="Tax ID (TIN)" hint="If applicable">
          <Input {...form.register('taxId')} />
        </Field>
        <Field label="Country" required error={e.country?.message}>
          <Input {...form.register('country')} invalid={!!e.country} />
        </Field>
        <Field label="City">
          <Input {...form.register('city')} />
        </Field>
        <Field label="Address" required className="sm:col-span-2" error={e.address?.message}>
          <Input {...form.register('address')} invalid={!!e.address} />
        </Field>
        <Field label="Website" error={e.website?.message}>
          <Input {...form.register('website')} placeholder="https://" invalid={!!e.website} />
        </Field>
        <Field label="Expected SMS per month">
          <Input type="number" min={0} {...form.register('expectedMonthlyVolume')} />
        </Field>
        <div className="sm:col-span-2 mt-2 border-t border-slate-100 pt-4">
          <p className="text-sm font-semibold text-slate-900">Contact person</p>
        </div>
        <Field label="Full name" required error={e.contactPersonName?.message}>
          <Input {...form.register('contactPersonName')} invalid={!!e.contactPersonName} />
        </Field>
        <Field label="Phone" required error={e.contactPersonPhone?.message}>
          <Input {...form.register('contactPersonPhone')} placeholder="+250 788 000 000" invalid={!!e.contactPersonPhone} />
        </Field>
        <Field label="Email" error={e.contactPersonEmail?.message}>
          <Input {...form.register('contactPersonEmail')} invalid={!!e.contactPersonEmail} />
        </Field>
        <Field label="Purpose of SMS" required className="sm:col-span-2" error={e.smsPurpose?.message} hint="Who will you message, and what kind of messages (transactional, marketing, alerts)?">
          <Textarea rows={3} {...form.register('smsPurpose')} invalid={!!e.smsPurpose} />
        </Field>
      </fieldset>
      <div className="flex justify-between">
        <Button type="button" variant="ghost" onClick={onBack} icon={<ArrowLeft className="h-4 w-4" />}>
          Back
        </Button>
        {locked ? (
          <Button type="button" onClick={onNext} icon={<ArrowRight className="h-4 w-4" />}>
            Continue
          </Button>
        ) : (
          <Button type="submit" loading={saving} icon={<ArrowRight className="h-4 w-4" />}>
            Save & continue
          </Button>
        )}
      </div>
    </form>
  );
}

const FORMAT_MIME = { PDF: 'application/pdf', PNG: 'image/png', JPEG: 'image/jpeg' } as const;
const FORMAT_LABEL = { PDF: 'PDF', PNG: 'PNG', JPEG: 'JPEG' } as const;

/** Link / text / date / choice answer for one verification item. */
export function ValueInput({ requirement, current, onSave, saving }: { requirement: VerificationRequirement; current?: string | null; onSave: (value: string) => void; saving: boolean }) {
  const [value, setValue] = useState(current ?? '');
  useEffect(() => setValue(current ?? ''), [current]);
  const common = { value, onChange: (e: { target: { value: string } }) => setValue(e.target.value), 'aria-label': requirement.label };
  return (
    <form
      className="flex w-full max-w-md items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSave(value.trim());
      }}
    >
      {requirement.kind === 'SELECT' ? (
        <Select {...common}>
          <option value="">Choose…</option>
          {requirement.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      ) : requirement.kind === 'TEXT' ? (
        <Input {...common} maxLength={requirement.maxLength ?? 500} />
      ) : requirement.kind === 'DATE' ? (
        <Input {...common} type="date" />
      ) : (
        <Input {...common} type="url" placeholder="https://example.com" />
      )}
      <Button type="submit" variant="secondary" size="sm" loading={saving} disabled={!value.trim() || value.trim() === current}>
        Save
      </Button>
    </form>
  );
}

function DocumentsStep({ overview, onBack, onNext }: { overview: VerificationOverview; onBack: () => void; onNext: () => void }) {
  const qc = useQueryClient();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const remove = useApiMutation((id: string) => organizationService.deleteDocument(id), { success: 'Removed', invalidate: [['verification']] });
  const saveValue = useApiMutation(({ type, value }: { type: string; value: string }) => organizationService.submitDocumentValue(type, value), { success: 'Saved', invalidate: [['verification']] });

  const upload = async (r: VerificationRequirement, file: File) => {
    const maxMb = r.maxSizeMb ?? 5;
    if (file.size > maxMb * 1024 * 1024) return toast.error(`File is larger than ${maxMb} MB`);
    setUploading(r.type);
    try {
      await organizationService.uploadDocument(r.type, file);
      toast.success('Document uploaded');
      await qc.invalidateQueries({ queryKey: ['verification'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Upload verification documents</h2>
        <p className="mt-1 text-sm text-slate-500">Provide the items below. Files are stored privately and only visible to our review team.</p>
      </div>
      <div className="space-y-3">
        {overview.requirements.map((r) => {
          const docs = overview.documents.filter((d) => d.documentType === r.type);
          const active = docs.find((d) => ['PENDING', 'APPROVED'].includes(d.status));
          const isFile = r.kind === 'FILE';
          const formats = r.allowedFormats ?? (['PDF', 'PNG', 'JPEG'] as const);
          return (
            <div key={r.type} className={cn('rounded-xl border p-4 transition', active ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-white')}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className={cn('flex h-10 w-10 items-center justify-center rounded-lg', active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
                    {active ? <Check className="h-5 w-5" /> : isFile ? <FileText className="h-5 w-5" /> : <Link2 className="h-5 w-5" />}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      {r.label} {r.required ? <span className="text-red-500">*</span> : <span className="text-xs font-normal text-slate-400">(optional)</span>}
                    </p>
                    {r.description && <p className="text-xs text-slate-500">{r.description}</p>}
                    {isFile && <p className="text-xs text-slate-400">{formats.map((f) => FORMAT_LABEL[f]).join(', ')} · up to {r.maxSizeMb ?? 5} MB</p>}
                  </div>
                </div>
                {overview.canEdit && isFile && (
                  <>
                    <input
                      type="file"
                      accept={formats.map((f) => FORMAT_MIME[f]).join(',')}
                      className="hidden"
                      ref={(el) => (inputs.current[r.type] = el)}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void upload(r, f);
                        e.target.value = '';
                      }}
                    />
                    <Button variant="secondary" size="sm" loading={uploading === r.type} icon={<Upload className="h-3.5 w-3.5" />} onClick={() => inputs.current[r.type]?.click()}>
                      {docs.length ? 'Upload another' : 'Upload'}
                    </Button>
                  </>
                )}
                {overview.canEdit && !isFile && (
                  <ValueInput
                    requirement={r}
                    current={active?.value}
                    saving={saveValue.isPending && saveValue.variables?.type === r.type}
                    onSave={(value) => saveValue.mutate({ type: r.type, value })}
                  />
                )}
              </div>
              {docs.length > 0 && (
                <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
                  {docs.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        {d.value ? <Link2 className="h-4 w-4 shrink-0 text-slate-400" /> : <FileText className="h-4 w-4 shrink-0 text-slate-400" />}
                        <span className="truncate text-slate-700">{d.value ?? d.originalName}</span>
                        {d.sizeBytes != null && <span className="shrink-0 text-xs text-slate-400">{fmtBytes(d.sizeBytes)}</span>}
                        <StatusBadge status={d.status} />
                      </span>
                      <span className="flex items-center gap-2">
                        {d.reviewNote && <span className="text-xs text-amber-700">{d.reviewNote}</span>}
                        {overview.canEdit && d.status !== 'APPROVED' && (
                          <button className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => remove.mutate(d.id)} aria-label="Remove">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack} icon={<ArrowLeft className="h-4 w-4" />}>
          Back
        </Button>
        <Button onClick={onNext} disabled={overview.missingDocuments.length > 0} icon={<ArrowRight className="h-4 w-4" />}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function ReviewStep({ org, overview, onBack, onGoto }: { org: Organization; overview: VerificationOverview; onBack: () => void; onGoto: (s: number) => void }) {
  const qc = useQueryClient();
  const submit = useApiMutation(() => organizationService.submitVerification(), {
    success: 'Submitted for review',
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['verification'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Review & submit</h2>
        <p className="mt-1 text-sm text-slate-500">Double-check your details. Once submitted, you can’t edit them until our team responds.</p>
      </div>
      {overview.missingFields.length > 0 && (
        <Alert tone="warning" title="Profile incomplete" action={<Button size="sm" variant="secondary" onClick={() => onGoto(1)}>Fix</Button>}>
          Missing: {overview.missingFields.map((f) => f.label).join(', ')}
        </Alert>
      )}
      {overview.missingDocuments.length > 0 && (
        <Alert tone="warning" title="Documents missing" action={<Button size="sm" variant="secondary" onClick={() => onGoto(2)}>Upload</Button>}>
          {overview.missingDocuments.map((d) => d.label).join(', ')}
        </Alert>
      )}
      <Card className="bg-slate-50/50">
        <DescriptionList
          items={[
            { label: 'Organization', value: org.name },
            { label: 'Business type', value: org.businessType },
            { label: 'Registration no.', value: org.registrationNumber },
            { label: 'Tax ID', value: org.taxId },
            { label: 'Address', value: [org.address, org.city, org.country].filter(Boolean).join(', ') },
            { label: 'Contact', value: `${org.contactPersonName ?? '—'} · ${org.contactPersonPhone ?? ''}` },
            { label: 'Documents', value: `${overview.documents.filter((d) => d.status !== 'REJECTED').length} uploaded` },
            { label: 'Purpose of SMS', value: org.smsPurpose },
          ]}
        />
      </Card>
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack} icon={<ArrowLeft className="h-4 w-4" />}>
          Back
        </Button>
        <Button onClick={() => submit.mutate(undefined)} loading={submit.isPending} disabled={!overview.canSubmit}>
          Submit for review
        </Button>
      </div>
    </div>
  );
}

function StatusStep({ overview }: { overview: VerificationOverview }) {
  const { refetch } = useMe();
  const qc = useQueryClient();
  const status = overview.verification.status;
  useEffect(() => {
    if (status !== 'SUBMITTED' && status !== 'UNDER_REVIEW') return;
    const t = setInterval(() => {
      void qc.invalidateQueries({ queryKey: ['verification'] });
      void refetch();
    }, 15_000);
    return () => clearInterval(t);
  }, [status, qc, refetch]);

  if (status === 'APPROVED')
    return (
      <div className="py-6 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-200 text-accent-700">
          <PartyPopper className="h-8 w-8" />
        </div>
        <h2 className="mt-5 text-xl font-semibold text-slate-900">You’re approved!</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">Your organization is verified. Next: request a sender ID, buy SMS credits and send your first message.</p>
        <LinkButton to="/app" size="lg" className="mt-6">
          Go to dashboard
        </LinkButton>
      </div>
    );
  return (
    <div className="py-6 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-900 text-white">
        {status === 'UNDER_REVIEW' ? <Hourglass className="h-8 w-8" /> : <Clock3 className="h-8 w-8" />}
      </div>
      <h2 className="mt-5 text-xl font-semibold text-slate-900">{status === 'UNDER_REVIEW' ? 'Your application is being reviewed' : 'Application submitted'}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">Our compliance team usually reviews applications within one business day. We’ll notify you by email and in-app as soon as there’s an update.</p>
      <div className="mt-4 flex justify-center">
        <StatusBadge status={status} />
      </div>
      {overview.verification.submittedAt && <p className="mt-3 text-xs text-slate-400">Submitted {fmtDateTime(overview.verification.submittedAt)}</p>}
    </div>
  );
}

export function OnboardingPage() {
  const { data: me, isLoading: meLoading } = useMe();
  const logout = useLogout();
  const hasOrg = !!me?.organization;
  const { data: overview, isLoading } = useQuery({ queryKey: ['verification'], queryFn: organizationService.verification, enabled: hasOrg && !!me?.orgPermissions.includes('verification.view') });
  const { data: org } = useQuery({ queryKey: ['organization'], queryFn: organizationService.get, enabled: hasOrg });
  const qc = useQueryClient();
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['organization'] });
  }, [overview, qc]);

  const emailVerified = !!me?.user.emailVerifiedAt;
  const vStatus = overview?.verification.status;
  const autoStep = useMemo(() => {
    if (!emailVerified) return 0;
    if (!overview) return 1;
    if (['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'].includes(vStatus!)) return 4;
    if (overview.missingFields.length) return 1;
    if (overview.missingDocuments.length) return 2;
    return 3;
  }, [emailVerified, overview, vStatus]);
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => {
    if (vStatus && ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'].includes(vStatus)) setStep(null);
  }, [vStatus]);
  const current = step ?? autoStep;
  const completed = vStatus === 'APPROVED' ? 5 : ['SUBMITTED', 'UNDER_REVIEW'].includes(vStatus ?? '') ? 4 : Math.min(autoStep, current);

  if (meLoading || (hasOrg && (isLoading || !org))) return <PageLoader />;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200/70 bg-white">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4 sm:px-6">
          <span className="flex items-center gap-2.5 text-[15px] font-semibold text-slate-900">
            <LogoMark /> Account setup
          </span>
          <div className="flex items-center gap-2">
            {me?.organization?.status === 'ACTIVE' && (
              <LinkButton to="/app" variant="secondary" size="sm">
                Dashboard
              </LinkButton>
            )}
            <Button variant="ghost" size="sm" icon={<LogOut className="h-4 w-4" />} onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Welcome{me ? `, ${me.user.fullName.split(' ')[0]}` : ''} 👋</h1>
          <p className="mt-1 text-sm text-slate-500">A few steps to verify your business and activate SMS sending.</p>
        </div>
        <div className="mb-8">
          <Stepper current={current} completed={completed} />
        </div>

        {!hasOrg ? (
          <Card>
            <Alert tone="info" title="No organization yet">
              You are not part of an organization. Ask your organization owner to invite you, or contact support.
            </Alert>
          </Card>
        ) : (
          <>
            {vStatus === 'MORE_INFORMATION_REQUIRED' && current !== 4 && (
              <Alert tone="warning" title="Our review team needs more information" className="mb-6">
                {overview?.verification.reviewNote}
              </Alert>
            )}
            {vStatus === 'REJECTED' && current !== 4 && (
              <Alert tone="danger" title="Your previous application was rejected" className="mb-6">
                {overview?.verification.reviewNote} You can update your information and resubmit.
              </Alert>
            )}
            <Card className="p-6 sm:p-8">
              {current === 0 && <AccountStep onNext={() => setStep(1)} />}
              {current === 1 && org && overview && <OrganizationStep org={org} overview={overview} onBack={() => setStep(0)} onNext={() => setStep(2)} />}
              {current === 2 && overview && <DocumentsStep overview={overview} onBack={() => setStep(1)} onNext={() => setStep(3)} />}
              {current === 3 && org && overview && <ReviewStep org={org} overview={overview} onBack={() => setStep(2)} onGoto={setStep} />}
              {current === 4 && overview && <StatusStep overview={overview} />}
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
