import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Banknote, Calculator, Coins, Layers, Pencil, Plus, Power, Receipt, Search, Trash2, TrendingUp } from 'lucide-react';
import type { PricingTier } from '@/api/types';
import { errorMessage } from '@/api/client';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, TableSkeleton } from '@/components/ui/Feedback';
import { Checkbox, Field, Input } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Overlay';
import { DataTable } from '@/components/ui/Table';
import { PageHeader } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { adminService } from '@/services/adminService';
import { businessService } from '@/services/businessService';
import { fmtDateTime, fmtMoney, fmtNumber } from '@/utils/format';
import { RangePicker, useRange } from '../dashboard/ReportsPage';

// ── SMS pricing tiers ───────────────────────────────────────────────────

const range = (t: Pick<PricingTier, 'minQuantity' | 'maxQuantity'>) =>
  t.maxQuantity === null ? `${fmtNumber(t.minQuantity)}+` : `${fmtNumber(t.minQuantity)} – ${fmtNumber(t.maxQuantity)}`;

/** Quantity ranges no active tier covers (customers cannot buy those amounts). */
function coverageGaps(tiers: PricingTier[]): string[] {
  const active = tiers.filter((t) => t.isActive).sort((a, b) => a.minQuantity - b.minQuantity);
  if (!active.length) return ['every quantity'];
  const gaps: string[] = [];
  let next = 1;
  for (const t of active) {
    if (t.minQuantity > next) gaps.push(t.minQuantity - 1 === next ? fmtNumber(next) : `${fmtNumber(next)} – ${fmtNumber(t.minQuantity - 1)}`);
    if (t.maxQuantity === null) return gaps;
    next = t.maxQuantity + 1;
  }
  gaps.push(`${fmtNumber(next)}+`);
  return gaps;
}

function TierModal({ tier, open, onClose }: { tier: PricingTier | null; open: boolean; onClose: () => void }) {
  const empty = { name: '', minQuantity: '', maxQuantity: '', unitPrice: '', currency: 'RWF', sortOrder: '0', isActive: true };
  const [form, setForm] = useState(empty);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  if (open && loadedFor !== (tier?.id ?? null)) {
    setLoadedFor(tier?.id ?? null);
    setForm(
      tier
        ? { name: tier.name ?? '', minQuantity: String(tier.minQuantity), maxQuantity: tier.maxQuantity === null ? '' : String(tier.maxQuantity), unitPrice: tier.unitPrice, currency: tier.currency, sortOrder: String(tier.sortOrder), isActive: tier.isActive }
        : empty,
    );
  }
  const close = () => { setLoadedFor(undefined); onClose(); };
  const min = Number(form.minQuantity);
  const max = form.maxQuantity.trim() ? Number(form.maxQuantity) : null;
  const errors = {
    minQuantity: form.minQuantity && (!Number.isInteger(min) || min < 1) ? 'Whole number ≥ 1' : undefined,
    maxQuantity: max !== null && (!Number.isInteger(max) || max < min) ? 'Must be ≥ minimum' : undefined,
    unitPrice: form.unitPrice && !/^\d{1,10}(\.\d{1,4})?$/.test(form.unitPrice) ? 'Amount such as 9 or 8.50' : undefined,
  };
  const valid = !!form.minQuantity && !!form.unitPrice && !Object.values(errors).some(Boolean);
  const body = { name: form.name.trim() || null, minQuantity: min, maxQuantity: max, unitPrice: form.unitPrice, currency: form.currency.toUpperCase(), sortOrder: Number(form.sortOrder) || 0, isActive: form.isActive };
  const save = useApiMutation(() => (tier ? adminService.updatePricingTier(tier.id, body) : adminService.createPricingTier(body)), {
    success: tier ? 'Pricing tier updated' : 'Pricing tier created',
    invalidate: [['admin', 'pricing'], ['pricing']],
    onSuccess: close,
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onClose={close}
      title={tier ? `Edit tier ${range(tier)}` : 'New pricing tier'}
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Minimum SMS" required error={errors.minQuantity}><Input type="number" min={1} value={form.minQuantity} onChange={set('minQuantity')} invalid={!!errors.minQuantity} /></Field>
        <Field label="Maximum SMS" error={errors.maxQuantity} hint="Leave empty for no upper limit"><Input type="number" min={1} value={form.maxQuantity} onChange={set('maxQuantity')} invalid={!!errors.maxQuantity} /></Field>
        <Field label="Price per SMS" required error={errors.unitPrice}><Input value={form.unitPrice} onChange={set('unitPrice')} placeholder="9" invalid={!!errors.unitPrice} /></Field>
        <Field label="Currency"><Input value={form.currency} onChange={set('currency')} maxLength={3} /></Field>
        <Field label="Label" hint="Optional, e.g. Business"><Input value={form.name} onChange={set('name')} /></Field>
        <Field label="Display order"><Input type="number" min={0} value={form.sortOrder} onChange={set('sortOrder')} /></Field>
        <Checkbox className="sm:col-span-2" label="Active" description="Active tiers price customer purchases. Active ranges may not overlap." checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
      </div>
      <p className="mt-4 text-xs text-slate-500">The tier containing the purchased quantity sets the price of the whole purchase. Changes apply to new purchases only — past purchases keep the price they were charged. Every change is audit logged.</p>
    </Modal>
  );
}

function QuotePreview() {
  const [quantity, setQuantity] = useState('7500');
  const n = Number(quantity);
  const debounced = useDebounce(Number.isInteger(n) && n > 0 ? n : null, 300);
  const q = useQuery({ queryKey: ['admin', 'pricing', 'quote', debounced], queryFn: () => adminService.pricingQuote(debounced!), enabled: debounced !== null, retry: false });
  return (
    <Card>
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Calculator className="h-4 w-4 text-slate-400" /> Price check</p>
      <p className="mt-1 text-xs text-slate-500">What a customer pays today for a given quantity.</p>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} className="w-40 tabular-nums" aria-label="Quantity" />
        {q.isError ? (
          <span className="text-sm text-amber-700">{errorMessage(q.error)}</span>
        ) : q.data ? (
          <span className="text-sm text-slate-600">
            Tier <span className="font-medium text-slate-900">{q.data.tier.label}</span> · {fmtMoney(q.data.unitPrice, q.data.currency)}/SMS · total{' '}
            <span className="text-base font-semibold text-slate-900">{fmtMoney(q.data.total, q.data.currency)}</span>
          </span>
        ) : null}
      </div>
    </Card>
  );
}

export function PricingTiersPage() {
  const { canAdmin } = usePermissions();
  const canManage = canAdmin('packages.manage');
  const q = useQuery({ queryKey: ['admin', 'pricing', 'tiers'], queryFn: adminService.pricingTiers });
  const [modal, setModal] = useState<{ open: boolean; tier: PricingTier | null }>({ open: false, tier: null });
  const [confirm, setConfirm] = useState<{ kind: 'delete' | 'deactivate'; tier: PricingTier } | null>(null);
  const toggle = useApiMutation((t: PricingTier) => adminService.updatePricingTier(t.id, { isActive: !t.isActive }), {
    success: (t) => (t.isActive ? 'Tier activated' : 'Tier deactivated'),
    invalidate: [['admin', 'pricing'], ['pricing']],
    onSuccess: () => setConfirm(null),
  });
  const remove = useApiMutation((t: PricingTier) => adminService.deletePricingTier(t.id), { success: 'Tier deleted', invalidate: [['admin', 'pricing'], ['pricing']], onSuccess: () => setConfirm(null) });
  const gaps = q.data ? coverageGaps(q.data) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="SMS pricing"
        description="Volume tiers for any-quantity purchases. The quantity a customer buys picks the tier, and that tier’s price applies to the whole purchase."
        actions={canManage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setModal({ open: true, tier: null })}>New tier</Button>}
      />
      {q.data && gaps.length > 0 && (
        <Alert tone="warning" title="Some quantities have no price">
          No active tier covers {gaps.join(', ')} SMS. Customers cannot buy these amounts until a tier covers them.
        </Alert>
      )}
      <QuotePreview />
      {q.isLoading ? (
        <Card padded={false}><TableSkeleton rows={4} /></Card>
      ) : q.error ? (
        <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>
      ) : (
        <Card padded={false}>
          <CardHeader title="Pricing tiers" description="Prices come only from here — never from the app or the customer." />
          <DataTable
            rows={q.data}
            columns={[
              { key: 'r', header: 'Quantity', cell: (t) => <span><span className="font-medium tabular-nums text-slate-900">{range(t)}</span>{t.name && <span className="block text-xs text-slate-500">{t.name}</span>}</span> },
              { key: 'min', header: 'Minimum', cell: (t) => <span className="tabular-nums">{fmtNumber(t.minQuantity)}</span> },
              { key: 'max', header: 'Maximum', cell: (t) => <span className="tabular-nums">{t.maxQuantity === null ? 'No limit' : fmtNumber(t.maxQuantity)}</span> },
              { key: 'p', header: 'Price / SMS', cell: (t) => <span className="font-semibold tabular-nums">{fmtMoney(t.unitPrice, t.currency)}</span> },
              { key: 'c', header: 'Currency', cell: (t) => t.currency },
              { key: 's', header: 'Status', cell: (t) => <StatusBadge status={t.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
              { key: 'o', header: 'Order', cell: (t) => <span className="tabular-nums text-slate-500">{t.sortOrder}</span> },
              { key: 'n', header: 'Purchases', cell: (t) => <span className="tabular-nums">{fmtNumber(t.purchaseCount ?? 0)}</span> },
              { key: 'u', header: 'Updated', cell: (t) => <span className="text-xs text-slate-500">{fmtDateTime(t.updatedAt)}</span> },
              {
                key: 'a',
                header: '',
                className: 'text-right',
                cell: (t) =>
                  canManage && (
                    <span className="flex justify-end gap-1">
                      <Button size="xs" variant="secondary" icon={<Pencil className="h-3 w-3" />} onClick={() => setModal({ open: true, tier: t })}>Edit</Button>
                      {t.isActive ? (
                        <Button size="xs" variant="ghost" icon={<Power className="h-3 w-3" />} onClick={() => setConfirm({ kind: 'deactivate', tier: t })}>Deactivate</Button>
                      ) : (
                        <Button size="xs" variant="ghost" icon={<Power className="h-3 w-3" />} loading={toggle.isPending && toggle.variables?.id === t.id} onClick={() => toggle.mutate(t)}>Activate</Button>
                      )}
                      {!t.purchaseCount && <Button size="xs" variant="ghost" className="text-red-600" icon={<Trash2 className="h-3 w-3" />} aria-label="Delete tier" onClick={() => setConfirm({ kind: 'delete', tier: t })} />}
                    </span>
                  ),
              },
            ]}
            empty={<EmptyState icon={<Layers />} title="No pricing tiers" description="Create tiers so customers can buy any quantity of SMS." />}
          />
        </Card>
      )}
      <TierModal open={modal.open} tier={modal.tier} onClose={() => setModal({ open: false, tier: null })} />
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'delete' ? `Delete tier ${confirm ? range(confirm.tier) : ''}?` : `Deactivate tier ${confirm ? range(confirm.tier) : ''}?`}
        description={confirm?.kind === 'delete' ? 'This tier was never used by a purchase, so it can be removed permanently.' : 'Customers will no longer be able to buy quantities in this range until another tier covers it. Past purchases are not affected.'}
        confirmLabel={confirm?.kind === 'delete' ? 'Delete' : 'Deactivate'}
        loading={toggle.isPending || remove.isPending}
        onConfirm={() => confirm && (confirm.kind === 'delete' ? remove.mutate(confirm.tier) : toggle.mutate(confirm.tier))}
      />
    </div>
  );
}

// ── Customer purchase & margin report ───────────────────────────────────

const REPORT_RANGES = [
  { value: 'today' as const, label: 'Today' },
  { value: 'month' as const, label: 'This month' },
  { value: 'lastMonth' as const, label: 'Last month' },
  { value: 'year' as const, label: 'This year' },
  { value: 'all' as const, label: 'All time' },
  { value: 'custom' as const, label: 'Custom' },
];

export function CustomerFinanceReportPage() {
  const r = useRange('month');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const q = useQuery({ queryKey: ['admin', 'finance', 'customers', r.params, debounced], queryFn: () => businessService.customerReport({ ...r.params, ...(debounced ? { search: debounced } : {}) }) });
  const rows = q.data?.customers ?? [];
  const sum = (f: (x: (typeof rows)[number]) => number) => rows.reduce((s, x) => s + f(x), 0);
  const money = (v: number) => fmtMoney(v.toFixed(2));
  return (
    <div className="space-y-6">
      <PageHeader title="Customer report" description="SMS bought and used per customer against the provider cost of the messages routed for them. All figures come from stored transactions." actions={<RangePicker {...r} options={REPORT_RANGES} />} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="SMS purchased" icon={<Coins />} loading={q.isLoading} value={fmtNumber(sum((x) => x.smsPurchased))} />
        <StatCard label="Revenue" icon={<Banknote />} tone="emerald" loading={q.isLoading} value={money(sum((x) => Number(x.revenue)))} />
        <StatCard label="Provider cost" icon={<Receipt />} tone="amber" loading={q.isLoading} value={money(sum((x) => Number(x.providerCost)))} hint={`${fmtNumber(sum((x) => x.smsUsed))} SMS used`} />
        {q.data?.canViewProfit && <StatCard label="Gross SMS margin" icon={<TrendingUp />} tone="violet" loading={q.isLoading} value={money(sum((x) => Number(x.grossMargin ?? 0)))} hint="Revenue − provider cost" />}
      </div>
      <Card padded={false}>
        <div className="border-b border-slate-100 p-4">
          <Input leading={<Search className="h-4 w-4" />} placeholder="Search customers" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        </div>
        <DataTable
          rows={rows.map((x) => ({ ...x, id: x.organization.id }))}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'o', header: 'Customer', cell: (x) => <Link to={`/admin/organizations/${x.organization.id}`} className="link">{x.organization.name}</Link> },
            { key: 'p', header: 'Purchased', className: 'text-right', headerClassName: 'text-right', cell: (x) => <span className="tabular-nums">{fmtNumber(x.smsPurchased)}</span> },
            { key: 'r', header: 'Revenue', className: 'text-right', headerClassName: 'text-right', cell: (x) => <span className="font-medium tabular-nums">{fmtMoney(x.revenue)}</span> },
            { key: 'u', header: 'Used', className: 'text-right', headerClassName: 'text-right', cell: (x) => <span className="tabular-nums">{fmtNumber(x.smsUsed)}</span> },
            { key: 'b', header: 'Balance', className: 'text-right', headerClassName: 'text-right', cell: (x) => <span className="tabular-nums text-slate-600">{fmtNumber(x.currentBalance)}</span> },
            {
              key: 'v',
              header: 'Provider usage',
              cell: (x) =>
                x.providerUsage.length ? (
                  <span className="flex flex-wrap gap-1">{x.providerUsage.map((p) => <Badge key={p.providerId ?? p.provider} color="gray">{p.provider} {fmtNumber(p.messages)}</Badge>)}</span>
                ) : (
                  <span className="text-slate-400">—</span>
                ),
            },
            { key: 'c', header: 'Provider cost', className: 'text-right', headerClassName: 'text-right', cell: (x) => <span className="tabular-nums text-slate-600">{fmtMoney(x.providerCost)}</span> },
            ...(q.data?.canViewProfit
              ? [{ key: 'm', header: 'Gross margin', className: 'text-right', headerClassName: 'text-right', cell: (x: (typeof rows)[number]) => <span className="font-semibold tabular-nums text-emerald-700">{fmtMoney(x.grossMargin)}</span> }]
              : []),
          ]}
          empty={<EmptyState icon={<Coins />} title="No customer activity" description="No purchases or messages in this period." />}
        />
      </Card>
    </div>
  );
}
