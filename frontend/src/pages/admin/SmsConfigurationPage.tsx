import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { History, Ruler } from 'lucide-react';
import type { SegmentationConfig } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { Field, Input, Textarea } from '@/components/ui/Form';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { DataTable } from '@/components/ui/Table';
import { PageHeader } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { adminService } from '@/services/adminService';
import { fmtDate, fmtDateTime, fmtNumber } from '@/utils/format';

type Form = { gsm7SingleSegment: string; gsm7MultiSegment: string; ucs2SingleSegment: string; ucs2MultiSegment: string; maxMessageCharacters: string };
const FIELDS: { key: keyof Form; label: string }[] = [
  { key: 'gsm7SingleSegment', label: 'GSM-7 single-segment limit' },
  { key: 'gsm7MultiSegment', label: 'GSM-7 multi-segment limit' },
  { key: 'ucs2SingleSegment', label: 'Unicode single-segment limit' },
  { key: 'ucs2MultiSegment', label: 'Unicode multi-segment limit' },
  { key: 'maxMessageCharacters', label: 'Maximum message length' },
];

const toForm = (c: SegmentationConfig): Form => ({
  gsm7SingleSegment: String(c.gsm7.singleSegment),
  gsm7MultiSegment: String(c.gsm7.multiSegment),
  ucs2SingleSegment: String(c.ucs2.singleSegment),
  ucs2MultiSegment: String(c.ucs2.multiSegment),
  maxMessageCharacters: String(c.maxMessageCharacters),
});

/** Compact summary for dashboards and the settings page. */
export function SegmentationSummaryCard() {
  const { canAdmin } = usePermissions();
  const q = useQuery({ queryKey: ['admin', 'sms-segmentation'], queryFn: adminService.segmentation, enabled: canAdmin('settings.view') });
  if (!canAdmin('settings.view')) return null;
  const c = q.data?.active;
  return (
    <Card padded={false}>
      <CardHeader
        title="SMS configuration"
        description="Segmentation rules that decide how many credits a message uses."
        action={<LinkButton to="/admin/sms-configuration" size="xs" variant="secondary">{canAdmin('settings.update') ? 'Edit configuration' : 'View'}</LinkButton>}
      />
      {q.isLoading ? (
        <div className="p-5"><Skeleton className="h-20" /></div>
      ) : q.error ? (
        <div className="p-5"><ErrorState error={q.error} /></div>
      ) : c ? (
        <dl className="grid gap-4 p-5 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">GSM-7</dt>
            <dd className="mt-1 tabular-nums">{c.gsm7.singleSegment} chars / segment</dd>
            <dd className="tabular-nums text-slate-500">{c.gsm7.multiSegment} chars / multipart segment</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Unicode</dt>
            <dd className="mt-1 tabular-nums">{c.ucs2.singleSegment} chars / segment</dd>
            <dd className="tabular-nums text-slate-500">{c.ucs2.multiSegment} chars / multipart segment</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Maximum message</dt>
            <dd className="mt-1 tabular-nums">{fmtNumber(c.maxMessageCharacters)} characters</dd>
            <dd className="text-slate-500">
              Version {c.version} · {fmtDate(c.createdAt)}{c.createdBy ? ` · ${c.createdBy}` : ''}
            </dd>
          </div>
        </dl>
      ) : null}
    </Card>
  );
}

export function SmsConfigurationPage() {
  const { canAdmin } = usePermissions();
  const canEdit = canAdmin('settings.update');
  const q = useQuery({ queryKey: ['admin', 'sms-segmentation'], queryFn: adminService.segmentation });
  const [form, setForm] = useState<Form | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const active = q.data?.active;
  if (active && loadedVersion !== active.version) {
    setLoadedVersion(active.version);
    setForm(toForm(active));
    setReason('');
  }
  const limits = q.data?.limits;
  const values = form ? (Object.fromEntries(FIELDS.map((f) => [f.key, Number(form[f.key])])) as Record<keyof Form, number>) : null;
  const errors: Partial<Record<keyof Form, string>> = {};
  if (values && limits && form) {
    for (const f of FIELDS) {
      const v = values[f.key];
      const l = limits[f.key];
      if (form[f.key].trim() === '' || !Number.isInteger(v)) errors[f.key] = 'Enter a whole number';
      else if (v < l.min || v > l.max) errors[f.key] = `Between ${fmtNumber(l.min)} and ${fmtNumber(l.max)}`;
    }
    if (!errors.gsm7MultiSegment && values.gsm7MultiSegment > values.gsm7SingleSegment) errors.gsm7MultiSegment = 'Cannot exceed the single-segment limit';
    if (!errors.ucs2MultiSegment && values.ucs2MultiSegment > values.ucs2SingleSegment) errors.ucs2MultiSegment = 'Cannot exceed the single-segment limit';
  }
  const changed = !!(active && form && FIELDS.some((f) => form[f.key] !== toForm(active)[f.key]));
  const valid = !!form && Object.keys(errors).length === 0 && reason.trim().length >= 5;
  const save = useApiMutation(() => adminService.updateSegmentation({ ...values!, reason: reason.trim() }), {
    success: (c) => `Version ${c.version} is now active`,
    invalidate: [['admin', 'sms-segmentation'], ['sms-estimate'], ['sms-quote']],
    onSuccess: () => setConfirm(false),
  });
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f));
  const field = (k: keyof Form, label: string, hint?: string) => (
    <Field label={label} error={errors[k]} hint={hint ?? (limits ? `Allowed: ${fmtNumber(limits[k].min)}–${fmtNumber(limits[k].max)}` : undefined)}>
      <Input type="number" value={form?.[k] ?? ''} onChange={set(k)} disabled={!canEdit} invalid={!!errors[k]} className="max-w-[10rem] tabular-nums" />
    </Field>
  );
  const diff = active && values ? FIELDS.filter((f) => values[f.key] !== Number(toForm(active)[f.key])) : [];

  return (
    <div className="space-y-6">
      <PageHeader title="SMS configuration" description="How messages are measured and billed across the platform." breadcrumbs={[{ label: 'Settings', to: '/admin/settings' }, { label: 'SMS configuration' }]} />
      <Alert tone="info" title="These settings determine how many SMS credits each message requires.">
        Changes create a new configuration version that applies to new messages immediately — on the dashboard, in campaigns and through the API. Historical SMS records keep the version they were billed with and are never recalculated.
      </Alert>
      {q.isLoading ? (
        <Skeleton className="h-80 rounded-xl" />
      ) : q.error ? (
        <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <Card padded={false}>
            <CardHeader title="SMS segmentation" description={`Active version ${active!.version} · updated ${fmtDateTime(active!.createdAt)}${active!.createdBy ? ` by ${active!.createdBy}` : ''}`} action={<Badge color="green" dot>Active</Badge>} />
            <div className="space-y-6 p-5">
              <section>
                <h3 className="text-sm font-semibold text-slate-900">GSM-7</h3>
                <p className="mt-0.5 text-xs text-slate-500">Standard Latin text. Characters such as € [ ] {'{'} {'}'} count as two.</p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  {field('gsm7SingleSegment', 'Single-segment character limit')}
                  {field('gsm7MultiSegment', 'Multi-segment character limit', 'Characters per part when a message is split')}
                </div>
              </section>
              <section className="border-t border-slate-100 pt-5">
                <h3 className="text-sm font-semibold text-slate-900">Unicode / UCS-2</h3>
                <p className="mt-0.5 text-xs text-slate-500">Used automatically when a message contains characters outside GSM-7 (emoji, Arabic, Chinese…). Most emoji count as two.</p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  {field('ucs2SingleSegment', 'Single-segment character limit')}
                  {field('ucs2MultiSegment', 'Multi-segment character limit', 'Characters per part when a message is split')}
                </div>
              </section>
              <section className="border-t border-slate-100 pt-5">
                {field('maxMessageCharacters', 'Maximum message length (characters)')}
                <p className="mt-2 text-xs text-slate-500">
                  Credits per segment ({q.data!.creditsPerSegment}) and the maximum number of segments ({q.data!.maxMessageSegments}) are general settings under <Link to="/admin/settings" className="link">System settings</Link>.
                </p>
              </section>
              {canEdit && (
                <section className="space-y-3 border-t border-slate-100 pt-5">
                  <Field label="Reason for the change" required hint="Recorded in the audit log with the old and new values.">
                    <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Provider moved to 152-character multipart segments" />
                  </Field>
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" disabled={!changed} onClick={() => active && setForm(toForm(active))}>Reset</Button>
                    <Button disabled={!changed || !valid} onClick={() => setConfirm(true)}>Save changes</Button>
                  </div>
                </section>
              )}
            </div>
          </Card>
          <Card padded={false} className="h-fit">
            <CardHeader title={<span className="flex items-center gap-2"><History className="h-4 w-4 text-slate-400" /> Version history</span>} />
            <DataTable
              rows={q.data!.versions.map((v) => ({ ...v, id: String(v.version) }))}
              columns={[
                { key: 'v', header: 'Version', cell: (v) => <span className="font-medium">v{v.version}{v.version === active!.version && <Badge color="green" className="ml-2">active</Badge>}</span> },
                { key: 'r', header: 'GSM-7 / Unicode', cell: (v) => <span className="tabular-nums text-xs">{v.gsm7.singleSegment}/{v.gsm7.multiSegment} · {v.ucs2.singleSegment}/{v.ucs2.multiSegment}</span> },
                { key: 'd', header: 'Changed', cell: (v) => <span className="text-xs text-slate-500" title={v.reason ?? undefined}>{fmtDate(v.createdAt)}{v.createdBy ? ` · ${v.createdBy}` : ''}</span> },
              ]}
            />
          </Card>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        tone="primary"
        title={`Activate version ${(active?.version ?? 0) + 1}?`}
        description={
          <span className="block space-y-2">
            <span className="block">New messages will be measured with these values immediately. Existing messages are not changed.</span>
            <span className="block font-mono text-xs">
              {diff.map((f) => (
                <span key={f.key} className="block">
                  {FIELDS.find((x) => x.key === f.key)!.label}: {toForm(active!)[f.key]} → {form?.[f.key]}
                </span>
              ))}
            </span>
          </span>
        }
        confirmLabel="Activate"
        loading={save.isPending}
        onConfirm={() => save.mutate(undefined)}
      />
      {!canEdit && <p className="flex items-center gap-1 text-xs text-slate-500"><Ruler className="h-3 w-3" /> You can view this configuration; changing it requires the settings.update permission.</p>}
    </div>
  );
}
