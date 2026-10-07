import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Banknote,
  Boxes,
  ChevronRight,
  CircleDollarSign,
  FlaskConical,
  Gauge,
  Globe2,
  Layers,
  Pencil,
  Plus,
  Power,
  RadioTower,
  Route,
  ShoppingCart,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { Badge, StatusBadge, type BadgeColor } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, Skeleton, TableSkeleton } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Overlay';
import { DataTable } from '@/components/ui/Table';
import { PageHeader, ProgressBar, Tabs } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { adminService } from '@/services/adminService';
import { businessService, type CountryStatus, type Provider, type ProviderEconomics, type RouteStatus, type RouteSummary, type RoutingRule, type RoutingSimulation, type RoutingStrategy, type SmsCountry, type SmsNetwork } from '@/services/businessService';
import { cn, fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtRelative, titleCase } from '@/utils/format';
import { RangePicker, useRange } from '../dashboard/ReportsPage';
import { emptyIntegration, integrationFromProvider, integrationPayload, integrationValid, ProviderIntegrationSection, ProviderTestPanel, type IntegrationForm } from './ProviderIntegration';

// ── Shared bits ─────────────────────────────────────────────────────────

const RANGES = [
  { value: 'today' as const, label: 'Today' },
  { value: '7d' as const, label: '7 days' },
  { value: '30d' as const, label: '30 days' },
  { value: 'month' as const, label: 'This month' },
  { value: 'year' as const, label: 'This year' },
  { value: 'all' as const, label: 'All time' },
];

const HEALTH: Record<Provider['health'], { color: BadgeColor; label: string }> = {
  HEALTHY: { color: 'green', label: 'Healthy' },
  DEGRADED: { color: 'amber', label: 'Degraded' },
  DOWN: { color: 'red', label: 'Down' },
};

const STRATEGY: Record<RoutingStrategy, { label: string; hint: string }> = {
  LOWEST_COST: { label: 'Lowest cost', hint: 'Use the cheapest eligible provider' },
  PRIORITY: { label: 'Priority', hint: 'Use the highest-priority eligible provider' },
  PRIMARY_BACKUP: { label: 'Primary + backup', hint: 'Always try one provider first, then backups in order' },
};

const decimalRe = /^\d{1,8}(\.\d{1,4})?$/;
const usageTone = (pct: number): 'emerald' | 'amber' | 'red' => (pct >= 90 ? 'red' : pct >= 70 ? 'amber' : 'emerald');

function HealthBadge({ health }: { health: Provider['health'] }) {
  return <Badge color={HEALTH[health].color} dot>{HEALTH[health].label}</Badge>;
}

function Money({ value, currency = 'RWF' }: { value: string | null | undefined; currency?: string }) {
  return <>{value == null ? '—' : fmtMoney(value, currency)}</>;
}

/** Revenue − provider cost = margin, the way the business reads it. */
function MarginEquation({ e, loading }: { e?: ProviderEconomics; loading?: boolean }) {
  const cell = (label: string, value: React.ReactNode, tone: string, hint?: string) => (
    <div className="min-w-0 flex-1 rounded-xl bg-white/70 p-4 ring-1 ring-inset ring-slate-200/70">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      {loading ? <Skeleton className="mt-2 h-7 w-28" /> : <p className={cn('mt-1 text-2xl font-semibold tabular-nums', tone)}>{value}</p>}
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
  return (
    <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
      {cell('Customer revenue', <Money value={e?.revenue} />, 'text-slate-900', e ? `${fmtNumber(e.creditsUsed)} credits used, each at its purchase price${e.revenuePerCredit ? ` (avg ${fmtMoney(e.revenuePerCredit)})` : ''}` : undefined)}
      <span className="text-center text-xl font-light text-slate-400">−</span>
      {cell('Provider cost', <Money value={e?.providerCost} />, 'text-amber-700', e ? `${fmtNumber(e.segments)} segments, each at its stock lot cost` : undefined)}
      <span className="text-center text-xl font-light text-slate-400">=</span>
      {cell(
        'Gross profit',
        e?.grossMargin === null && e?.revenue !== null ? 'Restricted' : <Money value={e?.grossMargin} />,
        e?.grossMargin && Number(e.grossMargin) < 0 ? 'text-red-600' : 'text-emerald-700',
        e?.marginPercent != null ? `${e.marginPercent}% gross margin` : undefined,
      )}
    </div>
  );
}

// ── Provider form (create / edit) ───────────────────────────────────────

type ProviderForm = {
  code: string;
  name: string;
  type: 'MNO' | 'AGGREGATOR';
  status: Provider['status'];
  health: Provider['health'];
  healthNote: string;
  currency: string;
  costPerSms: string;
  priority: string;
  minimumCapacity: string;
  lowCapacityThreshold: string;
  supportsSenderId: boolean;
  countryIds: string[];
  networkIds: string[];
  notes: string;
  reason: string;
};

const emptyForm: ProviderForm = {
  code: '',
  name: '',
  type: 'MNO',
  status: 'INACTIVE',
  health: 'HEALTHY',
  healthNote: '',
  currency: 'RWF',
  costPerSms: '',
  priority: '100',
  minimumCapacity: '0',
  lowCapacityThreshold: '10000',
  supportsSenderId: true,
  countryIds: [],
  networkIds: [],
  notes: '',
  reason: '',
};

export function ProviderFormModal({ provider, open, onClose }: { provider: Provider | null; open: boolean; onClose: () => void }) {
  const networks = useQuery({ queryKey: ['admin', 'routing', 'networks'], queryFn: businessService.networks, enabled: open });
  const countries = useQuery({ queryKey: ['admin', 'routing', 'countries'], queryFn: businessService.countries, enabled: open });
  const [form, setForm] = useState<ProviderForm>(emptyForm);
  const [integration, setIntegration] = useState<IntegrationForm>(emptyIntegration);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  if (open && loadedFor !== (provider?.id ?? null)) {
    setLoadedFor(provider?.id ?? null);
    setIntegration(integrationFromProvider(provider));
    setForm(
      provider
        ? {
            code: provider.code,
            name: provider.name,
            type: provider.type,
            status: provider.status,
            health: provider.health,
            healthNote: provider.healthNote ?? '',
            currency: provider.currency,
            costPerSms: provider.costPerSms,
            priority: String(provider.priority),
            minimumCapacity: String(provider.minimumCapacity),
            lowCapacityThreshold: String(provider.lowCapacityThreshold),
            supportsSenderId: provider.supportsSenderId,
            countryIds: provider.countries.map((c) => c.id),
            networkIds: provider.networks.map((n) => n.id),
            notes: provider.notes ?? '',
            reason: '',
          }
        : emptyForm,
    );
  }
  const close = () => {
    setLoadedFor(undefined);
    onClose();
  };
  const body = {
    name: form.name.trim(),
    status: form.status,
    health: form.health,
    healthNote: form.healthNote.trim() || null,
    currency: form.currency.trim().toUpperCase(),
    costPerSms: form.costPerSms.trim(),
    priority: Number(form.priority),
    minimumCapacity: Number(form.minimumCapacity),
    lowCapacityThreshold: Number(form.lowCapacityThreshold),
    supportsSenderId: form.supportsSenderId,
    countryIds: form.countryIds,
    networkIds: form.networkIds,
    notes: form.notes.trim() || null,
    ...integrationPayload(integration),
    ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
  };
  const save = useApiMutation(
    () => (provider ? businessService.updateProvider(provider.id, body) : businessService.createProvider({ ...body, code: form.code.trim().toUpperCase(), type: form.type, mode: 'SIMULATION' })),
    { success: provider ? 'Provider updated' : 'Provider created', invalidate: [['admin', 'providers'], ['admin', 'provider'], ['admin', 'provider-overview']], onSuccess: close },
  );
  const set = (k: keyof ProviderForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const costError = form.costPerSms && !decimalRe.test(form.costPerSms.trim()) ? 'Amount such as 6 or 6.50' : undefined;
  const valid =
    form.name.trim().length >= 2 &&
    decimalRe.test(form.costPerSms.trim()) &&
    (provider || /^[A-Za-z][A-Za-z0-9_]{1,29}$/.test(form.code.trim())) &&
    [form.priority, form.minimumCapacity, form.lowCapacityThreshold].every((v) => Number.isInteger(Number(v)) && Number(v) >= 0) &&
    integrationValid(integration, provider);
  const costChanged = provider && form.costPerSms.trim() !== provider.costPerSms;

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={provider ? `Edit ${provider.name}` : 'New SMS provider'}
      description={provider ? 'Changes apply to routing immediately and are recorded in the audit log.' : 'A provider only receives traffic once it is active, healthy and connected (simulation works immediately).'}
      footer={
        <>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>{provider ? 'Save changes' : 'Create provider'}</Button>
        </>
      }
    >
      <div className="space-y-6">
        <section className="grid gap-4 sm:grid-cols-2">
          {!provider && (
            <>
              <Field label="Code" required hint="Stable identifier, e.g. MTN, AIRTEL"><Input value={form.code} onChange={set('code')} className="font-mono uppercase" /></Field>
              <Field label="Route type">
                <Select value={form.type} onChange={set('type')}><option value="MNO">Mobile network (direct)</option><option value="AGGREGATOR">Aggregator</option></Select>
              </Field>
            </>
          )}
          <Field label="Name" required><Input value={form.name} onChange={set('name')} /></Field>
          <Field label="Status">
            <Select value={form.status} onChange={set('status')}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="SUSPENDED">Suspended</option></Select>
          </Field>
        </section>

        <section>
          <h4 className="text-sm font-semibold text-slate-900">Cost & priority</h4>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Field label="Cost per segment" required error={costError} hint="Used for routing decisions and new purchases"><Input value={form.costPerSms} onChange={set('costPerSms')} placeholder="6.00" invalid={!!costError} /></Field>
            <Field label="Currency"><Input value={form.currency} onChange={set('currency')} maxLength={3} /></Field>
            <Field label="Priority" hint="Lower is preferred"><Input type="number" min={0} value={form.priority} onChange={set('priority')} /></Field>
          </div>
          {costChanged && <p className="mt-2 text-xs text-amber-700">Changing the cost affects routing from now on. Purchased lots and past messages keep their actual cost.</p>}
        </section>

        <section>
          <h4 className="text-sm font-semibold text-slate-900">Health & capacity protection</h4>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Field label="Health" hint="Down = never routed; degraded = used after healthy providers">
              <Select value={form.health} onChange={set('health')}><option value="HEALTHY">Healthy</option><option value="DEGRADED">Degraded</option><option value="DOWN">Down</option></Select>
            </Field>
            <Field label="Minimum capacity (reserve)" hint="Routing skips the provider below this"><Input type="number" min={0} value={form.minimumCapacity} onChange={set('minimumCapacity')} /></Field>
            <Field label="Low-capacity alert at"><Input type="number" min={0} value={form.lowCapacityThreshold} onChange={set('lowCapacityThreshold')} /></Field>
            <Field label="Health note" className="sm:col-span-3"><Input value={form.healthNote} onChange={set('healthNote')} placeholder="e.g. Delivery reports delayed since 10:00" /></Field>
          </div>
        </section>

        <section>
          <h4 className="text-sm font-semibold text-slate-900">Destinations it can deliver to</h4>
          <p className="mt-0.5 text-xs text-slate-500">Routing only uses a provider for destinations ticked here — nothing is assumed. A provider can serve any network you allow, not only its own.</p>
          <div className="mt-3 space-y-3">
            <div>
              <p className="label">Whole countries</p>
              <div className="grid gap-2 rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-100 sm:grid-cols-2">
                {countries.isLoading ? <Skeleton className="h-10" /> : !countries.data?.length ? (
                  <p className="text-xs text-slate-500">No destination countries yet. Add them under <Link to="/admin/routing" className="link">Routing</Link>.</p>
                ) : (
                  countries.data.map((c) => (
                    <Checkbox
                      key={c.id}
                      label={`${c.name} (+${c.callingCode ?? '?'})`}
                      description={`Every valid ${c.name} number, on any network${c.isActive ? '' : ' · country inactive'}`}
                      checked={form.countryIds.includes(c.id)}
                      onChange={(e) => setForm((f) => ({ ...f, countryIds: e.target.checked ? [...f.countryIds, c.id] : f.countryIds.filter((x) => x !== c.id) }))}
                    />
                  ))
                )}
              </div>
            </div>
            <div>
              <p className="label">Specific networks</p>
              <div className="grid gap-2 rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-100 sm:grid-cols-2">
                {networks.isLoading ? <Skeleton className="h-10" /> : !networks.data?.length ? (
                  <p className="text-xs text-slate-500">No destination networks yet. Add them under <Link to="/admin/routing" className="link">Routing</Link>.</p>
                ) : (
                  networks.data.map((n) => {
                    const viaCountry = countries.data?.some((c) => c.isoCode === n.countryCode && form.countryIds.includes(c.id));
                    return (
                      <Checkbox
                        key={n.id}
                        label={`${n.name}`}
                        description={viaCountry ? `Already covered by ${n.countryName}` : `${n.countryName} · ${n.prefixes.join(', ')}`}
                        checked={!!viaCountry || form.networkIds.includes(n.id)}
                        disabled={!!viaCountry}
                        onChange={(e) => setForm((f) => ({ ...f, networkIds: e.target.checked ? [...f.networkIds, n.id] : f.networkIds.filter((x) => x !== n.id) }))}
                      />
                    );
                  })
                )}
              </div>
            </div>
            <Checkbox label="Supports alphanumeric sender IDs" description="Providers without sender ID support are never used (every message has a sender ID)" checked={form.supportsSenderId} onChange={(e) => setForm((f) => ({ ...f, supportsSenderId: e.target.checked }))} />
          </div>
        </section>

        <ProviderIntegrationSection provider={provider} value={integration} onChange={setIntegration} />
        {provider && provider.adapterType === 'HTTP_JSON' && <ProviderTestPanel provider={provider} />}

        <section className="grid gap-4">
          <Field label="Notes"><Textarea rows={2} value={form.notes} onChange={set('notes')} placeholder="Contract, account manager, SLA…" /></Field>
          {provider && <Field label="Reason for the change" hint="Recorded in the audit log"><Input value={form.reason} onChange={set('reason')} placeholder="New contract rate from 1 Nov" /></Field>}
        </section>
        <p className="text-xs text-slate-500">API keys are stored encrypted and are never shown again after saving.</p>
      </div>
    </Modal>
  );
}

function PurchaseModal({ provider, onClose }: { provider: Provider | null; onClose: () => void }) {
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [notes, setNotes] = useState('');
  const [confirm, setConfirm] = useState(false);
  const qty = Number(quantity);
  const cost = unitCost.trim() || provider?.costPerSms || '0';
  const total = Number.isFinite(qty) && decimalRe.test(cost) ? (qty * Number(cost)).toFixed(2) : null;
  const close = () => {
    setQuantity('');
    setUnitCost('');
    setNotes('');
    setConfirm(false);
    onClose();
  };
  const buy = useApiMutation(() => businessService.purchaseCapacity(provider!.id, { quantity: qty, unitCost: unitCost.trim() || undefined, notes: notes.trim() || undefined }), {
    success: (p) => `Lot ${p.reference} added: ${fmtNumber(p.quantity)} segments`,
    invalidate: [['admin', 'providers'], ['admin', 'provider'], ['admin', 'provider-overview'], ['admin', 'provider-purchases'], ['admin', 'capacity']],
    onSuccess: close,
  });
  const valid = Number.isInteger(qty) && qty >= 100 && (!unitCost.trim() || decimalRe.test(unitCost.trim()));
  return (
    <>
      <Modal
        open={!!provider && !confirm}
        onClose={close}
        title={`Purchase capacity · ${provider?.name ?? ''}`}
        description="Creates a new capacity lot at its own unit cost. Existing lots keep their cost."
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!valid} onClick={() => setConfirm(true)}>Review purchase</Button></>}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Segments" required hint="Minimum 100"><Input type="number" min={100} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="100000" /></Field>
          <Field label="Cost per segment" hint={`Default: ${provider?.costPerSms ?? ''}`}><Input value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder={provider?.costPerSms} /></Field>
          <Field label="Reference / notes" className="sm:col-span-2"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="MTN-PO-2026-001" /></Field>
          <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-inset ring-slate-100 sm:col-span-2">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Total provider cost</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{total ? fmtMoney(total, provider?.currency) : '—'}</p>
          </div>
        </div>
      </Modal>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        tone="primary"
        title={`Buy ${fmtNumber(qty)} segments from ${provider?.name}?`}
        description={`${fmtNumber(qty)} × ${fmtMoney(cost, provider?.currency)} = ${total ? fmtMoney(total, provider?.currency) : '—'}. The order is placed with the provider and recorded as a new lot.`}
        confirmLabel="Place order"
        loading={buy.isPending}
        onConfirm={() => buy.mutate(undefined)}
      />
    </>
  );
}

function AdjustModal({ provider, onClose }: { provider: Provider | null; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const close = () => {
    setAmount('');
    setReason('');
    setReference('');
    setUnitCost('');
    onClose();
  };
  const n = Number(amount);
  const m = useApiMutation(() => businessService.adjustCapacity(provider!.id, { amount: n, reason: reason.trim(), reference: reference.trim(), unitCost: n > 0 && unitCost.trim() ? unitCost.trim() : undefined }), {
    success: 'Capacity adjusted',
    invalidate: [['admin', 'providers'], ['admin', 'provider'], ['admin', 'provider-overview'], ['admin', 'capacity']],
    onSuccess: close,
  });
  const valid = Number.isInteger(n) && n !== 0 && reason.trim().length >= 5 && /^[\w\-./#]{3,100}$/.test(reference.trim()) && (!unitCost.trim() || decimalRe.test(unitCost.trim()));
  return (
    <Modal
      open={!!provider}
      onClose={close}
      size="sm"
      title={`Adjust capacity · ${provider?.name ?? ''}`}
      description="Manual reconciliation against the provider's statement. Recorded in the capacity ledger and audit log."
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!valid} loading={m.isPending} onClick={() => m.mutate(undefined)}>Record adjustment</Button></>}
    >
      <div className="space-y-4">
        <Field label="Segments (+ add / − remove)" required hint={provider ? `Current capacity ${fmtNumber(provider.capacityBalance)}; it can never go below zero.` : undefined}><Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="-500" /></Field>
        {n > 0 && <Field label="Value per added segment" hint={`Default: current cost ${provider?.costPerSms}`}><Input value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder={provider?.costPerSms} /></Field>}
        <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reconciled with provider statement" /></Field>
        <Field label="Reference" required hint="Statement or ticket number; each can be used once."><Input value={reference} onChange={(e) => setReference(e.target.value)} className="font-mono" placeholder="STMT-2026-09" /></Field>
      </div>
    </Modal>
  );
}

// ── Providers overview ──────────────────────────────────────────────────

export function ProvidersPage() {
  const { canAdmin } = usePermissions();
  const navigate = useNavigate();
  const r = useRange('30d');
  const q = useQuery({ queryKey: ['admin', 'provider-overview', r.params], queryFn: () => businessService.providerOverview(r.params), refetchInterval: 30_000 });
  const [form, setForm] = useState<{ open: boolean; provider: Provider | null }>({ open: false, provider: null });
  const d = q.data;
  const totalPct = d && d.capacity.purchased ? (d.capacity.used / d.capacity.purchased) * 100 : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="SMS providers"
        description="Capacity, cost, health and routing of the networks and aggregators behind every customer message. Customers only ever buy generic credits."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <RangePicker {...r} options={RANGES} />
            <LinkButton to="/admin/routing" variant="secondary" size="sm" icon={<Route className="h-4 w-4" />}>Routing</LinkButton>
            {canAdmin('providers.manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true, provider: null })}>New provider</Button>}
          </div>
        }
      />
      {q.error ? (
        <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Providers" icon={<RadioTower />} loading={q.isLoading} value={`${d?.counts.active ?? 0} / ${d?.counts.providers ?? 0}`} hint={`active · ${d?.counts.routable ?? 0} routable now`} />
            <StatCard label="Remaining capacity" icon={<Boxes />} tone="emerald" loading={q.isLoading} value={fmtNumber(d?.capacity.remaining)} hint={d ? `of ${fmtNumber(d.capacity.purchased)} purchased · worth ${fmtMoney(d.capacity.remainingValue)}` : undefined} />
            <StatCard label="SMS segments used" icon={<Activity />} tone="violet" loading={q.isLoading} value={fmtNumber(d?.capacity.used)} hint={`${totalPct.toFixed(1)}% of all capacity purchased`} />
            <StatCard label="Average provider cost" icon={<CircleDollarSign />} tone="amber" loading={q.isLoading} value={d?.capacity.averageRemainingCost ? fmtMoney(d.capacity.averageRemainingCost) : '—'} hint="per segment, across remaining lots" />
          </div>

          <Card className="bg-gradient-to-br from-slate-50 to-white">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-sm font-semibold text-slate-900"><TrendingUp className="h-4 w-4 text-emerald-600" /> Provider profitability</p>
              <span className="text-xs text-slate-500">{d ? `${fmtDate(d.range.from)} – ${fmtDate(d.range.to)} · ${fmtNumber(d.economics.messages)} messages` : ''}</span>
            </div>
            <MarginEquation e={d?.economics} loading={q.isLoading} />
            <p className="mt-3 text-xs text-slate-500">
              Only SMS a provider accepted count (delivery failures stay charged; rejected or cancelled SMS are refunded and excluded). Gross profit excludes payment fees and operating costs.
              {d?.economics.pending?.messages ? ` ${fmtNumber(d.economics.pending.messages)} messages are still waiting for a provider (${fmtNumber(d.economics.pending.credits)} credits reserved).` : ''}
            </p>
          </Card>

          <Card padded={false}>
            <CardHeader title="Gross profit by provider" description="Customer credits used in the period, the provider that carried them, and what each provider earned or lost. Customers never see this split." />
            <DataTable
              rows={d?.byProvider.map((p) => ({ ...p, id: p.providerId }))}
              loading={q.isLoading}
              columns={[
                { key: 'n', header: 'Provider', cell: (p) => <Link to={`/admin/providers/${p.providerId}`} className="font-medium text-slate-900 hover:text-brand-700">{p.name}</Link> },
                {
                  key: 'c',
                  header: 'Credits',
                  cell: (p) => (
                    <span className="flex min-w-[10rem] items-center gap-2">
                      <span className="w-16 text-right font-semibold tabular-nums">{fmtNumber(p.credits)}</span>
                      <ProgressBar value={p.sharePercent} className="flex-1" />
                      <span className="w-12 text-right text-xs tabular-nums text-slate-500">{p.sharePercent}%</span>
                    </span>
                  ),
                },
                { key: 'm', header: 'Messages', className: 'text-right', headerClassName: 'text-right', cell: (p) => <span className="tabular-nums text-slate-600">{fmtNumber(p.messages)}</span> },
                { key: 'r', header: 'Customer revenue', className: 'text-right', headerClassName: 'text-right', cell: (p) => <span className="tabular-nums"><Money value={p.revenue} /></span> },
                { key: 'pc', header: 'Provider cost', className: 'text-right', headerClassName: 'text-right', cell: (p) => <span className="tabular-nums text-amber-700"><Money value={p.providerCost} />{p.costPerCredit && <span className="block text-[11px] text-slate-400">{fmtMoney(p.costPerCredit)} / credit</span>}</span> },
                {
                  key: 'g',
                  header: 'Gross profit',
                  className: 'text-right',
                  headerClassName: 'text-right',
                  cell: (p) => (
                    <span className={cn('font-semibold tabular-nums', p.grossMargin && Number(p.grossMargin) < 0 ? 'text-red-600' : 'text-emerald-700')}>
                      <Money value={p.grossMargin} />
                      {p.marginPercent != null && <span className="block text-[11px] font-normal">{p.marginPercent}%</span>}
                    </span>
                  ),
                },
              ]}
              empty={<EmptyState icon={<Activity />} title="No messages in this period" />}
            />
          </Card>

          <Card padded={false}>
            <CardHeader title="Providers" description="Click a provider for lots, cost history, routing rules and profitability." />
            {q.isLoading ? (
              <TableSkeleton rows={3} />
            ) : (
              <DataTable
                rows={d?.providers}
                onRowClick={(p) => navigate(`/admin/providers/${p.id}`)}
                columns={[
                  {
                    key: 'n',
                    header: 'Provider',
                    cell: (p) => (
                      <span className="flex items-center gap-3">
                        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-mono text-[11px] font-bold text-white', p.routable ? 'bg-gradient-to-br from-brand-600 to-violet-600' : 'bg-slate-400')}>{p.code.slice(0, 3)}</span>
                        <span className="min-w-0">
                          <span className="block font-medium text-slate-900">{p.name}</span>
                          <span className="block truncate text-xs text-slate-500">{[...p.countries.map((c) => c.name), ...p.networks.map((n) => n.name)].join(', ') || 'No destinations — never routed'}</span>
                        </span>
                      </span>
                    ),
                  },
                  { key: 's', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
                  { key: 'h', header: 'Health', cell: (p) => <span title={p.healthNote ?? undefined}><HealthBadge health={p.health} /></span> },
                  { key: 'p', header: 'Priority', className: 'text-right', headerClassName: 'text-right', cell: (p) => <span className="tabular-nums">{p.priority}</span> },
                  { key: 'c', header: 'Cost / segment', className: 'text-right', headerClassName: 'text-right', cell: (p) => <span className="font-medium tabular-nums">{fmtMoney(p.costPerSms, p.currency)}</span> },
                  { key: 'b', header: 'Purchased', className: 'text-right', headerClassName: 'text-right', cell: (p) => <span className="tabular-nums text-slate-600">{fmtNumber(p.totalPurchased)}</span> },
                  { key: 'u', header: 'Used', className: 'text-right', headerClassName: 'text-right', cell: (p) => <span className="tabular-nums text-slate-600">{fmtNumber(p.totalUsed)}</span> },
                  {
                    key: 'r',
                    header: 'Remaining',
                    className: 'text-right',
                    headerClassName: 'text-right',
                    cell: (p) => (
                      <span className={cn('font-semibold tabular-nums', p.capacityState === 'EMPTY' ? 'text-red-600' : p.capacityState === 'LOW' ? 'text-amber-600' : 'text-slate-900')}>
                        {fmtNumber(p.capacityBalance)}
                        {p.minimumCapacity > 0 && <span className="block text-[11px] font-normal text-slate-400">reserve {fmtNumber(p.minimumCapacity)}</span>}
                      </span>
                    ),
                  },
                  {
                    key: 'pct',
                    header: 'Usage',
                    cell: (p) => (
                      <span className="flex min-w-[7rem] items-center gap-2">
                        <ProgressBar value={p.usagePercent} tone={usageTone(p.usagePercent)} className="flex-1" />
                        <span className="w-11 text-right text-xs tabular-nums text-slate-600">{p.usagePercent}%</span>
                      </span>
                    ),
                  },
                  { key: 'go', header: '', cell: () => <ChevronRight className="h-4 w-4 text-slate-300" /> },
                ]}
                empty={<EmptyState icon={<RadioTower />} title="No providers yet" description="Add the networks and aggregators you buy SMS capacity from." />}
              />
            )}
          </Card>
        </>
      )}
      <ProviderFormModal open={form.open} provider={form.provider} onClose={() => setForm({ open: false, provider: null })} />
    </div>
  );
}

// ── Provider detail ─────────────────────────────────────────────────────

type DetailTab = 'overview' | 'lots' | 'cost' | 'rules' | 'usage' | 'profit' | 'activity';

export function ProviderDetailPage() {
  const { id } = useParams();
  const { canAdmin } = usePermissions();
  const qc = useQueryClient();
  const r = useRange('30d');
  const q = useQuery({ queryKey: ['admin', 'provider', id, r.params], queryFn: () => businessService.provider(id!, r.params), enabled: !!id });
  const [tab, setTab] = useState<DetailTab>('overview');
  const [editing, setEditing] = useState(false);
  const [purchase, setPurchase] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const [toggle, setToggle] = useState(false);
  const p = q.data;
  const toggleM = useApiMutation(() => businessService.updateProvider(p!.id, { status: p!.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }), {
    success: (x) => `Provider ${x.status === 'ACTIVE' ? 'activated' : 'deactivated'}`,
    invalidate: [['admin', 'provider'], ['admin', 'providers'], ['admin', 'provider-overview']],
    onSuccess: () => setToggle(false),
  });

  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-72 rounded-xl" /></div>;
  if (q.error || !p) return <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>;
  const canManage = canAdmin('providers.manage');
  const usable = Math.max(0, p.capacityBalance - p.minimumCapacity);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'SMS providers', to: '/admin/providers' }, { label: p.name }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {p.name}
            <StatusBadge status={p.status} />
            <HealthBadge health={p.health} />
            <Badge color={p.effectiveMode === 'SIMULATION' ? 'amber' : 'green'}>{titleCase(p.effectiveMode)}</Badge>
          </span>
        }
        description={`${p.type === 'MNO' ? 'Mobile network' : 'Aggregator'} · code ${p.code} · priority ${p.priority}${p.healthNote ? ` · ${p.healthNote}` : ''}`}
        actions={
          canManage || canAdmin('provider_purchases.create') ? (
            <div className="flex flex-wrap gap-2">
              {canAdmin('provider_purchases.create') && <Button size="sm" icon={<ShoppingCart className="h-4 w-4" />} disabled={p.status !== 'ACTIVE'} onClick={() => setPurchase(true)}>Purchase capacity</Button>}
              {canManage && <Button size="sm" variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>}
              {canManage && <Button size="sm" variant="secondary" icon={<SlidersHorizontal className="h-4 w-4" />} onClick={() => setAdjust(true)}>Adjust</Button>}
              {canManage && <Button size="sm" variant="ghost" icon={<Power className="h-4 w-4" />} onClick={() => setToggle(true)}>{p.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</Button>}
            </div>
          ) : undefined
        }
      />
      {!p.routable && (
        <Alert tone="warning" title="Not receiving traffic">
          {p.status !== 'ACTIVE' ? 'The provider is not active.' : p.health === 'DOWN' ? 'Health is set to Down.' : 'No integration adapter is installed for this provider and mode.'}
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Remaining" icon={<Boxes />} tone={p.capacityState === 'OK' ? 'emerald' : p.capacityState === 'LOW' ? 'amber' : 'red'} value={fmtNumber(p.capacityBalance)} hint={`${fmtNumber(usable)} usable above the reserve`} />
        <StatCard label="Used" icon={<Activity />} tone="violet" value={fmtNumber(p.totalUsed)} hint={`${p.usagePercent}% of ${fmtNumber(p.totalPurchased)} purchased`} />
        <StatCard label="Cost per segment" icon={<CircleDollarSign />} tone="amber" value={fmtMoney(p.costPerSms, p.currency)} hint={p.averageRemainingCost ? `remaining lots average ${fmtMoney(p.averageRemainingCost, p.currency)}` : 'no capacity left'} />
        <StatCard label="Remaining value" icon={<Banknote />} value={fmtMoney(p.remainingValue, p.currency)} hint={`${p.openLots} open lot${p.openLots === 1 ? '' : 's'}`} />
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <Tabs<DetailTab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'lots', label: 'Capacity & lots', count: p.lots.length },
            { value: 'cost', label: 'Cost history', count: p.costHistory.length },
            { value: 'rules', label: 'Routing rules', count: p.rules.length },
            { value: 'usage', label: 'Usage' },
            { value: 'profit', label: 'Profitability' },
            { value: 'activity', label: 'Recent activity' },
          ]}
        />
        {(tab === 'usage' || tab === 'profit') && <RangePicker {...r} options={RANGES} />}
      </div>

      {tab === 'overview' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card padded={false}>
            <CardHeader title="Capacity" />
            <div className="space-y-4 p-5">
              <div>
                <div className="mb-1.5 flex justify-between text-xs text-slate-500"><span>Used {fmtNumber(p.totalUsed)}</span><span>Remaining {fmtNumber(p.capacityBalance)}</span></div>
                <ProgressBar value={p.usagePercent} tone={usageTone(p.usagePercent)} className="h-2.5" />
              </div>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div><dt className="text-xs text-slate-500">Purchased</dt><dd className="font-medium tabular-nums">{fmtNumber(p.totalPurchased)}</dd></div>
                <div><dt className="text-xs text-slate-500">Total spent</dt><dd className="font-medium tabular-nums">{fmtMoney(p.totalSpent, p.currency)}</dd></div>
                <div><dt className="text-xs text-slate-500">Minimum capacity (reserve)</dt><dd className="font-medium tabular-nums">{fmtNumber(p.minimumCapacity)}</dd></div>
                <div><dt className="text-xs text-slate-500">Low-capacity alert</dt><dd className="font-medium tabular-nums">{fmtNumber(p.lowCapacityThreshold)}</dd></div>
                {p.reportedBalance && (
                  <div className="col-span-2 rounded-lg bg-slate-50 p-3 text-xs">
                    Provider-reported balance <strong className="tabular-nums">{fmtNumber(p.reportedBalance.available ?? 0)}</strong>
                    {p.reconciliationDifference ? <span className="text-amber-700"> · differs from our ledger by {fmtNumber(p.reconciliationDifference)}</span> : <span className="text-emerald-700"> · matches our ledger</span>}
                  </div>
                )}
              </dl>
            </div>
          </Card>
          <Card padded={false}>
            <CardHeader title="Routing capability" />
            <dl className="space-y-4 p-5 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Destinations</dt>
                <dd className="mt-1 flex flex-wrap gap-1.5">
                  {p.countries.length || p.networks.length ? (
                    <>
                      {p.countries.map((c) => <Badge key={c.id} color="violet"><Globe2 className="mr-1 inline h-3 w-3" />{c.name} (all numbers)</Badge>)}
                      {p.networks.map((n) => <Badge key={n.id} color="gray">{n.name}</Badge>)}
                    </>
                  ) : (
                    <span className="text-slate-400">None — this provider is never routed to</span>
                  )}
                </dd>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><dt className="text-xs text-slate-500">Sender IDs</dt><dd>{p.supportsSenderId ? <Badge color="green">Supported</Badge> : <Badge color="red">Not supported</Badge>}</dd></div>
                <div><dt className="text-xs text-slate-500">Integration</dt><dd>{p.adapterInstalled ? <Badge color="green">{p.adapterKey}</Badge> : <Badge color="red">No adapter</Badge>}</dd></div>
                <div><dt className="text-xs text-slate-500">Last transaction</dt><dd className="text-xs">{p.lastTransactionAt ? fmtRelative(p.lastTransactionAt) : '—'}</dd></div>
                <div><dt className="text-xs text-slate-500">Traffic (24 h)</dt><dd className="text-xs">{p.traffic24h.length ? p.traffic24h.map((t) => `${titleCase(t.status)} ${fmtNumber(t.count)}`).join(' · ') : 'None'}</dd></div>
              </div>
              {p.notes && <div><dt className="text-xs text-slate-500">Notes</dt><dd className="whitespace-pre-line text-slate-700">{p.notes}</dd></div>}
            </dl>
          </Card>
        </div>
      )}

      {tab === 'lots' && (
        <Card padded={false}>
          <CardHeader title="Capacity lots" description="Each purchase keeps its own cost. Messages consume the oldest lot first and record the cost actually used." />
          <DataTable
            rows={p.lots}
            columns={[
              { key: 'r', header: 'Lot', cell: (l) => <span><span className="block font-mono text-xs font-medium">{l.reference}</span><span className="text-[11px] text-slate-400">{titleCase(l.source)}{l.providerReference ? ` · ${l.providerReference}` : ''}</span></span> },
              { key: 'd', header: 'Date', cell: (l) => <span className="text-xs text-slate-500">{fmtDateTime(l.createdAt)}</span> },
              { key: 'q', header: 'Quantity', className: 'text-right', headerClassName: 'text-right', cell: (l) => <span className="tabular-nums">{fmtNumber(l.quantity)}</span> },
              { key: 'c', header: 'Cost / segment', className: 'text-right', headerClassName: 'text-right', cell: (l) => <span className="tabular-nums">{fmtMoney(l.unitCost, p.currency)}</span> },
              { key: 't', header: 'Total cost', className: 'text-right', headerClassName: 'text-right', cell: (l) => <span className="font-medium tabular-nums">{fmtMoney(l.totalCost, p.currency)}</span> },
              {
                key: 'u',
                header: 'Used / remaining',
                cell: (l) => (
                  <span className="block min-w-[9rem]">
                    <span className="flex justify-between text-xs tabular-nums"><span>{fmtNumber(l.used)}</span><span className="font-medium">{fmtNumber(l.remaining)}</span></span>
                    <ProgressBar value={(l.used / l.quantity) * 100} tone={l.remaining === 0 ? 'red' : 'emerald'} className="mt-1" />
                  </span>
                ),
              },
              {
                key: 'cc',
                header: 'Consumed cost',
                className: 'text-right',
                headerClassName: 'text-right',
                cell: (l) => (
                  <span className="tabular-nums text-amber-700" title="Segments used by SMS (net of returned capacity), at this lot's own unit cost">
                    {fmtMoney(l.consumedCost, p.currency)}
                    <span className="block text-[11px] text-slate-500">{fmtNumber(l.consumed)} by SMS{l.writtenOff ? ` · ${fmtNumber(l.writtenOff)} written off` : ''}</span>
                  </span>
                ),
              },
              { key: 'v', header: 'Remaining value', className: 'text-right', headerClassName: 'text-right', cell: (l) => <span className="tabular-nums text-slate-600">{fmtMoney(l.remainingValue, p.currency)}</span> },
              { key: 's', header: 'Status', cell: (l) => (l.remaining === 0 ? <Badge color="gray">Consumed</Badge> : <StatusBadge status={l.status} />) },
            ]}
            empty={<EmptyState icon={<Layers />} title="No capacity lots" description="Purchase capacity to create the first lot." />}
          />
        </Card>
      )}

      {tab === 'cost' && (
        <Card padded={false}>
          <CardHeader title="Configured cost history" description="From the audit log. Purchased lots keep their own unit cost (see Capacity & lots)." />
          <DataTable
            rows={p.costHistory.map((c, i) => ({ ...c, id: String(i) }))}
            columns={[
              { key: 'd', header: 'Date', cell: (c) => fmtDateTime(c.at) },
              { key: 'f', header: 'Change', cell: (c) => <span className="tabular-nums">{c.from ? <>{fmtMoney(c.from, p.currency)} → </> : 'Initial '}<strong>{c.to ? fmtMoney(c.to, p.currency) : '—'}</strong></span> },
              { key: 'b', header: 'By', cell: (c) => <span className="text-xs text-slate-500">{c.by ?? 'System'}</span> },
              { key: 'r', header: 'Reason', cell: (c) => <span className="text-xs text-slate-600">{c.reason ?? '—'}</span> },
            ]}
            empty={<EmptyState icon={<CircleDollarSign />} title="No recorded cost changes" />}
          />
        </Card>
      )}

      {tab === 'rules' && (
        <Card padded={false}>
          <CardHeader title="Routing rules using this provider" action={<LinkButton to="/admin/routing" size="xs" variant="secondary">Manage rules</LinkButton>} />
          <DataTable
            rows={p.rules}
            columns={[
              { key: 'p', header: '#', cell: (x) => <span className="tabular-nums text-slate-500">{x.priority}</span> },
              { key: 'n', header: 'Rule', cell: (x) => <span className="font-medium">{x.name}</span> },
              { key: 'd', header: 'Destination', cell: (x) => x.destination },
              { key: 'r', header: 'Role', cell: (x) => <Badge color={x.role === 'primary' ? 'blue' : x.role.startsWith('backup') ? 'violet' : 'gray'}>{titleCase(x.role)}</Badge> },
              { key: 's', header: 'Strategy', cell: (x) => STRATEGY[x.strategy].label },
              { key: 'a', header: 'Status', cell: (x) => <StatusBadge status={x.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
            ]}
            empty={<EmptyState icon={<Route />} title="Not referenced by any rule" description="Without a rule the provider is used by default routing for the destinations it serves, by priority." />}
          />
        </Card>
      )}

      {tab === 'usage' && (
        <Card padded={false}>
          <CardHeader title="Segments used per day" description="Usage net of released capacity (rejected or cancelled messages)." />
          <div className="p-4">
            {p.usage.length ? (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={p.usage}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} width={48} />
                  <Tooltip formatter={(v: number) => [fmtNumber(v), 'Segments']} />
                  <Bar dataKey="segments" fill="#4f46e5" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState icon={<Gauge />} title="No usage in this period" />
            )}
          </div>
        </Card>
      )}

      {tab === 'profit' && (
        <Card>
          <p className="mb-4 text-sm text-slate-600">Messages routed through {p.name} in the period: revenue of the credits they used against the cost of the capacity lots consumed.</p>
          <MarginEquation e={p.economics} />
        </Card>
      )}

      {tab === 'activity' && (
        <Card padded={false}>
          <CardHeader title="Recent capacity movements" action={<LinkButton to="/admin/provider-wallets" size="xs" variant="secondary">Full ledger</LinkButton>} />
          <DataTable
            rows={p.recentActivity}
            columns={[
              { key: 'd', header: 'Date', cell: (e) => <span className="text-xs text-slate-500">{fmtDateTime(e.createdAt)}</span> },
              { key: 't', header: 'Type', cell: (e) => <Badge color={e.type === 'PURCHASE' ? 'green' : e.type === 'USAGE' ? 'gray' : e.type === 'RELEASE' ? 'blue' : 'amber'}>{titleCase(e.type)}</Badge> },
              { key: 'x', header: 'Description', cell: (e) => <span className="block max-w-xs truncate">{e.description}</span> },
              { key: 'a', header: 'Segments', className: 'text-right', headerClassName: 'text-right', cell: (e) => <span className={cn('font-semibold tabular-nums', e.amount > 0 && 'text-emerald-600')}>{e.amount > 0 ? '+' : ''}{fmtNumber(e.amount)}</span> },
              { key: 'b', header: 'Balance after', className: 'text-right', headerClassName: 'text-right', cell: (e) => <span className="tabular-nums text-slate-500">{fmtNumber(e.balanceAfter)}</span> },
            ]}
            empty={<EmptyState icon={<Activity />} title="No activity yet" />}
          />
        </Card>
      )}

      <ProviderFormModal open={editing} provider={p} onClose={() => { setEditing(false); void qc.invalidateQueries({ queryKey: ['admin', 'provider'] }); }} />
      <PurchaseModal provider={purchase ? p : null} onClose={() => setPurchase(false)} />
      <AdjustModal provider={adjust ? p : null} onClose={() => setAdjust(false)} />
      <ConfirmDialog
        open={toggle}
        onClose={() => setToggle(false)}
        tone={p.status === 'ACTIVE' ? 'danger' : 'primary'}
        title={p.status === 'ACTIVE' ? `Deactivate ${p.name}?` : `Activate ${p.name}?`}
        description={p.status === 'ACTIVE' ? 'Routing stops using this provider immediately; rules fall back to their backups.' : 'The provider becomes eligible for routing immediately.'}
        confirmLabel={p.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
        loading={toggleM.isPending}
        onConfirm={() => toggleM.mutate(undefined)}
      />
    </div>
  );
}

// ── Routing rules & networks ────────────────────────────────────────────

type RuleForm = {
  name: string;
  countryCode: string;
  networkId: string;
  strategy: RoutingStrategy;
  primaryProviderId: string;
  backupProviderIds: string[];
  allowedProviderIds: string[];
  minProviderCapacity: string;
  maxCostPerSegment: string;
  isActive: boolean;
  description: string;
  reason: string;
};

const emptyRule: RuleForm = { name: '', countryCode: '', networkId: '', strategy: 'LOWEST_COST', primaryProviderId: '', backupProviderIds: [], allowedProviderIds: [], minProviderCapacity: '0', maxCostPerSegment: '', isActive: true, description: '', reason: '' };

/** The providers a rule tries, in words — matches what the routing engine does for its strategy. */
function providersInOrder(r: Pick<RoutingRule, 'strategy' | 'primaryProvider' | 'backupProviders' | 'allowedProviders'>) {
  if (r.strategy === 'PRIMARY_BACKUP') return [r.primaryProvider, ...r.backupProviders].filter(Boolean).join(' → ');
  const pool = r.allowedProviders.length ? r.allowedProviders.join(', ') : 'All providers serving the destination';
  return `${pool} · ${r.strategy === 'LOWEST_COST' ? 'cheapest first' : 'highest priority first'}`;
}

function RuleModal({ rule, open, onClose, providers, networks }: { rule: RoutingRule | null; open: boolean; onClose: () => void; providers: Provider[]; networks: SmsNetwork[] }) {
  const [form, setForm] = useState<RuleForm>(emptyRule);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  if (open && loadedFor !== (rule?.id ?? null)) {
    setLoadedFor(rule?.id ?? null);
    setForm(
      rule
        ? {
            name: rule.name,
            countryCode: rule.countryCode ?? '',
            networkId: rule.networkId ?? '',
            strategy: rule.strategy,
            primaryProviderId: rule.primaryProviderId ?? '',
            backupProviderIds: rule.backupProviderIds,
            allowedProviderIds: rule.allowedProviderIds,
            minProviderCapacity: String(rule.minProviderCapacity),
            maxCostPerSegment: rule.maxCostPerSegment ?? '',
            isActive: rule.isActive,
            description: rule.description ?? '',
            reason: '',
          }
        : emptyRule,
    );
  }
  const close = () => {
    setLoadedFor(undefined);
    onClose();
  };
  const fixed = form.strategy === 'PRIMARY_BACKUP';
  const countries = [...new Map(networks.map((n) => [n.countryCode, n.countryName])).entries()];
  // Only the fields of the chosen strategy are sent; the server clears the others.
  const body = {
    name: form.name.trim(),
    countryCode: form.countryCode || null,
    networkId: form.networkId || null,
    strategy: form.strategy,
    primaryProviderId: fixed ? form.primaryProviderId || null : null,
    backupProviderIds: fixed ? form.backupProviderIds : [],
    allowedProviderIds: fixed ? [] : form.allowedProviderIds,
    minProviderCapacity: Number(form.minProviderCapacity) || 0,
    maxCostPerSegment: form.maxCostPerSegment.trim() || null,
    isActive: form.isActive,
    description: form.description.trim() || null,
    ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
  };
  const save = useApiMutation(() => (rule ? businessService.updateRoutingRule(rule.id, body) : businessService.createRoutingRule(body)), {
    success: rule ? 'Routing rule updated' : 'Routing rule created',
    invalidate: [['admin', 'routing'], ['admin', 'provider']],
    onSuccess: close,
  });
  const costError = form.maxCostPerSegment.trim() && !decimalRe.test(form.maxCostPerSegment.trim()) ? 'Amount such as 7 or 7.50' : undefined;
  const valid = form.name.trim().length >= 2 && !costError && Number.isInteger(Number(form.minProviderCapacity)) && Number(form.minProviderCapacity) >= 0 && (!fixed || !!form.primaryProviderId);
  const filteredNetworks = networks.filter((n) => !form.countryCode || n.countryCode === form.countryCode);
  const toggleIn = (k: 'backupProviderIds' | 'allowedProviderIds', id: string, on: boolean) => setForm((f) => ({ ...f, [k]: on ? [...f[k], id] : f[k].filter((x) => x !== id) }));
  const moveBackup = (i: number, d: -1 | 1) =>
    setForm((f) => {
      const b = [...f.backupProviderIds];
      const j = i + d;
      if (j < 0 || j >= b.length) return f;
      [b[i], b[j]] = [b[j], b[i]];
      return { ...f, backupProviderIds: b };
    });
  const name = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  const cost = (id: string) => providers.find((p) => p.id === id);

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={rule ? `Edit rule · ${rule.name}` : 'New routing rule'}
      description="Rules are checked top to bottom; the first active rule matching a message's destination decides its provider."
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>{rule ? 'Save rule' : 'Create rule'}</Button></>}
    >
      <div className="space-y-6">
        <section className="grid gap-4 sm:grid-cols-2">
          <Field label="Rule name" required className="sm:col-span-2"><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Rwanda — cheapest route" /></Field>
          <Field label="Destination country">
            <Select value={form.countryCode} onChange={(e) => setForm((f) => ({ ...f, countryCode: e.target.value, networkId: '' }))}>
              <option value="">Any country</option>
              {countries.map(([code, label]) => <option key={code} value={code}>{label} ({code})</option>)}
            </Select>
          </Field>
          <Field label="Destination network">
            <Select value={form.networkId} onChange={(e) => setForm((f) => ({ ...f, networkId: e.target.value }))}>
              <option value="">Any network{form.countryCode ? ` in ${form.countryCode}` : ''}</option>
              {filteredNetworks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </Select>
          </Field>
        </section>

        <section>
          <h4 className="text-sm font-semibold text-slate-900">How the provider is chosen</h4>
          <div className="mt-3 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Strategy">
            {(Object.keys(STRATEGY) as RoutingStrategy[]).map((st) => (
              <button
                key={st}
                type="button"
                role="radio"
                aria-checked={form.strategy === st}
                onClick={() => setForm((f) => ({ ...f, strategy: st }))}
                className={cn('rounded-xl border p-3 text-left transition', form.strategy === st ? 'border-brand-300 bg-brand-50/60 ring-1 ring-brand-300' : 'border-slate-200 hover:bg-slate-50')}
              >
                <span className="block text-sm font-semibold text-slate-900">{STRATEGY[st].label}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{STRATEGY[st].hint}</span>
              </button>
            ))}
          </div>

          {fixed ? (
            <div className="mt-4 space-y-3">
              <Field label="Primary provider" required hint="Always tried first">
                <Select value={form.primaryProviderId} onChange={(e) => setForm((f) => ({ ...f, primaryProviderId: e.target.value, backupProviderIds: f.backupProviderIds.filter((x) => x !== e.target.value) }))}>
                  <option value="">Choose…</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name} — {fmtMoney(p.costPerSms, p.currency)}/segment</option>)}
                </Select>
              </Field>
              <div>
                <p className="label">Backups, in the order they are tried</p>
                <div className="space-y-1.5 rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
                  {!form.backupProviderIds.length && <p className="text-xs text-slate-500">No backups: if the primary can't be used, the send is refused.</p>}
                  {form.backupProviderIds.map((id, i) => (
                    <div key={id} className="flex items-center justify-between gap-2 rounded-md bg-white px-2 py-1.5 text-sm ring-1 ring-slate-200">
                      <span><span className="mr-2 text-xs text-slate-400">#{i + 1}</span>{name(id)}{cost(id) && <span className="ml-2 text-xs text-slate-400">{fmtMoney(cost(id)!.costPerSms, cost(id)!.currency)}</span>}</span>
                      <span className="flex gap-0.5">
                        <button type="button" aria-label="Move up" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => moveBackup(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></button>
                        <button type="button" aria-label="Move down" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => moveBackup(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></button>
                        <button type="button" className="rounded px-1.5 text-xs text-red-600 hover:bg-red-50" onClick={() => toggleIn('backupProviderIds', id, false)}>Remove</button>
                      </span>
                    </div>
                  ))}
                  <Select value="" onChange={(e) => e.target.value && toggleIn('backupProviderIds', e.target.value, true)} aria-label="Add backup provider">
                    <option value="">+ Add backup…</option>
                    {providers.filter((p) => p.id !== form.primaryProviderId && !form.backupProviderIds.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <p className="label">Providers to choose from</p>
              <div className="grid gap-2 rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-100 sm:grid-cols-2">
                <p className="text-xs text-slate-500 sm:col-span-2">None selected = every provider that serves the destination. The {form.strategy === 'LOWEST_COST' ? 'cheapest' : 'highest-priority'} eligible one is used; the next one is the automatic backup.</p>
                {providers.map((p) => (
                  <Checkbox
                    key={p.id}
                    label={p.name}
                    description={`${fmtMoney(p.costPerSms, p.currency)}/segment · priority ${p.priority}`}
                    checked={form.allowedProviderIds.includes(p.id)}
                    onChange={(e) => toggleIn('allowedProviderIds', p.id, e.target.checked)}
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        <section>
          <h4 className="text-sm font-semibold text-slate-900">Guards</h4>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Maximum cost per segment" error={costError} hint="Providers above this are never used by this rule. Empty = no limit."><Input value={form.maxCostPerSegment} onChange={(e) => setForm((f) => ({ ...f, maxCostPerSegment: e.target.value }))} placeholder="7.00" invalid={!!costError} /></Field>
            <Field label="Minimum capacity to keep" hint="Skip a provider that would drop below this (in addition to its own reserve)"><Input type="number" min={0} value={form.minProviderCapacity} onChange={(e) => setForm((f) => ({ ...f, minProviderCapacity: e.target.value }))} /></Field>
          </div>
        </section>

        <section className="grid gap-4">
          <Checkbox label="Active" description="Inactive rules are ignored" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
          <Field label="Description"><Textarea rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></Field>
          {rule && <Field label="Reason for the change" hint="Recorded in the audit log"><Input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} /></Field>}
        </section>
      </div>
    </Modal>
  );
}

const COUNTRY_STATUS: Record<CountryStatus, { color: BadgeColor; label: string; hint: string }> = {
  CONFIGURED: { color: 'green', label: 'Configured', hint: 'Every valid number has at least one provider' },
  NETWORKS_ONLY: { color: 'blue', label: 'Networks only', hint: 'Numbers on configured networks are covered; other numbers in the country are refused' },
  PARTIAL: { color: 'amber', label: 'Partially configured', hint: 'Some networks have no provider' },
  NO_PROVIDER: { color: 'red', label: 'No provider', hint: 'No provider serves this country — every send is refused' },
  INACTIVE: { color: 'gray', label: 'Inactive', hint: 'Numbers in this country are refused' },
};

const ROUTE_STATUS: Record<RouteStatus, { color: BadgeColor; label: string }> = {
  CONFIGURED: { color: 'green', label: 'Configured' },
  UNSUPPORTED: { color: 'red', label: 'Unsupported' },
  NO_ELIGIBLE_PROVIDER: { color: 'amber', label: 'No eligible provider' },
  PROVIDER_UNAVAILABLE: { color: 'red', label: 'Provider unavailable' },
};

/** A few words for tables; the full routing explanation stays in the tooltip. */
function shortReason(reason: string) {
  const r = reason.toLowerCase();
  if (r.startsWith('no provider is configured')) return 'No provider configured';
  if (r.startsWith('no provider has enough')) return 'Not enough capacity';
  if (r.startsWith('no eligible provider')) return 'No eligible provider';
  if (r.startsWith('backup provider')) return 'Backup (primary down)';
  if (r.startsWith('primary provider')) return 'Primary';
  if (r.startsWith('only eligible')) return 'Only option';
  if (r.startsWith('lowest eligible cost')) return 'Lowest cost';
  if (r.startsWith('highest-priority')) return 'Highest priority';
  return reason.split(/ — |;| \(/)[0];
}

const parseLengths = (v: string) => v.split(/[\s,]+/).filter(Boolean).map(Number);
const lengthsValid = (v: string) => parseLengths(v).every((n) => Number.isInteger(n) && n >= 4 && n <= 15);

function ProviderPicker({ providers, value, onChange, hint }: { providers: Provider[]; value: string[]; onChange: (ids: string[]) => void; hint: string }) {
  return (
    <div>
      <p className="label">Providers that can deliver here</p>
      <div className="grid gap-2 rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-100 sm:grid-cols-2">
        <p className="text-xs text-slate-500 sm:col-span-2">{hint}</p>
        {providers.length ? (
          providers.map((p) => (
            <Checkbox
              key={p.id}
              label={p.name}
              description={`${fmtMoney(p.costPerSms, p.currency)}/segment · ${fmtNumber(p.capacityBalance)} capacity${p.status !== 'ACTIVE' ? ` · ${p.status.toLowerCase()}` : ''}`}
              checked={value.includes(p.id)}
              onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))}
            />
          ))
        ) : (
          <p className="text-xs text-slate-500">No providers yet.</p>
        )}
      </div>
    </div>
  );
}

function CountryModal({ country, open, onClose, providers }: { country: SmsCountry | null; open: boolean; onClose: () => void; providers: Provider[] }) {
  const empty = { isoCode: '', name: '', validationMode: 'STRICT' as 'STRICT' | 'LENGTH', lengths: '', isActive: true, providerIds: [] as string[] };
  const [form, setForm] = useState(empty);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  if (open && loadedFor !== (country?.id ?? null)) {
    setLoadedFor(country?.id ?? null);
    setForm(country ? { isoCode: country.isoCode, name: country.name, validationMode: country.validationMode, lengths: country.nationalNumberLengths.join(', '), isActive: country.isActive, providerIds: country.providers.map((p) => p.id) } : empty);
  }
  const close = () => {
    setLoadedFor(undefined);
    onClose();
  };
  const body = {
    ...(country ? {} : { isoCode: form.isoCode.trim().toUpperCase() }),
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    validationMode: form.validationMode,
    nationalNumberLengths: parseLengths(form.lengths),
    isActive: form.isActive,
    providerIds: form.providerIds,
  };
  const save = useApiMutation(() => (country ? businessService.updateCountry(country.id, body) : businessService.createCountry(body)), {
    success: country ? 'Country updated' : 'Country added',
    invalidate: [['admin', 'routing'], ['admin', 'providers']],
    onSuccess: close,
  });
  const valid = (country || /^[A-Za-z]{2}$/.test(form.isoCode.trim())) && lengthsValid(form.lengths);
  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={country ? `Edit ${country.name}` : 'Add destination country'}
      description="Numbers are only sent to configured, active countries — and only when a provider serves them."
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>{country ? 'Save country' : 'Add country'}</Button></>}
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="ISO country code" required hint={country ? `Calling code +${country.callingCode}` : 'Two letters, e.g. KE — the calling code is filled in automatically'}>
            <Input value={form.isoCode} onChange={(e) => setForm((f) => ({ ...f, isoCode: e.target.value }))} maxLength={2} disabled={!!country} className="font-mono uppercase" placeholder="KE" />
          </Field>
          <Field label="Name" hint="Empty = standard English name"><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Kenya" /></Field>
          <Field label="Number validation" hint={form.validationMode === 'STRICT' ? 'Number must be valid in the national numbering plan (recommended)' : 'Only the length is checked — use for new number ranges'}>
            <Select value={form.validationMode} onChange={(e) => setForm((f) => ({ ...f, validationMode: e.target.value as 'STRICT' | 'LENGTH' }))}>
              <option value="STRICT">Numbering plan (strict)</option>
              <option value="LENGTH">Possible length only</option>
            </Select>
          </Field>
          <Field label="Allowed number lengths" hint="Digits after the country code, e.g. 9. Empty = numbering plan only." error={lengthsValid(form.lengths) ? undefined : 'Whole numbers between 4 and 15'}>
            <Input value={form.lengths} onChange={(e) => setForm((f) => ({ ...f, lengths: e.target.value }))} placeholder="9" invalid={!lengthsValid(form.lengths)} />
          </Field>
        </div>
        <ProviderPicker providers={providers} value={form.providerIds} onChange={(providerIds) => setForm((f) => ({ ...f, providerIds }))} hint="These providers can deliver to every valid number in the country, on any network. For a single network, use the network instead." />
        <Checkbox label="Active" description="Inactive countries are refused before routing" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
      </div>
    </Modal>
  );
}

function NetworkModal({ network, open, onClose, countries, providers }: { network: SmsNetwork | null; open: boolean; onClose: () => void; countries: SmsCountry[]; providers: Provider[] }) {
  const empty = { code: '', name: '', countryCode: '', prefixes: '', lengths: '', isActive: true, providerIds: [] as string[] };
  const [form, setForm] = useState(empty);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  if (open && loadedFor !== (network?.id ?? null)) {
    setLoadedFor(network?.id ?? null);
    setForm(
      network
        ? { code: network.code, name: network.name, countryCode: network.countryCode, prefixes: network.prefixes.join(', '), lengths: network.nationalNumberLengths.join(', '), isActive: network.isActive, providerIds: network.providers.map((p) => p.id) }
        : { ...empty, countryCode: countries.find((c) => c.isActive)?.isoCode ?? '' },
    );
  }
  const close = () => {
    setLoadedFor(undefined);
    onClose();
  };
  const country = countries.find((c) => c.isoCode === form.countryCode);
  const cc = country?.callingCode ? `+${country.callingCode}` : '';
  const prefixes = form.prefixes.split(/[\s,]+/).filter(Boolean);
  const prefixError = !prefixes.length
    ? undefined
    : prefixes.find((p) => !/^\+\d{1,8}$/.test(p))
      ? 'Prefixes look like +25478'
      : cc && prefixes.find((p) => !p.startsWith(cc) || p === cc)
        ? `Each prefix must start with ${cc} and be longer than it`
        : undefined;
  const body = { code: form.code.trim().toUpperCase(), name: form.name.trim(), countryCode: form.countryCode, prefixes, nationalNumberLengths: parseLengths(form.lengths), isActive: form.isActive, providerIds: form.providerIds };
  const save = useApiMutation(() => (network ? businessService.updateNetwork(network.id, body) : businessService.createNetwork(body)), {
    success: network ? 'Network updated' : 'Network created',
    invalidate: [['admin', 'routing'], ['admin', 'providers']],
    onSuccess: close,
  });
  const valid = body.code.length >= 2 && body.name.length >= 2 && !!country && prefixes.length > 0 && !prefixError && lengthsValid(form.lengths);
  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={network ? `Edit ${network.name}` : 'New destination network'}
      description="Numbers are matched to a network by their longest prefix, after the full number is validated for its country."
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save network</Button></>}
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country" required hint={countries.length ? undefined : 'Add a destination country first'}>
            <Select value={form.countryCode} onChange={(e) => setForm((f) => ({ ...f, countryCode: e.target.value }))}>
              <option value="">Choose…</option>
              {countries.map((c) => <option key={c.id} value={c.isoCode} disabled={!c.isActive}>{c.name} (+{c.callingCode}){c.isActive ? '' : ' — inactive'}</option>)}
            </Select>
          </Field>
          <Field label="Network name" required><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Safaricom Kenya" /></Field>
          <Field label="Code" required hint="Stable identifier"><Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className="font-mono uppercase" placeholder="KE-SAF" /></Field>
          <Field label="Allowed number lengths" hint="Optional; overrides the country's rule" error={lengthsValid(form.lengths) ? undefined : 'Whole numbers between 4 and 15'}>
            <Input value={form.lengths} onChange={(e) => setForm((f) => ({ ...f, lengths: e.target.value }))} placeholder="9" invalid={!lengthsValid(form.lengths)} />
          </Field>
          <Field label="Number prefixes" required className="sm:col-span-2" error={prefixError} hint={`E.164, comma separated${cc ? `, starting with ${cc}` : ''}. At least one is required.`}>
            <Input value={form.prefixes} onChange={(e) => setForm((f) => ({ ...f, prefixes: e.target.value }))} className="font-mono" placeholder={cc ? `${cc}71, ${cc}72` : '+25471, +25472'} invalid={!!prefixError} />
          </Field>
        </div>
        <ProviderPicker providers={providers} value={form.providerIds} onChange={(providerIds) => setForm((f) => ({ ...f, providerIds }))} hint="Providers serving the whole country can always deliver here too." />
        <Checkbox label="Active" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
      </div>
    </Modal>
  );
}

/** "Who is used, why, and what if it is down" for one route. */
function RouteDecision({ s, compact }: { s: RouteSummary; compact?: boolean }) {
  if (!s.selected) return <span className="text-sm font-medium text-red-600">No eligible provider — sends refused</span>;
  return (
    <span className="block min-w-0">
      <span className="flex flex-wrap items-center gap-x-2">
        <span className="font-semibold text-slate-900">{s.selected.name}</span>
        <span className="text-xs tabular-nums text-slate-500">{fmtMoney(s.selected.costPerSegment)}/segment · {fmtNumber(s.selected.available)} usable</span>
      </span>
      {!compact && <span className="block text-xs text-slate-500">{s.reason}</span>}
      <span className="block text-xs text-slate-500">Backup: {s.backup ? `${s.backup.name} (${fmtMoney(s.backup.costPerSegment)})` : <span className="text-amber-700">none — sends refused if unavailable</span>}</span>
    </span>
  );
}

export function RoutingRulesPage() {
  const { canAdmin } = usePermissions();
  const canManage = canAdmin('providers.manage');
  const rules = useQuery({ queryKey: ['admin', 'routing', 'rules'], queryFn: businessService.routingRules });
  const overview = useQuery({ queryKey: ['admin', 'routing', 'overview'], queryFn: businessService.routingOverview });
  const networks = useQuery({ queryKey: ['admin', 'routing', 'networks'], queryFn: businessService.networks });
  const countries = useQuery({ queryKey: ['admin', 'routing', 'countries'], queryFn: businessService.countries });
  const providers = useQuery({ queryKey: ['admin', 'providers'], queryFn: businessService.providers });
  const [modal, setModal] = useState<{ open: boolean; rule: RoutingRule | null }>({ open: false, rule: null });
  const [countryModal, setCountryModal] = useState<{ open: boolean; country: SmsCountry | null }>({ open: false, country: null });
  const [toggleCountry, setToggleCountry] = useState<SmsCountry | null>(null);
  const [toggleNetwork, setToggleNetwork] = useState<SmsNetwork | null>(null);
  const [netSearch, setNetSearch] = useState('');
  const search = netSearch.trim().toLowerCase();
  const visibleNetworks = (networks.data ?? []).filter((n) => !search || [n.name, n.code, n.countryName, n.countryCode, ...n.prefixes].some((x) => x.toLowerCase().includes(search)));
  const toggleCountryM = useApiMutation((c: SmsCountry) => businessService.updateCountry(c.id, { isActive: !c.isActive }), {
    success: (c) => (c.isActive ? 'Country enabled' : 'Country disabled'),
    invalidate: [['admin', 'routing']],
    onSuccess: () => setToggleCountry(null),
  });
  const toggleNetworkM = useApiMutation((n: SmsNetwork) => businessService.updateNetwork(n.id, { isActive: !n.isActive }), {
    success: (n) => (n.isActive ? 'Network enabled' : 'Network disabled'),
    invalidate: [['admin', 'routing']],
    onSuccess: () => setToggleNetwork(null),
  });
  const [netModal, setNetModal] = useState<{ open: boolean; network: SmsNetwork | null }>({ open: false, network: null });
  const [order, setOrder] = useState<string[] | null>(null);
  const [confirmOrder, setConfirmOrder] = useState(false);
  const [toggle, setToggle] = useState<RoutingRule | null>(null);
  const [deleting, setDeleting] = useState<SmsNetwork | null>(null);
  const [deletingCountry, setDeletingCountry] = useState<SmsCountry | null>(null);
  const deleteCountryM = useApiMutation((c: SmsCountry) => businessService.deleteCountry(c.id), {
    success: 'Country deleted',
    invalidate: [['admin', 'routing'], ['admin', 'providers']],
    onSuccess: () => setDeletingCountry(null),
  });
  const deleteNet = useApiMutation((n: SmsNetwork) => businessService.deleteNetwork(n.id), {
    success: 'Network deleted',
    invalidate: [['admin', 'routing'], ['admin', 'providers']],
    onSuccess: () => setDeleting(null),
  });
  const toggleM = useApiMutation((r: RoutingRule) => businessService.updateRoutingRule(r.id, { isActive: !r.isActive }), {
    success: (r) => (r.isActive ? 'Rule activated' : 'Rule deactivated'),
    invalidate: [['admin', 'routing']],
    onSuccess: () => setToggle(null),
  });
  const saveOrder = useApiMutation(() => businessService.reorderRoutingRules(order!), { success: 'Rule order saved', invalidate: [['admin', 'routing']], onSuccess: () => { setOrder(null); setConfirmOrder(false); } });

  const list = rules.data ?? [];
  const ordered = order ? order.map((id) => list.find((r) => r.id === id)!).filter(Boolean) : list;
  const move = (i: number, d: -1 | 1) => {
    const ids = ordered.map((r) => r.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setOrder(ids);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Routing"
        description="Customers only buy credits — the platform picks the provider for every message. Here you decide how."
        breadcrumbs={[{ label: 'SMS providers', to: '/admin/providers' }, { label: 'Routing' }]}
        actions={
          <div className="flex gap-2">
            <LinkButton to="/admin/routing/simulator" variant="secondary" size="sm" icon={<FlaskConical className="h-4 w-4" />}>Simulator</LinkButton>
            {canManage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setModal({ open: true, rule: null })}>New rule</Button>}
          </div>
        }
      />

      <Card padded={false}>
        <CardHeader title="Where messages go right now" description="Configured destinations only. Each number is validated, matched to its country and network, then routed to an eligible provider — otherwise the send is refused and nothing is charged." />
        <DataTable
          rows={overview.data?.map((o) => ({ ...o, id: `${o.countryCode}:${o.networkId ?? 'other'}` }))}
          loading={overview.isLoading}
          error={overview.error}
          columns={[
            { key: 'd', header: 'Destination', cell: (o) => <span className="flex items-center gap-1.5 whitespace-nowrap font-medium text-slate-900"><Globe2 className="h-3.5 w-3.5 text-slate-400" />{o.destination}</span> },
            { key: 'p', header: 'Provider', cell: (o) => (o.selected ? <span className="font-semibold text-slate-900">{o.selected.name}</span> : <span className="text-slate-400">—</span>) },
            { key: 'c', header: 'Cost', className: 'text-right', headerClassName: 'text-right', cell: (o) => <span className="tabular-nums">{o.selected ? fmtMoney(o.selected.costPerSegment) : '—'}</span> },
            { key: 'u', header: 'Usable capacity', className: 'text-right', headerClassName: 'text-right', cell: (o) => <span className="tabular-nums">{o.selected ? fmtNumber(o.selected.available) : '—'}</span> },
            { key: 'why', header: 'Routing reason', cell: (o) => <span className="cursor-help whitespace-nowrap text-xs text-slate-600 underline decoration-slate-300 decoration-dotted underline-offset-2" title={[o.reason, ...o.rejected.map((r) => `${r.name}: ${r.reason}`)].join('\n')}>{shortReason(o.reason)}</span> },
            { key: 'r', header: 'Rule', cell: (o) => (o.rule ? <span className="text-sm">{o.rule.name}<span className="block text-xs text-slate-500">{STRATEGY[o.rule.strategy].label}</span></span> : <span className="text-xs text-slate-500">Default</span>) },
            { key: 'b', header: 'Backup', cell: (o) => (o.backup ? <span className="text-sm">{o.backup.name}<span className="block text-xs text-slate-500">{fmtMoney(o.backup.costPerSegment)}</span></span> : <span className="text-xs text-slate-400">None</span>) },
            {
              key: 's',
              header: 'Status',
              cell: (o) => {
                // A network row is managed as that network; a country row ("other numbers") as the whole country.
                const net = o.networkId ? networks.data?.find((n) => n.id === o.networkId) : undefined;
                const country = countries.data?.find((c) => c.isoCode === o.countryCode);
                const canDelete = !!(net || country);
                return (
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    <Badge color={ROUTE_STATUS[o.status].color} dot>{ROUTE_STATUS[o.status].label}</Badge>
                    {canManage && (net || country) && (
                      <>
                        <Button size="xs" variant="ghost" icon={<Pencil className="h-3 w-3" />} title={`Edit ${net ? net.name : country!.name}`} aria-label="Edit" onClick={() => (net ? setNetModal({ open: true, network: net }) : setCountryModal({ open: true, country: country! }))} />
                        {canDelete && <Button size="xs" variant="ghost" className="text-red-600" icon={<Trash2 className="h-3 w-3" />} title={`Delete ${net ? net.name : country!.name}`} aria-label="Delete" onClick={() => (net ? setDeleting(net) : setDeletingCountry(country!))} />}
                      </>
                    )}
                  </span>
                );
              },
            },
          ]}
          empty={<EmptyState icon={<Globe2 />} title="No destinations configured" description="Add a destination country below, then give at least one provider the capability to serve it." />}
        />
      </Card>

      <Card padded={false}>
        <CardHeader
          title="Rules"
          description="Checked top to bottom; the first active rule matching the destination is used. Destinations no rule matches use default routing."
          action={order && canManage && (
            <span className="flex gap-2">
              <Button size="xs" variant="secondary" onClick={() => setOrder(null)}>Discard</Button>
              <Button size="xs" onClick={() => setConfirmOrder(true)}>Save order</Button>
            </span>
          )}
        />
        {rules.isLoading ? (
          <TableSkeleton rows={3} />
        ) : rules.error ? (
          <ErrorState error={rules.error} />
        ) : (
          <DataTable
            rows={ordered}
            rowClassName={(r) => (!r.isActive ? 'opacity-60' : '')}
            columns={[
              {
                key: 'o',
                header: 'Order',
                cell: (r) => {
                  const i = ordered.indexOf(r);
                  return (
                    <span className="flex items-center gap-1">
                      <span className="w-5 tabular-nums font-medium text-slate-500">{i + 1}</span>
                      {canManage && (
                        <>
                          <button type="button" aria-label="Move up" disabled={i === 0} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" onClick={() => move(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></button>
                          <button type="button" aria-label="Move down" disabled={i === ordered.length - 1} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" onClick={() => move(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></button>
                        </>
                      )}
                    </span>
                  );
                },
              },
              {
                key: 'n',
                header: 'Rule',
                cell: (r) => (
                  <span className="block max-w-[14rem]">
                    <span className="font-medium text-slate-900">{r.name}</span>
                    {r.shadowedBy && <span className="block text-[11px] font-medium text-amber-700">Never reached — "{r.shadowedBy.name}" matches first</span>}
                    {r.description && <span className="block truncate text-xs text-slate-500">{r.description}</span>}
                  </span>
                ),
              },
              { key: 'd', header: 'Destination', cell: (r) => <span className="whitespace-nowrap">{r.destination}</span> },
              { key: 's', header: 'Strategy', cell: (r) => <Badge color={r.strategy === 'LOWEST_COST' ? 'green' : r.strategy === 'PRIORITY' ? 'blue' : 'violet'}>{STRATEGY[r.strategy].label}</Badge> },
              { key: 'p', header: 'Providers / order', cell: (r) => <span className="block max-w-[16rem] text-xs text-slate-700">{providersInOrder(r)}</span> },
              { key: 'c', header: 'Max cost', className: 'text-right', headerClassName: 'text-right', cell: (r) => <span className="tabular-nums">{r.maxCostPerSegment ? fmtMoney(r.maxCostPerSegment) : '—'}</span> },
              { key: 'm', header: 'Min capacity', className: 'text-right', headerClassName: 'text-right', cell: (r) => <span className="tabular-nums">{r.minProviderCapacity ? fmtNumber(r.minProviderCapacity) : '—'}</span> },
              { key: 'now', header: 'Uses now', cell: (r) => <span className="block max-w-[15rem]"><span className="text-[11px] text-slate-400">{r.preview.destination}</span><RouteDecision s={r.preview} compact /></span> },
              { key: 'a', header: 'Status', cell: (r) => <StatusBadge status={r.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
              {
                key: 'x',
                header: '',
                className: 'text-right',
                cell: (r) =>
                  canManage && (
                    <span className="flex justify-end gap-1">
                      <Button size="xs" variant="secondary" icon={<Pencil className="h-3 w-3" />} onClick={() => setModal({ open: true, rule: r })}>Edit</Button>
                      <Button size="xs" variant="ghost" icon={<Power className="h-3 w-3" />} onClick={() => setToggle(r)}>{r.isActive ? 'Deactivate' : 'Activate'}</Button>
                    </span>
                  ),
              },
            ]}
            empty={<EmptyState icon={<Route />} title="No routing rules" description="Default routing applies: providers serving the destination, highest priority first. Add a rule to pick the cheapest provider, fix a primary + backups, or cap the cost." />}
          />
        )}
      </Card>

      <Card padded={false}>
        <CardHeader
          title="Destination countries"
          description="A number is only sent if its country is configured here, active, and served by a provider."
          action={canManage && <Button size="xs" variant="secondary" icon={<Plus className="h-3 w-3" />} onClick={() => setCountryModal({ open: true, country: null })}>Add country</Button>}
        />
        <DataTable
          rows={countries.data}
          loading={countries.isLoading}
          error={countries.error}
          rowClassName={(c) => (!c.isActive ? 'opacity-60' : '')}
          columns={[
            { key: 'n', header: 'Country', cell: (c) => <span className="font-medium text-slate-900">{c.name}</span> },
            { key: 'i', header: 'ISO', cell: (c) => <span className="font-mono text-xs">{c.isoCode}</span> },
            { key: 'cc', header: 'Calling code', cell: (c) => <span className="font-mono text-xs">+{c.callingCode}</span> },
            { key: 'v', header: 'Number format', cell: (c) => <span className="text-xs text-slate-600">{c.validationMode === 'STRICT' ? 'Numbering plan' : 'Length only'}{c.nationalNumberLengths.length ? ` · ${c.nationalNumberLengths.join('/')} digits` : ''}</span> },
            { key: 'nw', header: 'Networks', className: 'text-right', headerClassName: 'text-right', cell: (c) => <span className="tabular-nums">{c.networkCount}</span> },
            { key: 'p', header: 'Whole-country providers', cell: (c) => (c.providers.length ? <span className="flex flex-wrap gap-1">{c.providers.map((p) => <Badge key={p.id} color="violet">{p.name}</Badge>)}</span> : <span className="text-xs text-slate-400">None</span>) },
            { key: 's', header: 'Status', cell: (c) => <span title={COUNTRY_STATUS[c.status].hint}><Badge color={COUNTRY_STATUS[c.status].color} dot>{COUNTRY_STATUS[c.status].label}</Badge></span> },
            {
              key: 'x',
              header: '',
              className: 'text-right',
              cell: (c) =>
                canManage && (
                  <span className="flex justify-end gap-1">
                    <Button size="xs" variant="secondary" icon={<Pencil className="h-3 w-3" />} onClick={() => setCountryModal({ open: true, country: c })}>Edit</Button>
                    <Button size="xs" variant="ghost" icon={<Power className="h-3 w-3" />} onClick={() => setToggleCountry(c)}>{c.isActive ? 'Disable' : 'Enable'}</Button>
                    <Button size="xs" variant="ghost" className="text-red-600" icon={<Trash2 className="h-3 w-3" />} onClick={() => setDeletingCountry(c)}>Delete</Button>
                  </span>
                ),
            },
          ]}
          empty={<EmptyState icon={<Globe2 />} title="No destination countries" description="Add the countries you send to. Numbers in other countries are refused before routing." />}
        />
      </Card>

      <Card padded={false}>
        <CardHeader
          title="Destination networks"
          description="Numbers are matched to a network by their longest E.164 prefix, after the full number is validated for its country."
          action={
            <span className="flex items-center gap-2">
              <Input value={netSearch} onChange={(e) => setNetSearch(e.target.value)} placeholder="Search networks" className="h-8 w-44 py-1 text-sm" aria-label="Search networks" />
              {canManage && <Button size="xs" variant="secondary" icon={<Plus className="h-3 w-3" />} disabled={!countries.data?.length} onClick={() => setNetModal({ open: true, network: null })}>Add network</Button>}
            </span>
          }
        />
        <DataTable
          rows={visibleNetworks}
          loading={networks.isLoading}
          error={networks.error}
          rowClassName={(n) => (!n.isActive ? 'opacity-60' : '')}
          columns={[
            { key: 'n', header: 'Network', cell: (n) => <span><span className="font-medium">{n.name}</span><span className="block font-mono text-[11px] text-slate-400">{n.code}</span></span> },
            { key: 'c', header: 'Country', cell: (n) => n.countryName },
            { key: 'i', header: 'ISO', cell: (n) => <span className="font-mono text-xs">{n.countryCode}</span> },
            { key: 'p', header: 'Prefixes', cell: (n) => <span className="font-mono text-xs">{n.prefixes.join(', ')}</span> },
            { key: 'f', header: 'Number format', cell: (n) => <span className="text-xs text-slate-600">{n.nationalNumberLengths.length ? `${n.nationalNumberLengths.join('/')} digits` : 'Country rules'}</span> },
            {
              key: 'v',
              header: 'Providers',
              cell: (n) => {
                const viaCountry = countries.data?.find((c) => c.isoCode === n.countryCode)?.providers ?? [];
                return n.providers.length || viaCountry.length ? (
                  <span className="flex flex-wrap gap-1">
                    {n.providers.map((p) => <Badge key={p.id} color="gray">{p.name}</Badge>)}
                    {viaCountry.filter((p) => !n.providers.some((x) => x.id === p.id)).map((p) => <Badge key={p.id} color="violet">{p.name} (country)</Badge>)}
                  </span>
                ) : (
                  <Badge color="red">No provider</Badge>
                );
              },
            },
            { key: 's', header: 'Status', cell: (n) => <StatusBadge status={n.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
            {
              key: 'x',
              header: '',
              className: 'text-right',
              cell: (n) =>
                canManage && (
                  <span className="flex justify-end gap-1">
                    <Button size="xs" variant="secondary" icon={<Pencil className="h-3 w-3" />} onClick={() => setNetModal({ open: true, network: n })}>Edit</Button>
                    <Button size="xs" variant="ghost" icon={<Power className="h-3 w-3" />} onClick={() => setToggleNetwork(n)}>{n.isActive ? 'Disable' : 'Enable'}</Button>
                    <Button size="xs" variant="ghost" className="text-red-600" icon={<Trash2 className="h-3 w-3" />} onClick={() => setDeleting(n)}>Delete</Button>
                  </span>
                ),
            },
          ]}
          empty={<EmptyState icon={<Globe2 />} title={netSearch ? 'No matching networks' : 'No networks'} description={netSearch ? 'Try another search.' : 'Networks are optional: they let you route specific operators differently. Without them, whole-country providers serve the country.'} />}
        />
      </Card>

      <RuleModal open={modal.open} rule={modal.rule} onClose={() => setModal({ open: false, rule: null })} providers={providers.data ?? []} networks={networks.data ?? []} />
      <NetworkModal open={netModal.open} network={netModal.network} onClose={() => setNetModal({ open: false, network: null })} countries={countries.data ?? []} providers={providers.data ?? []} />
      <CountryModal open={countryModal.open} country={countryModal.country} onClose={() => setCountryModal({ open: false, country: null })} providers={providers.data ?? []} />
      <ConfirmDialog
        open={!!toggleCountry}
        onClose={() => setToggleCountry(null)}
        tone={toggleCountry?.isActive ? 'danger' : 'primary'}
        title={toggleCountry?.isActive ? `Disable ${toggleCountry?.name}?` : `Enable ${toggleCountry?.name}?`}
        description={toggleCountry?.isActive ? `Every send to a ${toggleCountry?.name} number will be refused before routing (nothing charged), until it is enabled again.` : `Valid ${toggleCountry?.name} numbers become routable to the providers that serve them.`}
        confirmLabel={toggleCountry?.isActive ? 'Disable country' : 'Enable country'}
        loading={toggleCountryM.isPending}
        onConfirm={() => toggleCountry && toggleCountryM.mutate(toggleCountry)}
      />
      <ConfirmDialog
        open={!!toggleNetwork}
        onClose={() => setToggleNetwork(null)}
        tone={toggleNetwork?.isActive ? 'danger' : 'primary'}
        title={toggleNetwork?.isActive ? `Disable ${toggleNetwork?.name}?` : `Enable ${toggleNetwork?.name}?`}
        description={toggleNetwork?.isActive ? `Numbers on ${toggleNetwork?.prefixes.join(', ')} stop matching this network; only providers serving the whole country can still deliver to them. History is kept.` : 'Numbers on its prefixes are matched to this network again.'}
        confirmLabel={toggleNetwork?.isActive ? 'Disable network' : 'Enable network'}
        loading={toggleNetworkM.isPending}
        onConfirm={() => toggleNetwork && toggleNetworkM.mutate(toggleNetwork)}
      />
      <ConfirmDialog
        open={!!deletingCountry}
        onClose={() => setDeletingCountry(null)}
        title={`Delete ${deletingCountry?.name ?? 'country'}?`}
        description={
          <span className="block space-y-2">
            <span className="block">Numbers in {deletingCountry?.name} will be refused before routing (nothing is charged).{deletingCountry?.providers.length ? ` It is removed from the ${deletingCountry.providers.length} provider${deletingCountry.providers.length === 1 ? '' : 's'} that serve it.` : ''}</span>
            {!!deletingCountry?.networkCount && (
              <span className="block font-medium text-red-700">
                Its {deletingCountry.networkCount} network{deletingCountry.networkCount === 1 ? '' : 's'} ({networks.data?.filter((n) => n.countryCode === deletingCountry.isoCode).map((n) => n.name).join(', ')}) will be deleted too.
              </span>
            )}
            <span className="block text-xs text-slate-500">Not possible while a routing rule targets it or one of its networks, or once messages have been sent there — disable it instead in that case.</span>
          </span>
        }
        confirmLabel="Delete country"
        loading={deleteCountryM.isPending}
        onConfirm={() => deletingCountry && deleteCountryM.mutate(deletingCountry)}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'network'}?`}
        description={
          <span className="block space-y-2">
            <span className="block">
              Numbers starting with <span className="font-mono">{deleting?.prefixes.join(', ')}</span> will no longer match this network; only providers serving the whole country can still deliver to them.
              {deleting?.providerCount ? ` It is removed from the ${deleting.providerCount} provider${deleting.providerCount === 1 ? '' : 's'} that serve it.` : ''}
            </span>
            <span className="block text-xs text-slate-500">Not possible while a routing rule targets it, or once messages have been routed to it — deactivate it instead in that case.</span>
          </span>
        }
        confirmLabel="Delete network"
        loading={deleteNet.isPending}
        onConfirm={() => deleting && deleteNet.mutate(deleting)}
      />
      <ConfirmDialog
        open={!!toggle}
        onClose={() => setToggle(null)}
        tone={toggle?.isActive ? 'danger' : 'primary'}
        title={toggle?.isActive ? `Deactivate "${toggle?.name}"?` : `Activate "${toggle?.name}"?`}
        description={toggle?.isActive ? 'Messages it matched will use the next matching rule or default routing immediately.' : 'Matching messages will be routed by this rule immediately.'}
        confirmLabel={toggle?.isActive ? 'Deactivate' : 'Activate'}
        loading={toggleM.isPending}
        onConfirm={() => toggle && toggleM.mutate(toggle)}
      />
      <ConfirmDialog
        open={confirmOrder}
        onClose={() => setConfirmOrder(false)}
        tone="primary"
        title="Save the new rule order?"
        description={<span className="block space-y-0.5">{ordered.map((r, i) => <span key={r.id} className="block text-xs">{i + 1}. {r.name}</span>)}</span>}
        confirmLabel="Save order"
        loading={saveOrder.isPending}
        onConfirm={() => saveOrder.mutate(undefined)}
      />
    </div>
  );
}

// ── Routing simulator ───────────────────────────────────────────────────

const OUTCOME: Record<RoutingSimulation['outcome'], { tone: 'success' | 'danger' | 'warning'; title: string }> = {
  ROUTED: { tone: 'success', title: 'Would be sent' },
  REJECTED_BEFORE_ROUTING: { tone: 'danger', title: 'Rejected before routing' },
  NO_ELIGIBLE_PROVIDER: { tone: 'danger', title: 'No eligible provider' },
  NO_CAPACITY: { tone: 'danger', title: 'No provider has enough usable capacity' },
  INSUFFICIENT_CREDITS: { tone: 'warning', title: 'Insufficient credits' },
};

export function RoutingSimulatorPage() {
  const networks = useQuery({ queryKey: ['admin', 'routing', 'networks'], queryFn: businessService.networks });
  const countries = useQuery({ queryKey: ['admin', 'routing', 'countries'], queryFn: businessService.countries });
  const orgs = useQuery({ queryKey: ['admin', 'organizations', 'simulator'], queryFn: () => adminService.organizations({ page: 1, limit: 100 }) });
  const [form, setForm] = useState({ phone: '', countryCode: '', networkId: '', organizationId: '', senderName: '', recipients: '1', message: 'Hello! Your order has been confirmed. Thank you for choosing us.' });
  const byPhone = form.phone.trim().length > 0;
  const sim = useApiMutation(() =>
    businessService.simulateRouting({
      phone: byPhone ? form.phone.trim() : null,
      networkId: !byPhone && form.networkId ? form.networkId : null,
      countryCode: !byPhone && !form.networkId ? form.countryCode || null : null,
      organizationId: form.organizationId || null,
      senderName: form.senderName.trim() || null,
      recipients: Number(form.recipients),
      message: form.message,
    }),
  );
  const s = sim.data;
  const valid = Number.isInteger(Number(form.recipients)) && Number(form.recipients) >= 1 && form.message.length > 0 && (byPhone || !!form.countryCode || !!form.networkId);
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-3 last:border-0 sm:flex-row sm:gap-6">
      <dt className="w-44 shrink-0 text-sm text-slate-500">{label}</dt>
      <dd className="min-w-0 text-sm text-slate-900">{value}</dd>
    </div>
  );
  const destinationText = (d: NonNullable<RoutingSimulation['destination']>) => [d.countryName ?? d.countryCode, d.network?.name ?? 'other numbers'].filter(Boolean).join(' / ');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Routing simulator"
        description="See exactly how a send would be validated and routed right now, using the same engine as real sends. Nothing is sent and no credits or provider capacity are used."
        breadcrumbs={[{ label: 'SMS providers', to: '/admin/providers' }, { label: 'Routing', to: '/admin/routing' }, { label: 'Simulator' }]}
      />
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <Card className="h-fit space-y-4">
          <Field label="Destination number" hint="E.164, e.g. +250788123456 — validated exactly like a real send">
            <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className="font-mono" placeholder="+250788123456" />
          </Field>
          {!byPhone && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="…or country">
                <Select value={form.countryCode} onChange={(e) => setForm((f) => ({ ...f, countryCode: e.target.value, networkId: '' }))}>
                  <option value="">Choose…</option>
                  {(countries.data ?? []).map((c) => <option key={c.id} value={c.isoCode}>{c.name} ({c.isoCode})</option>)}
                </Select>
              </Field>
              <Field label="Network">
                <Select value={form.networkId} onChange={(e) => setForm((f) => ({ ...f, networkId: e.target.value }))}>
                  <option value="">Other numbers</option>
                  {(networks.data ?? []).filter((n) => n.countryCode === form.countryCode).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </Select>
              </Field>
            </div>
          )}
          <Field label="Customer" hint="Optional — checks their credit balance">
            <Select value={form.organizationId} onChange={(e) => setForm((f) => ({ ...f, organizationId: e.target.value }))}>
              <option value="">Don't check credits</option>
              {(orgs.data?.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sender ID"><Input value={form.senderName} onChange={(e) => setForm((f) => ({ ...f, senderName: e.target.value }))} maxLength={11} placeholder="Optional" /></Field>
            <Field label="Recipients"><Input type="number" min={1} value={form.recipients} onChange={(e) => setForm((f) => ({ ...f, recipients: e.target.value }))} /></Field>
          </div>
          <Field label="Message"><Textarea rows={4} value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} /></Field>
          <Button className="w-full" icon={<FlaskConical className="h-4 w-4" />} disabled={!valid} loading={sim.isPending} onClick={() => sim.mutate(undefined)}>Simulate routing</Button>
        </Card>

        {!s ? (
          <Card><EmptyState icon={<FlaskConical />} title="Run a simulation" description="Enter a number (or pick a destination) and a message to see whether it is valid, which provider would be used, why, and at what cost." /></Card>
        ) : (
          <div className="space-y-4">
            <Alert tone={OUTCOME[s.outcome].tone} title={OUTCOME[s.outcome].title}>{s.outcomeText}</Alert>
            <Card className={cn('ring-1', s.outcome === 'ROUTED' ? 'ring-emerald-200' : 'ring-red-200')}>
              <dl>
                {s.validation.checked &&
                  row(
                    'Validation',
                    s.validation.ok ? (
                      <span className="text-emerald-700">Valid <span className="font-mono text-slate-700">{s.validation.phone}</span></span>
                    ) : (
                      <span className="text-red-600">{s.validation.reason}</span>
                    ),
                  )}
                {row('Country', s.destination?.countryName ? `${s.destination.countryName} (${s.destination.countryCode})` : s.validation.country ? `${s.validation.country.name} (${s.validation.country.code})` : '—')}
                {row('Network', s.destination ? (s.destination.network ? s.destination.network.name : 'Other numbers (no specific network)') : '—')}
                {row('Required segments', <span className="tabular-nums">{fmtNumber(s.message.totalSegments)} <span className="text-slate-500">({fmtNumber(s.message.segmentsPerRecipient)} per recipient · {s.message.encoding === 'GSM7' ? 'GSM-7' : 'Unicode'} · {fmtNumber(s.message.characterCount)} characters)</span></span>)}
                {s.destination && (
                  <>
                    {row('Selected provider', s.selected ? <span className="text-base font-semibold">{s.selected.name} <span className="text-sm font-normal text-slate-500">· {fmtMoney(s.selected.costPerSegment)}/segment · {fmtNumber(s.selected.available)} usable</span></span> : <span className="font-semibold text-red-600">None — the send would be refused and nothing charged</span>)}
                    {row('Reason', s.reason)}
                    {row('Rule', s.rule ? `#${s.rule.priority} ${s.rule.name}` : 'Default routing (no rule matches)')}
                    {row('Strategy', s.strategy ? STRATEGY[s.strategy].label : '—')}
                    {row('Backup', s.backup ? `${s.backup.name} · ${fmtMoney(s.backup.costPerSegment)}/segment · ${fmtNumber(s.backup.available)} usable` : <span className="text-amber-700">None — if the selected provider becomes unavailable, sends are refused</span>)}
                  </>
                )}
                {s.customer && row('Customer credits', <span className={s.customer.sufficient ? '' : 'font-semibold text-red-600'}>{s.customer.name}: {fmtNumber(s.customer.balance)} available · {fmtNumber(s.customer.required)} required</span>)}
                {s.allocations.length > 1 && row('Capacity split', <ul className="space-y-0.5">{s.allocations.map((a) => <li key={a.providerId}>{a.name}: {fmtNumber(a.recipients)} recipients · {fmtNumber(a.segments)} segments · {fmtMoney(a.estimatedCost)}</li>)}</ul>)}
              </dl>
              {s.unroutedRecipients > 0 && s.selected && <Alert tone="danger" className="mt-3">Not enough eligible capacity for {fmtNumber(s.unroutedRecipients)} recipients — a real send would be refused and nothing charged.</Alert>}
              {s.sender && (!s.sender.known || !s.sender.approved) && <Alert tone="warning" className="mt-3">Sender ID "{s.sender.name}" {s.sender.known ? 'is not approved' : 'does not exist'}; a real send would be rejected before routing.</Alert>}
            </Card>

            {s.candidates.length > 0 && (
              <Card padded={false}>
                <CardHeader title="Providers considered" description={s.destination ? `For ${destinationText(s.destination)}` : undefined} />
                <DataTable
                  rows={s.candidates.map((c) => ({ ...c, id: c.providerId }))}
                  columns={[
                    { key: 'n', header: 'Provider', cell: (c) => <span className="font-medium">{c.name}{c.providerId === s.selected?.providerId && <Badge color="green" className="ml-2">Selected</Badge>}{c.providerId === s.backup?.providerId && <Badge color="blue" className="ml-2">Backup</Badge>}</span> },
                    { key: 'c', header: 'Cost', className: 'text-right', headerClassName: 'text-right', cell: (c) => <span className="tabular-nums">{fmtMoney(c.costPerSegment)}</span> },
                    { key: 'a', header: 'Usable capacity', className: 'text-right', headerClassName: 'text-right', cell: (c) => <span className="tabular-nums">{fmtNumber(c.available)}</span> },
                    { key: 'e', header: 'Eligible', cell: (c) => (c.eligible ? <Badge color="green">Eligible</Badge> : <Badge color="red">Rejected</Badge>) },
                    { key: 'r', header: 'Reason', cell: (c) => <span className="text-xs text-slate-600">{c.reasons.join('; ') || '—'}</span> },
                  ]}
                />
              </Card>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label="Customer revenue"
                icon={<Banknote />}
                value={s.estimate.revenue ? fmtMoney(s.estimate.revenue) : '—'}
                hint={s.estimate.revenuePerCredit ? `${fmtNumber(s.message.totalCredits)} credits × ${fmtMoney(s.estimate.revenuePerCredit)} (${s.estimate.priceSource === 'CUSTOMER_LOTS' ? "this customer's purchase price" : 'platform average price'})` : 'no sales history yet'}
              />
              <StatCard label="Provider cost" icon={<CircleDollarSign />} tone="amber" value={fmtMoney(s.estimate.providerCost)} hint="from the capacity lots that would be used" />
              <StatCard
                label="Expected gross profit"
                icon={<TrendingUp />}
                tone={s.estimate.grossMargin && Number(s.estimate.grossMargin) < 0 ? 'red' : 'emerald'}
                value={s.estimate.grossMargin ? fmtMoney(s.estimate.grossMargin) : '—'}
                hint={
                  s.estimate.grossMarginPercent != null
                    ? `${s.estimate.grossMarginPercent}% gross margin · ${Number(s.estimate.grossProfitPerSegment) < 0 ? `loss of ${fmtMoney(String(Math.abs(Number(s.estimate.grossProfitPerSegment))))}` : fmtMoney(s.estimate.grossProfitPerSegment ?? '0')} per segment`
                    : 'customer revenue − provider cost'
                }
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
