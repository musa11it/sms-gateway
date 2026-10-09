import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Banknote, Calculator, Coins, Layers, Receipt, Search, TrendingUp } from 'lucide-react';
import type { PricingTier } from '@/api/types';
import { errorMessage } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, TableSkeleton } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select } from '@/components/ui/Form';
import { ConfirmDialog, Drawer, Modal } from '@/components/ui/Overlay';
import { DataTable } from '@/components/ui/Table';
import { PageHeader } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { useDebounce } from '@/hooks/useDebounce';
import { adminService } from '@/services/adminService';
import { businessService, type PricingEconomics } from '@/services/businessService';
import { cn, fmtDateTime, fmtMoney, fmtNumber } from '@/utils/format';
import { RangePicker, useRange } from '../dashboard/ReportsPage';

// ── SMS pricing tiers ───────────────────────────────────────────────────

export const range = (t: Pick<PricingTier, 'minQuantity' | 'maxQuantity'>) =>
  t.maxQuantity === null ? `${fmtNumber(t.minQuantity)}+` : `${fmtNumber(t.minQuantity)} – ${fmtNumber(t.maxQuantity)}`;

/** Quantity ranges no active tier covers (customers cannot buy those amounts). */
export function coverageGaps(tiers: PricingTier[]): string[] {
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

/** datetime-local value for an ISO date (local time), or '' */
const toLocalInput = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

/** Is the tier priced today (inside its effective period)? */
export const effectiveNow = (t: PricingTier) => (!t.effectiveFrom || new Date(t.effectiveFrom) <= new Date()) && (!t.effectiveTo || new Date(t.effectiveTo) > new Date());

export function TierModal({ tier, open, onClose, networkId, listLabel }: { tier: PricingTier | null; open: boolean; onClose: () => void; networkId: string | null; listLabel: string }) {
  const empty = { name: '', minQuantity: '', maxQuantity: '', unitPrice: '', currency: 'RWF', sortOrder: '0', isActive: true, effectiveFrom: '', effectiveTo: '' };
  const [form, setForm] = useState(empty);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  if (open && loadedFor !== (tier?.id ?? null)) {
    setLoadedFor(tier?.id ?? null);
    setForm(
      tier
        ? {
            name: tier.name ?? '',
            minQuantity: String(tier.minQuantity),
            maxQuantity: tier.maxQuantity === null ? '' : String(tier.maxQuantity),
            unitPrice: tier.unitPrice,
            currency: tier.currency,
            sortOrder: String(tier.sortOrder),
            isActive: tier.isActive,
            effectiveFrom: toLocalInput(tier.effectiveFrom),
            effectiveTo: toLocalInput(tier.effectiveTo),
          }
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
    effectiveTo: form.effectiveFrom && form.effectiveTo && new Date(form.effectiveTo) <= new Date(form.effectiveFrom) ? 'Must be after the start' : undefined,
  };
  const valid = !!form.minQuantity && !!form.unitPrice && !Object.values(errors).some(Boolean);
  const body = {
    name: form.name.trim() || null,
    minQuantity: min,
    maxQuantity: max,
    unitPrice: form.unitPrice,
    currency: form.currency.toUpperCase(),
    sortOrder: Number(form.sortOrder) || 0,
    isActive: form.isActive,
    effectiveFrom: form.effectiveFrom ? new Date(form.effectiveFrom).toISOString() : null,
    effectiveTo: form.effectiveTo ? new Date(form.effectiveTo).toISOString() : null,
    ...(tier ? {} : { networkId }),
  };
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
      description={`Price list: ${listLabel}`}
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Minimum SMS" required error={errors.minQuantity}><Input type="number" min={1} value={form.minQuantity} onChange={set('minQuantity')} invalid={!!errors.minQuantity} /></Field>
        <Field label="Maximum SMS" error={errors.maxQuantity} hint="Leave empty for no upper limit"><Input type="number" min={1} value={form.maxQuantity} onChange={set('maxQuantity')} invalid={!!errors.maxQuantity} /></Field>
        <Field label="Price per SMS" required error={errors.unitPrice}><Input value={form.unitPrice} onChange={set('unitPrice')} placeholder="9" invalid={!!errors.unitPrice} /></Field>
        <Field label="Currency"><Input value={form.currency} onChange={set('currency')} maxLength={3} /></Field>
        <Field label="Label" hint="Optional, e.g. Business"><Input value={form.name} onChange={set('name')} /></Field>
        <Field label="Display order"><Input type="number" min={0} value={form.sortOrder} onChange={set('sortOrder')} /></Field>
        <Field label="Effective from" hint="Empty = immediately"><Input type="datetime-local" value={form.effectiveFrom} onChange={set('effectiveFrom')} /></Field>
        <Field label="Effective until" hint="Empty = no end" error={errors.effectiveTo}><Input type="datetime-local" value={form.effectiveTo} onChange={set('effectiveTo')} invalid={!!errors.effectiveTo} /></Field>
        <Checkbox className="sm:col-span-2" label="Active" description="Active tiers price customer purchases. Active ranges of one price list may not overlap in the same period." checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
      </div>
      <p className="mt-4 text-xs text-slate-500">
        The tier containing the purchased quantity sets the price of the whole purchase. To change a price on a date, end this tier then and add the new one starting at the same moment. Past purchases always keep the price they were charged. Every change is audit logged.
      </p>
    </Modal>
  );
}

export function QuotePreview() {
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

/** Pricing configuration of the selected price list: basis, rate application, limits, fee, notes, status. */
export function PriceListCard({ networkId, listLabel, canManage }: { networkId: string | null; listLabel: string; canManage: boolean; countryCode?: string | null }) {
  const q = useQuery({ queryKey: ['admin', 'pricing', 'list', networkId], queryFn: () => adminService.priceList(networkId) });
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const c = q.data;
  const save = useApiMutation((body: Record<string, unknown>) => adminService.savePriceList({ networkId, ...body }), { success: 'Saved', invalidate: [['admin', 'pricing'], ['pricing'], ['site']] });
  const limit = (v: string) => (v.trim() ? Number(v) : null);
  return (
    <Card padded={false}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between px-5 py-3 text-left">
        <span className="text-sm font-medium text-slate-700">Advanced</span>
        <span className="text-xs text-slate-500">
          {c ? `${c.rateApplication === 'GRADUATED' ? 'Graduated' : 'Whole purchase'} · ${c.pricingMetric === 'MONTHLY_PURCHASE_QUANTITY' ? 'monthly volume' : 'per purchase'}${c.isActive ? '' : ' · paused'}` : ''} {open ? '▴' : '▾'}
        </span>
      </button>
      {open && c && (
        <div className="grid gap-4 border-t border-slate-100 p-5 sm:grid-cols-2">
          <Field label="Price applies to">
            <Select value={c.rateApplication} disabled={!canManage} onChange={(e) => save.mutate({ rateApplication: e.target.value })}>
              <option value="WHOLE_PURCHASE">Whole purchase</option>
              <option value="GRADUATED">Each range separately</option>
            </Select>
          </Field>
          <Field label="Range is counted by">
            <Select value={c.pricingMetric} disabled={!canManage} onChange={(e) => save.mutate({ pricingMetric: e.target.value })}>
              <option value="PURCHASE_QUANTITY">This purchase</option>
              <option value="MONTHLY_PURCHASE_QUANTITY">This month’s purchases</option>
            </Select>
          </Field>
          <Field label="Minimum per purchase">
            <Input key={`min-${c.minPurchaseQuantity}`} inputMode="numeric" defaultValue={c.minPurchaseQuantity ?? ''} disabled={!canManage} placeholder="None" onBlur={(e) => limit(e.target.value) !== c.minPurchaseQuantity && save.mutate({ minPurchaseQuantity: limit(e.target.value) })} />
          </Field>
          <Field label="Maximum per purchase">
            <Input key={`max-${c.maxPurchaseQuantity}`} inputMode="numeric" defaultValue={c.maxPurchaseQuantity ?? ''} disabled={!canManage} placeholder="None" onBlur={(e) => limit(e.target.value) !== c.maxPurchaseQuantity && save.mutate({ maxPurchaseQuantity: limit(e.target.value) })} />
          </Field>
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <Checkbox label="On sale" checked={c.isActive} disabled={!canManage} onChange={(e) => save.mutate({ isActive: e.target.checked })} />
            <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>History</Button>
          </div>
        </div>
      )}
      <PricingHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} networkId={networkId ?? 'general'} listLabel={listLabel} />
    </Card>
  );
}


function PricingHistoryDrawer({ open, onClose, networkId, listLabel }: { open: boolean; onClose: () => void; networkId: string; listLabel: string }) {
  const q = useQuery({ queryKey: ['admin', 'pricing', 'history', networkId], queryFn: () => adminService.pricingHistory({ page: 1, limit: 50, networkId }), enabled: open });
  return (
    <Drawer open={open} onClose={onClose} title="Price change history" description={listLabel}>
      {q.isLoading ? (
        <TableSkeleton rows={4} />
      ) : !q.data?.data.length ? (
        <EmptyState title="No changes recorded" className="py-8" />
      ) : (
        <ul className="space-y-3">
          {q.data.data.map((h) => (
            <li key={h.id} className="rounded-lg p-3 text-sm ring-1 ring-slate-200">
              <p className="font-medium text-slate-900">{h.action.replace(/_/g, ' ').toLowerCase()}</p>
              <p className="text-xs text-slate-500">{fmtDateTime(h.createdAt)} · {h.actor?.fullName ?? h.actorEmail ?? 'System'}</p>
              {(h.metadata as { reason?: string } | null)?.reason && <p className="mt-1 text-xs text-slate-600">Reason: {(h.metadata as { reason: string }).reason}</p>}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

const AVAILABILITY_COLOR: Record<string, 'green' | 'amber' | 'gray' | 'red'> = { AVAILABLE: 'green', OUT_OF_STOCK: 'amber', MAINTENANCE: 'amber', NO_ROUTE: 'red', NO_PRICE: 'gray', OUTBOUND_UNAVAILABLE: 'gray' };

/** Every destination network as customers see it right now. */
export function NetworkAvailabilityCard({ onPick }: { onPick: (networkId: string) => void }) {
  const q = useQuery({ queryKey: ['admin', 'pricing', 'networks'], queryFn: adminService.pricingNetworks });
  return (
    <Card padded={false}>
      <CardHeader title="Destination networks" description="What customers can buy right now, decided by each network’s price list and the routing engine (eligible, healthy providers with usable capacity)." />
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        error={q.error}
        columns={[
          { key: 'n', header: 'Network', cell: (n) => <span><span className="font-medium">{n.name}</span><span className="block font-mono text-xs text-slate-400">{n.code}</span></span> },
          { key: 'c', header: 'Country', cell: (n) => `${n.countryName} (${n.countryCode})` },
          { key: 'a', header: 'Customer availability', cell: (n) => <span className="flex flex-col gap-0.5"><Badge color={AVAILABILITY_COLOR[n.availability] ?? 'gray'} dot>{n.availability.replace(/_/g, ' ').toLowerCase()}</Badge>{!n.available && <span className="text-xs text-slate-500">{n.availabilityText}</span>}</span> },
          { key: 'p', header: 'Selling price', cell: (n) => (n.fromPrice ? <span className="tabular-nums">{n.tiers.length > 1 ? 'from ' : ''}{fmtMoney(n.fromPrice, n.currency ?? undefined)}</span> : <span className="text-slate-400">—</span>) },
          { key: 's', header: 'Sender IDs', cell: (n) => (n.requiresSenderRegistration ? <Badge color="gray">Registration required</Badge> : <span className="text-xs text-slate-500">Any approved</span>) },
          { key: 'k', header: 'Usable provider capacity', cell: (n) => (n.usableProviderCapacity === null ? <span className="text-slate-400">—</span> : <span className="tabular-nums">{fmtNumber(n.usableProviderCapacity)}</span>) },
          { key: 'x', header: '', className: 'text-right', cell: (n) => <Button size="xs" variant="secondary" onClick={() => onPick(n.id)}>Prices</Button> },
        ]}
        empty={<EmptyState icon={<Layers />} title="No destination networks" description="Add countries and networks under Routing first." />}
      />
    </Card>
  );
}

/** Provider stock, historical cost and consumption per destination network. */
export function InventoryByDestination() {
  const q = useQuery({ queryKey: ['admin', 'pricing', 'inventory'], queryFn: adminService.networkInventory });
  if (q.isLoading) return <Card padded={false}><TableSkeleton rows={3} /></Card>;
  if (q.error) return <Card><ErrorState error={q.error} /></Card>;
  return (
    <Card padded={false}>
      <CardHeader
        title="Provider inventory by destination"
        description="Only providers that explicitly serve a network (or its whole country) count as stock for it. Capacity is shared by every destination a provider serves; consumption is for the last 30 days at the costs frozen on each message."
      />
      <div className="divide-y divide-slate-100">
        {q.data!.networks.map((n) => (
          <div key={n.networkId} className="px-5 py-4">
            <p className="text-sm font-semibold text-slate-900">{n.name} <span className="font-mono text-xs font-normal text-slate-400">{n.code}</span> {n.status === 'MAINTENANCE' && <Badge color="amber">Maintenance</Badge>}</p>
            {n.providers.length ? (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[640px] text-xs">
                  <thead className="text-left text-slate-500">
                    <tr><th className="py-1 font-medium">Provider</th><th className="font-medium">Capability</th><th className="text-right font-medium">Capacity</th><th className="text-right font-medium">Avg. remaining cost</th><th className="text-right font-medium">Quoted cost</th><th className="text-right font-medium">Used (30d)</th><th className="text-right font-medium">Cost of used</th></tr>
                  </thead>
                  <tbody>
                    {n.providers.map((p) => (
                      <tr key={p.providerId} className="border-t border-slate-100">
                        <td className="py-1.5">{p.name} <span className="text-slate-400">· {p.status.toLowerCase()}{p.health !== 'HEALTHY' ? `, ${p.health.toLowerCase()}` : ''}</span></td>
                        <td>{p.capability === 'NETWORK' ? 'This network' : 'Whole country'}</td>
                        <td className="text-right tabular-nums">{fmtNumber(p.capacityBalance)}</td>
                        <td className="text-right tabular-nums">{p.averageRemainingCost ?? '—'}</td>
                        <td className="text-right tabular-nums">{p.currentQuotedCost ?? '—'}</td>
                        <td className="text-right tabular-nums">{fmtNumber(p.consumed.credits)}</td>
                        <td className="text-right tabular-nums">{p.consumed.providerCost ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-1 text-xs text-red-600">No provider serves this network — it cannot be bought or sent to.</p>
            )}
          </div>
        ))}
      </div>
    </Card>
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
  // Money totals in whole cents, so the totals reconcile exactly (revenue − cost = gross profit).
  const cents = (f: (x: (typeof rows)[number]) => string | null) => sum((x) => Math.round(Number(f(x) ?? 0) * 100));
  const money = (c: number) => fmtMoney((c / 100).toFixed(2));
  const revenueUsed = cents((x) => x.smsRevenue);
  const grossProfit = cents((x) => x.grossProfit);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Customer report"
        description="Credits each customer bought, the credits they used for SMS accepted by providers (valued at the price they were bought at), the provider cost of those SMS and the gross profit. Unused credits are not counted as SMS revenue and carry no provider cost."
        actions={<RangePicker {...r} options={REPORT_RANGES} />}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Credits sold" icon={<Coins />} loading={q.isLoading} value={fmtNumber(sum((x) => x.smsPurchased))} hint={`${money(cents((x) => x.revenue))} credit sales`} />
        <StatCard label="Customer revenue" icon={<Banknote />} tone="emerald" loading={q.isLoading} value={money(revenueUsed)} hint={`${fmtNumber(sum((x) => x.smsUsed))} credits used for SMS`} />
        <StatCard label="Provider cost" icon={<Receipt />} tone="amber" loading={q.isLoading} value={money(cents((x) => x.providerCost))} hint="Stock lot cost of those SMS" />
        {q.data?.canViewProfit && (
          <StatCard
            label="Gross profit"
            icon={<TrendingUp />}
            tone={grossProfit < 0 ? 'red' : 'violet'}
            loading={q.isLoading}
            value={money(grossProfit)}
            hint={revenueUsed > 0 ? `${((grossProfit / revenueUsed) * 100).toFixed(2)}% gross margin` : 'Customer revenue − provider cost'}
          />
        )}
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
            { key: 'p', header: 'Credits sold', className: 'text-right', headerClassName: 'text-right', cell: (x) => <span className="tabular-nums">{fmtNumber(x.smsPurchased)}<span className="block text-xs text-slate-500">{fmtMoney(x.revenue)}</span></span> },
            { key: 'u', header: 'Credits used', className: 'text-right', headerClassName: 'text-right', cell: (x) => <span className="tabular-nums">{fmtNumber(x.smsUsed)}</span> },
            { key: 'b', header: 'Credits remaining', className: 'text-right', headerClassName: 'text-right', cell: (x) => <span className="tabular-nums text-slate-600">{fmtNumber(x.currentBalance)}</span> },
            { key: 'r', header: 'Customer revenue', className: 'text-right', headerClassName: 'text-right', cell: (x) => <span className="font-medium tabular-nums">{fmtMoney(x.smsRevenue)}</span> },
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
              ? [
                  {
                    key: 'm',
                    header: 'Gross profit',
                    className: 'text-right',
                    headerClassName: 'text-right',
                    cell: (x: (typeof rows)[number]) => (
                      <span className={cn('font-semibold tabular-nums', Number(x.grossProfit) < 0 ? 'text-red-600' : 'text-emerald-700')}>
                        {fmtMoney(x.grossProfit)}
                        {x.grossMarginPercent != null && <span className="block text-xs font-normal">{x.grossMarginPercent}%</span>}
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
          empty={<EmptyState icon={<Coins />} title="No customer activity" description="No purchases or messages in this period." />}
        />
      </Card>
    </div>
  );
}

// ── Profit planner ──────────────────────────────────────────────────────

/** Price that leaves `margin`% after fees and cost: cost ÷ (1 − fee − margin), rounded up to the cent. */
function targetPrice(cost: number, feePercent: number, margin: number): number | null {
  const keep = 1 - feePercent / 100 - margin / 100;
  return keep > 0 ? Math.ceil((cost / keep) * 100) / 100 : null;
}

export function ProfitPlanner() {
  const q = useQuery({ queryKey: ['admin', 'pricing', 'economics'], queryFn: businessService.pricingEconomics });
  const [margins, setMargins] = useState<Record<string, string>>({});
  const [defaultMargin, setDefaultMargin] = useState('25');
  const [apply, setApply] = useState<{ tier: PricingEconomics['tiers'][number]; price: string } | null>(null);
  const save = useApiMutation(() => adminService.updatePricingTier(apply!.tier.tierId, { unitPrice: apply!.price }), {
    success: 'Price updated — new purchases use it, past purchases keep their price',
    invalidate: [['admin', 'pricing'], ['pricing']],
    onSuccess: () => setApply(null),
  });
  if (q.isLoading) return <Card padded={false}><TableSkeleton rows={4} /></Card>;
  if (q.error) return <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>;
  const d = q.data!;
  if (d.restricted || !d.inputs) return <Alert tone="info" title="Profit planning">Costs and margins are visible to staff with the profit.view permission.</Alert>;
  const i = d.inputs;
  const expected = i.expectedCostPerCredit ? Number(i.expectedCostPerCredit) : null;
  const marginFor = (id: string) => Number(margins[id] ?? defaultMargin);
  const tone = (pct: number | null) => (pct == null ? 'text-slate-400' : pct < 0 ? 'text-red-600' : pct < 10 ? 'text-amber-600' : 'text-emerald-700');

  return (
    <Card padded={false}>
      <CardHeader
        title={<span className="flex items-center gap-2"><TrendingUp className="h-4 w-4 text-emerald-600" /> Profit planner</span>}
        description="What each range really earns per credit after payment fees and provider cost — and the price that reaches your target margin."
      />
      <div className="grid gap-4 border-b border-slate-100 p-5 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ['Expected cost / credit', i.expectedCostPerCredit ? fmtMoney(i.expectedCostPerCredit) : '—', 'Average cost of the capacity you hold on usable providers'],
          ['Worst-case cost / credit', i.worstCaseCostPerCredit ? fmtMoney(i.worstCaseCostPerCredit) : '—', 'Your most expensive usable route (traffic can fall back to it)'],
          ['Actual cost / credit so far', i.realizedCostPerCredit ? fmtMoney(i.realizedCostPerCredit) : '—', 'From the lots consumed by messages already sent'],
          ['Payment fees', `${i.paymentFeePercent}%`, `From ${i.paymentFeeSource}`],
          ['Break-even price', i.breakEvenPrice ? fmtMoney(i.breakEvenPrice) : '—', 'Never price a range below this (worst-case cost + fees)'],
        ].map(([label, value, hint]) => (
          <div key={label} className="rounded-xl bg-slate-50 p-4 ring-1 ring-inset ring-slate-100">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</p>
            <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3 text-sm">
        <span className="text-slate-600">Target margin for every range</span>
        <Input type="number" min={0} max={90} value={defaultMargin} onChange={(e) => setDefaultMargin(e.target.value)} className="w-24 tabular-nums" aria-label="Default target margin percent" />
        <span className="text-slate-500">% — override per range below. Larger ranges usually take a smaller margin (volume discount) but must stay above break-even.</span>
      </div>
      <DataTable
        rows={d.tiers.map((t) => ({ ...t, id: t.tierId }))}
        columns={[
          {
            key: 'r',
            header: 'Range',
            cell: (t) => (
              <span>
                <span className={cn('font-medium tabular-nums', !t.isActive && 'text-slate-400')}>{t.maxQuantity === null ? `${fmtNumber(t.minQuantity)}+` : `${fmtNumber(t.minQuantity)} – ${fmtNumber(t.maxQuantity)}`}</span>
                {!t.isActive && <Badge color="gray" className="ml-2">inactive</Badge>}
                {t.warnings.map((w) => <span key={w} className="block text-xs font-medium text-red-600">{w}</span>)}
              </span>
            ),
          },
          { key: 'p', header: 'Price', className: 'text-right', headerClassName: 'text-right', cell: (t) => <span className="font-semibold tabular-nums">{fmtMoney(t.unitPrice)}</span> },
          { key: 'f', header: 'Fee', className: 'text-right', headerClassName: 'text-right', cell: (t) => <span className="tabular-nums text-slate-500">{fmtMoney(t.feePerCredit)}</span> },
          { key: 'c', header: 'Cost', className: 'text-right', headerClassName: 'text-right', cell: (t) => <span className="tabular-nums text-slate-500">{t.expectedCostPerCredit ? fmtMoney(t.expectedCostPerCredit) : '—'}</span> },
          {
            key: 'm',
            header: 'Margin / credit',
            className: 'text-right',
            headerClassName: 'text-right',
            cell: (t) => (
              <span className={cn('tabular-nums', tone(t.marginPercent))}>
                <span className="font-semibold">{t.marginPerCredit ? fmtMoney(t.marginPerCredit) : '—'}</span>
                {t.marginPercent != null && <span className="block text-xs">{t.marginPercent}% · worst {t.worstCaseMarginPercent}%</span>}
              </span>
            ),
          },
          {
            key: 's',
            header: 'Sold',
            className: 'text-right',
            headerClassName: 'text-right',
            cell: (t) => (
              <span className="tabular-nums">
                {fmtNumber(t.sales.credits)} credits
                <span className="block text-xs text-slate-500">{fmtMoney(t.sales.revenue)} · {t.sales.purchases} purchase{t.sales.purchases === 1 ? '' : 's'}</span>
              </span>
            ),
          },
          { key: 'pm', header: 'Projected margin', className: 'text-right', headerClassName: 'text-right', cell: (t) => <span className={cn('tabular-nums', t.sales.projectedMargin && Number(t.sales.projectedMargin) < 0 ? 'text-red-600' : 'text-slate-700')}>{t.sales.projectedMargin ? fmtMoney(t.sales.projectedMargin) : '—'}</span> },
          {
            key: 't',
            header: 'Target',
            cell: (t) => (
              <Input
                type="number"
                min={0}
                max={90}
                value={margins[t.tierId] ?? defaultMargin}
                onChange={(e) => setMargins((m) => ({ ...m, [t.tierId]: e.target.value }))}
                className="w-20 tabular-nums"
                aria-label={`Target margin for ${t.minQuantity}+`}
              />
            ),
          },
          {
            key: 'sp',
            header: 'Price for target',
            cell: (t) => {
              const price = expected != null ? targetPrice(expected, i.paymentFeePercent, marginFor(t.tierId)) : null;
              const floor = i.breakEvenPrice ? Number(i.breakEvenPrice) : 0;
              if (price == null) return <span className="text-slate-400">—</span>;
              const same = price.toFixed(2) === Number(t.unitPrice).toFixed(2);
              return (
                <span className="flex items-center gap-2">
                  <span className={cn('font-semibold tabular-nums', price < floor ? 'text-red-600' : 'text-slate-900')} title={price < floor ? 'Below break-even on the worst-case route' : undefined}>{fmtMoney(price.toFixed(2))}</span>
                  {!same && <Button size="xs" variant="secondary" onClick={() => setApply({ tier: t, price: price.toFixed(2) })}>Apply</Button>}
                </span>
              );
            },
          },
        ]}
        empty={<EmptyState icon={<Layers />} title="No ranges" />}
      />
      <div className="grid gap-2 border-t border-slate-100 p-5 text-xs text-slate-600 sm:grid-cols-2">
        <p><strong className="text-slate-800">Cost per credit</strong> = {d.formulas.costPerCredit}</p>
        <p><strong className="text-slate-800">Margin per credit</strong> = {d.formulas.marginPerCredit}</p>
        <p><strong className="text-slate-800">Break-even price</strong> = {d.formulas.breakEven}</p>
        <p><strong className="text-slate-800">Price for a target margin</strong> = {d.formulas.targetPrice}</p>
        <p className="sm:col-span-2 text-slate-500">Projected margin on sold credits uses the actual cost of messages sent so far (or the expected cost before any are sent): revenue − payment fees − credits × cost per credit.</p>
      </div>
      <ConfirmDialog
        open={!!apply}
        onClose={() => setApply(null)}
        tone="primary"
        title={apply ? `Set ${apply.tier.maxQuantity === null ? `${fmtNumber(apply.tier.minQuantity)}+` : `${fmtNumber(apply.tier.minQuantity)} – ${fmtNumber(apply.tier.maxQuantity)}`} to ${fmtMoney(apply.price)} per SMS?` : ''}
        description={apply ? `Currently ${fmtMoney(apply.tier.unitPrice)}. New purchases in this range will use the new price; past purchases keep the price they paid. The change is audit logged.` : ''}
        confirmLabel="Update price"
        loading={save.isPending}
        onConfirm={() => save.mutate(undefined)}
      />
    </Card>
  );
}
