import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Setting } from '@/services/adminService';
import { adminService } from '@/services/adminService';
import type { FileFormat, RequirementKind, VerificationRequirement } from '@/services/organizationService';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/Form';
import { useApiMutation } from '@/hooks/useApiMutation';

const KINDS: { value: RequirementKind; label: string }[] = [
  { value: 'FILE', label: 'File upload' },
  { value: 'URL', label: 'Link (URL)' },
  { value: 'TEXT', label: 'Text' },
  { value: 'DATE', label: 'Date' },
  { value: 'SELECT', label: 'Choice from a list' },
];
const FORMATS: FileFormat[] = ['PDF', 'PNG', 'JPEG'];

const toCode = (label: string) => label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);

/** A draft keeps the options as one-per-line text while editing. */
type Draft = Omit<VerificationRequirement, 'options'> & { optionsText: string; isNew?: boolean };

const toDraft = (r: VerificationRequirement): Draft => ({ ...r, kind: r.kind ?? 'FILE', optionsText: (r.options ?? []).join('\n') });

function toRequirement(d: Draft): VerificationRequirement {
  const { optionsText, isNew: _isNew, ...r } = d;
  const out: VerificationRequirement = { type: r.type, label: r.label.trim(), required: r.required, kind: r.kind };
  if (r.description?.trim()) out.description = r.description.trim();
  if (r.kind === 'FILE') {
    if (r.allowedFormats?.length && r.allowedFormats.length < FORMATS.length) out.allowedFormats = r.allowedFormats;
    if (r.maxSizeMb) out.maxSizeMb = r.maxSizeMb;
  }
  if (r.kind === 'TEXT' && r.maxLength) out.maxLength = r.maxLength;
  if (r.kind === 'SELECT') out.options = optionsText.split('\n').map((o) => o.trim()).filter(Boolean);
  return out;
}

/** Super-admin editor for the items businesses must provide during verification. */
export function RequirementsEditor({ setting, editable }: { setting: Setting; editable: boolean }) {
  const [items, setItems] = useState<Draft[]>([]);
  useEffect(() => setItems((setting.value as VerificationRequirement[]).map(toDraft)), [setting.value]);
  const save = useApiMutation((value: VerificationRequirement[]) => adminService.updateSetting(setting.key, value), { success: 'Requirements saved', invalidate: [['admin', 'settings']] });

  const patch = (i: number, change: Partial<Draft>) => setItems((list) => list.map((d, j) => (j === i ? { ...d, ...change } : d)));
  const move = (i: number, by: -1 | 1) =>
    setItems((list) => {
      const next = [...list];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });

  const submit = () => {
    const seen = new Set<string>();
    for (const d of items) {
      if (!d.label.trim()) return toast.error('Every item needs a name');
      if (seen.has(d.type)) return toast.error(`"${d.label}" duplicates another item — rename it`);
      seen.add(d.type);
      if (d.kind === 'SELECT' && !d.optionsText.trim()) return toast.error(`Add at least one option to "${d.label}"`);
    }
    save.mutate(items.map(toRequirement));
  };

  return (
    <Card padded={false}>
      <CardHeader
        title="Verification requirements"
        description="What businesses must provide when they register. Each item can be a file, a link, text, a date or a choice."
        action={editable && (
          <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setItems((l) => [...l, { type: '', label: '', required: false, kind: 'FILE', optionsText: '', isNew: true }])}>
            Add item
          </Button>
        )}
      />
      <div className="divide-y divide-slate-100">
        {items.length === 0 && <p className="px-5 py-6 text-sm text-slate-500">No items — businesses will not be asked for anything.</p>}
        {items.map((d, i) => (
          <div key={d.isNew ? `new-${i}` : d.type} className="space-y-4 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge color={d.required ? 'red' : 'gray'}>{d.required ? 'Required' : 'Optional'}</Badge>
                <span className="font-mono text-xs text-slate-400">{d.type || 'new'}</span>
              </div>
              {editable && (
                <div className="flex items-center gap-1">
                  <Button size="xs" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" icon={<ArrowUp className="h-3.5 w-3.5" />} />
                  <Button size="xs" variant="ghost" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down" icon={<ArrowDown className="h-3.5 w-3.5" />} />
                  <Button size="xs" variant="ghost" onClick={() => setItems((l) => l.filter((_, j) => j !== i))} aria-label="Remove item" icon={<Trash2 className="h-3.5 w-3.5 text-red-600" />} />
                </div>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Name" required>
                <Input value={d.label} disabled={!editable} maxLength={120} onChange={(e) => patch(i, { label: e.target.value, ...(d.isNew ? { type: toCode(e.target.value) } : {}) })} />
              </Field>
              <Field label="Collected as">
                <Select value={d.kind} disabled={!editable} onChange={(e) => patch(i, { kind: e.target.value as RequirementKind })}>
                  {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </Select>
              </Field>
              <Field label="Help text (optional)" className="md:col-span-2">
                <Input value={d.description ?? ''} disabled={!editable} maxLength={500} onChange={(e) => patch(i, { description: e.target.value })} />
              </Field>
              {d.kind === 'FILE' && (
                <>
                  <Field label="Allowed formats">
                    <div className="flex gap-4 pt-2">
                      {FORMATS.map((f) => {
                        const current = d.allowedFormats ?? FORMATS;
                        return (
                          <label key={f} className="flex items-center gap-1.5 text-sm text-slate-700">
                            <input
                              type="checkbox"
                              disabled={!editable}
                              checked={current.includes(f)}
                              onChange={(e) => {
                                const next = e.target.checked ? [...current, f] : current.filter((x) => x !== f);
                                if (next.length) patch(i, { allowedFormats: FORMATS.filter((x) => next.includes(x)) });
                              }}
                            />
                            {f}
                          </label>
                        );
                      })}
                    </div>
                  </Field>
                  <Field label="Maximum size (MB)">
                    <Input type="number" min={0.1} max={50} step={0.5} value={d.maxSizeMb ?? ''} placeholder="5" disabled={!editable} onChange={(e) => patch(i, { maxSizeMb: e.target.value ? Number(e.target.value) : undefined })} />
                  </Field>
                </>
              )}
              {d.kind === 'TEXT' && (
                <Field label="Maximum length (characters)">
                  <Input type="number" min={1} max={2000} value={d.maxLength ?? ''} placeholder="500" disabled={!editable} onChange={(e) => patch(i, { maxLength: e.target.value ? Number(e.target.value) : undefined })} />
                </Field>
              )}
              {d.kind === 'SELECT' && (
                <Field label="Options (one per line)" className="md:col-span-2">
                  <Textarea rows={4} value={d.optionsText} disabled={!editable} onChange={(e) => patch(i, { optionsText: e.target.value })} />
                </Field>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <Switch checked={d.required} disabled={!editable} onChange={(v) => patch(i, { required: v })} label="Required" />
              Required to submit
            </div>
          </div>
        ))}
      </div>
      {editable && (
        <div className="flex justify-end border-t border-slate-100 bg-slate-50/60 px-5 py-3">
          <Button loading={save.isPending} onClick={submit}>Save requirements</Button>
        </div>
      )}
    </Card>
  );
}
