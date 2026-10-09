import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Globe2, Pencil, Plus, Power, Radio, Trash2, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { PageHeader, Tabs } from '@/components/ui/Misc';
import { useApiMutation } from '@/hooks/useApiMutation';
import { usePermissions } from '@/hooks/useAuth';
import { adminService } from '@/services/adminService';
import { businessService, type SmsCountry, type SmsNetwork } from '@/services/businessService';
import { Input } from '@/components/ui/Form';
import { cn, fmtMoney, fmtNumber } from '@/utils/format';
import { CountryModal, NetworkModal } from './ProviderManagementPages';
import { InventoryByDestination, NetworkAvailabilityCard, PriceListCard, ProfitPlanner, QuotePreview, effectiveNow } from './SmsCommercePages';

/**
 * One place to run SMS pricing: country → telecom network → the prices customers pay for it.
 * Every list, price and status comes from the backend; customers see exactly what is configured here
 * on the Pricing and Buy SMS pages (and can buy one network, another, or several at once).
 */

const flag = (iso: string) => String.fromCodePoint(...[...iso.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

const CUSTOMER_STATE: Record<string, { label: string; color: 'green' | 'amber' | 'red' | 'gray'; fix?: string }> = {
  AVAILABLE: { label: 'On sale', color: 'green' },
  NO_PRICE: { label: 'No price', color: 'gray', fix: 'Add a price below.' },
  NO_ROUTE: { label: 'No provider', color: 'red', fix: 'Edit telecom → choose a provider.' },
  OUT_OF_STOCK: { label: 'Out of stock', color: 'amber', fix: 'Buy provider capacity (Providers).' },
  MAINTENANCE: { label: 'Paused', color: 'amber', fix: 'End maintenance when ready.' },
  OUTBOUND_UNAVAILABLE: { label: 'Outgoing SMS off', color: 'gray', fix: 'Edit telecom → enable outbound SMS.' },
};

type Step = { key: string; min: string; price: string; name: string };
const newKey = () => Math.random().toString(36).slice(2);
const MONEY = /^\d{1,10}(\.\d{1,4})?$/;

/**
 * Price ladder of one price list: "from N SMS → price per SMS". Each row runs until the next row starts,
 * so there are no gaps or overlaps. Saved in one go; sold prices stay in history.
 */
function LadderEditor({ networkId, listLabel, canManage }: { networkId: string | null; listLabel: string; canManage: boolean }) {
  const all = useQuery({ queryKey: ['admin', 'pricing', 'tiers'], queryFn: adminService.pricingTiers });
  const current = (all.data ?? [])
    .filter((t) => t.isActive && (networkId ? t.networkId === networkId : !t.networkId) && (t.direction ?? 'OUTBOUND') === 'OUTBOUND' && effectiveNow(t))
    .sort((a, b) => a.minQuantity - b.minQuantity);
  const fromServer = (): Step[] => current.map((t) => ({ key: t.id, min: String(t.minQuantity), price: t.unitPrice, name: t.name ?? '' }));
  const [steps, setSteps] = useState<Step[] | null>(null);
  const rows = steps ?? fromServer();
  const dirty = steps !== null;
  const currency = current[0]?.currency ?? 'RWF';

  const save = useApiMutation(
    () => adminService.savePriceLadder({ networkId, steps: rows.map((r) => ({ minQuantity: Number(r.min), unitPrice: r.price.trim(), name: r.name.trim() || null })) }),
    { success: 'Prices saved', invalidate: [['admin', 'pricing'], ['pricing'], ['site']], onSuccess: () => setSteps(null) },
  );

  const set = (key: string, patch: Partial<Step>) => setSteps(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = () => {
    const last = rows[rows.length - 1];
    const min = last ? Math.max(Number(last.min) || 1, 1) * (Number(last.min) > 1 ? 5 : 1000) : 1;
    setSteps([...rows, { key: newKey(), min: String(last ? min : 1), price: '', name: '' }]);
  };
  const remove = (key: string) => setSteps(rows.filter((r) => r.key !== key));

  const mins = rows.map((r) => Number(r.min));
  const error = (r: Step, i: number) =>
    !/^\d+$/.test(r.min) || Number(r.min) < 1
      ? 'Whole number ≥ 1'
      : i > 0 && Number(r.min) <= mins[i - 1]
        ? 'Must be larger than the row above'
        : !MONEY.test(r.price.trim())
          ? 'Enter a price'
          : null;
  const valid = rows.length > 0 && rows.every((r, i) => !error(r, i));
  const top = Number(rows[0]?.price) || 0;

  if (all.isLoading) return <Skeleton className="h-32" />;
  if (all.error) return <ErrorState error={all.error} />;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">Prices</p>
          <p className="text-xs text-slate-500">Per SMS · {currency}</p>
        </div>
        {canManage && dirty && (
          <span className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSteps(null)}>Cancel</Button>
            <Button size="sm" disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save prices</Button>
          </span>
        )}
      </div>

      {!rows.length ? (
        <div className="mt-3 rounded-xl border border-dashed border-slate-300 p-6 text-center">
          <p className="text-sm font-medium text-slate-800">No prices for {listLabel}</p>
          {canManage && <Button size="sm" className="mt-3" icon={<Plus className="h-4 w-4" />} onClick={add}>Add price</Button>}
        </div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-slate-200">
          <div className="hidden grid-cols-[1fr_1fr_1fr_90px_36px] gap-3 bg-slate-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500 sm:grid">
            <span>From (SMS)</span><span>To</span><span>Price / SMS</span><span>Saving</span><span />
          </div>
          {rows.map((r, i) => {
            const next = rows[i + 1];
            const err = error(r, i);
            const price = Number(r.price);
            const saving = top && price && i > 0 ? Math.round(((top - price) / top) * 100) : null;
            const notCheaper = i > 0 && price && Number(rows[i - 1].price) && price >= Number(rows[i - 1].price);
            return (
              <div key={r.key} className="grid grid-cols-2 items-start gap-3 border-t border-slate-100 px-4 py-3 first:border-t-0 sm:grid-cols-[1fr_1fr_1fr_90px_36px] sm:items-center">
                <Input aria-label="From quantity" inputMode="numeric" value={r.min} disabled={!canManage} invalid={!!err && err.startsWith('Whole') || err === 'Must be larger than the row above'} onChange={(e) => set(r.key, { min: e.target.value.replace(/[\s,]/g, '') })} className="tabular-nums" />
                <span className="self-center text-sm tabular-nums text-slate-500">{next && /^\d+$/.test(next.min) ? fmtNumber(Number(next.min) - 1) : 'and more'}</span>
                <Input aria-label="Price per SMS" value={r.price} disabled={!canManage} invalid={err === 'Enter a price'} onChange={(e) => set(r.key, { price: e.target.value })} className="tabular-nums" placeholder="12" />
                <span className={cn('self-center text-sm tabular-nums', notCheaper ? 'text-amber-600' : 'text-emerald-700')}>{notCheaper ? 'Not cheaper' : saving ? `−${saving}%` : '—'}</span>
                {canManage ? (
                  <button type="button" onClick={() => remove(r.key)} className="self-center justify-self-end text-slate-400 hover:text-red-600" aria-label="Remove row"><Trash2 className="h-4 w-4" /></button>
                ) : <span />}
                {err && dirty && <p className="col-span-2 text-xs text-red-600 sm:col-span-5">{err}</p>}
              </div>
            );
          })}
          {canManage && (
            <button type="button" onClick={add} className="flex w-full items-center justify-center gap-1.5 border-t border-slate-100 py-2.5 text-sm font-medium text-brand-700 hover:bg-slate-50">
              <Plus className="h-4 w-4" /> Add range
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TelecomPanel({ network, countries, canManageRoutes, canManagePrices }: { network: SmsNetwork; countries: SmsCountry[]; canManageRoutes: boolean; canManagePrices: boolean }) {
  const availability = useQuery({ queryKey: ['admin', 'pricing', 'networks'], queryFn: adminService.pricingNetworks });
  const providers = useQuery({ queryKey: ['admin', 'providers'], queryFn: businessService.providers, enabled: canManageRoutes });
  const view = availability.data?.find((n) => n.id === network.id);
  const state = view ? CUSTOMER_STATE[view.availability] : null;
  const [editing, setEditing] = useState(false);
  const setFlag = useApiMutation((body: Record<string, unknown>) => businessService.updateNetwork(network.id, body), { success: 'Telecom updated', invalidate: [['admin', 'routing'], ['admin', 'pricing'], ['pricing'], ['site']] });
  const country = countries.find((c) => c.isoCode === network.countryCode);
  const delivering = [...network.providers, ...(country?.providers ?? []).filter((p) => !network.providers.some((x) => x.id === p.id))];

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-xs font-bold text-white" aria-hidden>{network.name.split(/\s+/)[0].slice(0, 3).toUpperCase()}</span>
            <div>
              <p className="text-lg font-semibold text-slate-900">{network.name}</p>
              <p className="text-xs text-slate-500"><span className="font-mono">{network.code}</span> · {network.prefixes.join(', ')}</p>
            </div>
          </div>
          {canManageRoutes && (
            <span className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(true)}>Edit telecom</Button>
              <Button size="sm" variant="secondary" icon={<Wrench className="h-3.5 w-3.5" />} loading={setFlag.isPending && setFlag.variables && 'inMaintenance' in setFlag.variables} onClick={() => setFlag.mutate({ inMaintenance: !network.inMaintenance })}>
                {network.inMaintenance ? 'End maintenance' : 'Pause (maintenance)'}
              </Button>
              <Button size="sm" variant="ghost" icon={<Power className="h-3.5 w-3.5" />} onClick={() => setFlag.mutate({ isActive: !network.isActive })}>{network.isActive ? 'Deactivate' : 'Activate'}</Button>
            </span>
          )}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
            <p className="text-xs text-slate-500">Status</p>
            {!network.isActive ? (
              <Badge color="gray">Inactive</Badge>
            ) : state ? (
              <Badge color={state.color} dot>{state.label}</Badge>
            ) : (
              <Skeleton className="mt-1 h-5 w-24" />
            )}
          </div>
          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
            <p className="text-xs text-slate-500">From</p>
            <p className="font-semibold tabular-nums text-slate-900">{view?.fromPrice ? fmtMoney(view.fromPrice, view.currency ?? undefined) : '—'}</p>
          </div>
          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
            <p className="text-xs text-slate-500">Delivered by</p>
            <p className="truncate text-sm font-medium text-slate-900">{delivering.length ? delivering.map((p) => p.name).join(', ') : <span className="text-red-600">No provider</span>}</p>
          </div>
        </div>
        {network.isActive && state?.fix && <Alert tone={state.color === 'red' ? 'danger' : 'warning'} className="mt-3">{state.fix}</Alert>}
      </Card>

      <Card>
        <LadderEditor networkId={network.id} listLabel={network.name} canManage={canManagePrices} />
      </Card>

      <PriceListCard key={network.id} networkId={network.id} listLabel={network.name} canManage={canManagePrices} countryCode={network.countryCode} />

      {editing && <NetworkModal open network={network} onClose={() => setEditing(false)} countries={countries} providers={providers.data ?? []} />}
    </div>
  );
}

function NetworksWorkspace() {
  const { canAdmin } = usePermissions();
  const canManageRoutes = canAdmin('providers.manage');
  const canManagePrices = canAdmin('packages.manage');
  const countries = useQuery({ queryKey: ['admin', 'routing', 'countries'], queryFn: businessService.countries });
  const networks = useQuery({ queryKey: ['admin', 'routing', 'networks'], queryFn: businessService.networks });
  const availability = useQuery({ queryKey: ['admin', 'pricing', 'networks'], queryFn: adminService.pricingNetworks });
  const providers = useQuery({ queryKey: ['admin', 'providers'], queryFn: businessService.providers, enabled: canManageRoutes });
  const [countryIso, setCountryIso] = useState<string | null>(null);
  const [networkId, setNetworkId] = useState<string | null>(null);
  const [addCountry, setAddCountry] = useState(false);
  const [addNetwork, setAddNetwork] = useState(false);

  const list = countries.data ?? [];
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const shown = term ? list.filter((c) => c.name.toLowerCase().includes(term) || c.isoCode.toLowerCase() === term) : list;
  const country = list.find((c) => c.isoCode === countryIso) ?? list[0] ?? null;
  const telecoms = (networks.data ?? []).filter((n) => n.countryCode === country?.isoCode).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  const network = telecoms.find((n) => n.id === networkId) ?? telecoms[0] ?? null;
  useEffect(() => setNetworkId(null), [country?.isoCode]);

  const onSale = (id: string) => availability.data?.find((n) => n.id === id)?.available;

  if (countries.isLoading || networks.isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (countries.error) return <Card><ErrorState error={countries.error} /></Card>;

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      {/* Step 1: country */}
      <Card padded={false} className="self-start">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-semibold text-slate-900">1 · Country</p>
          {canManageRoutes && <Button size="xs" variant="secondary" icon={<Plus className="h-3 w-3" />} onClick={() => setAddCountry(true)}>Add</Button>}
        </div>
        {list.length > 8 && (
          <div className="border-b border-slate-100 p-2">
            <Input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search countries" />
          </div>
        )}
        {!list.length ? (
          <EmptyState icon={<Globe2 />} title="No countries yet" className="py-8" />
        ) : (
          <ul className="max-h-[32rem] overflow-y-auto p-2" role="listbox" aria-label="Countries">
            {shown.map((c) => {
              const nets = (networks.data ?? []).filter((n) => n.countryCode === c.isoCode);
              const selling = nets.filter((n) => onSale(n.id)).length;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={country?.id === c.id}
                    onClick={() => setCountryIso(c.isoCode)}
                    className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition', country?.id === c.id ? 'bg-brand-50 ring-1 ring-brand-200' : 'hover:bg-slate-50')}
                  >
                    <span className="text-xl" aria-hidden>{flag(c.isoCode)}</span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-sm font-medium', c.isActive ? 'text-slate-900' : 'text-slate-400')}>{c.name}</span>
                      <span className="block text-xs text-slate-500">{c.isActive ? `${selling}/${nets.length} on sale` : 'Inactive'}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="space-y-5">
        {country && (
          <>
            {/* Step 2: telecom */}
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">2 · Telecoms in {country.name}</p>
                </div>
                {canManageRoutes && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAddNetwork(true)}>Add telecom</Button>}
              </div>
              {!telecoms.length ? (
                <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center">
                  <Radio className="mx-auto h-6 w-6 text-slate-400" />
                  <p className="mt-2 text-sm font-medium text-slate-800">No telecoms in {country.name} yet</p>
                </div>
              ) : (
                <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Telecoms">
                  {telecoms.map((n) => {
                    const sale = onSale(n.id);
                    return (
                      <button
                        key={n.id}
                        role="tab"
                        aria-selected={network?.id === n.id}
                        onClick={() => setNetworkId(n.id)}
                        className={cn('flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium ring-1 ring-inset transition', network?.id === n.id ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50')}
                      >
                        {sale ? <CheckCircle2 className={cn('h-4 w-4', network?.id === n.id ? 'text-emerald-300' : 'text-emerald-600')} /> : <AlertTriangle className={cn('h-4 w-4', network?.id === n.id ? 'text-amber-300' : 'text-amber-500')} />}
                        {n.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Step 3: prices for the telecom */}
            {network && <TelecomPanel key={network.id} network={network} countries={list} canManageRoutes={canManageRoutes} canManagePrices={canManagePrices} />}
          </>
        )}
      </div>

      <CountryModal open={addCountry} country={null} onClose={() => setAddCountry(false)} providers={providers.data ?? []} />
      <NetworkModal open={addNetwork} network={null} onClose={() => setAddNetwork(false)} countries={list} providers={providers.data ?? []} defaultCountryCode={country?.isoCode} />
    </div>
  );
}

export function PricingAdminPage() {
  const { canAdmin } = usePermissions();
  const [tab, setTab] = useState<'networks' | 'general' | 'insights'>('networks');
  return (
    <div className="space-y-6">
      <PageHeader
        title="SMS pricing"
        description="Country → telecom → prices."
        actions={<a href="/pricing" target="_blank" rel="noreferrer" className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50">View customer pricing page</a>}
      />
      <Tabs
        tabs={[
          { value: 'networks', label: 'Countries & telecoms' },
          { value: 'general', label: 'General credits' },
          ...(canAdmin('profit.view') || canAdmin('providers.view') ? [{ value: 'insights' as const, label: 'Costs & stock' }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'networks' && <NetworksWorkspace />}
      {tab === 'general' && (
        <div className="space-y-5">
          <Alert tone="info">General credits are not tied to a telecom: customers can use them on any network. Leave this empty if you only sell SMS per telecom.</Alert>
          <Card><LadderEditor networkId={null} listLabel="general credits" canManage={canAdmin('packages.manage')} /></Card>
          <PriceListCard networkId={null} listLabel="General credits" canManage={canAdmin('packages.manage')} countryCode={null} />
          <QuotePreview />
        </div>
      )}
      {tab === 'insights' && (
        <div className="space-y-5">
          <p className="text-sm text-slate-500">
            What the platform pays providers is kept separate from customer prices. Buy provider capacity on the <Link to="/admin/providers" className="link">Providers</Link> page.
          </p>
          <NetworkAvailabilityCard onPick={() => setTab('networks')} />
          {canAdmin('providers.view') && <InventoryByDestination />}
          {canAdmin('profit.view') && <ProfitPlanner />}
        </div>
      )}
    </div>
  );
}
