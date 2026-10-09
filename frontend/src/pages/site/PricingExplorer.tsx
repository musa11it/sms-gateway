import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Calculator, Globe2, Plus, ShieldCheck, TrendingDown, X } from 'lucide-react';
import { ApiError, errorMessage } from '@/api/client';
import type { CatalogNetwork, CatalogTier } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Alert, EmptyState, Skeleton } from '@/components/ui/Feedback';
import { Input } from '@/components/ui/Form';
import { CountrySwitcher, useCountry, useHomeCountry } from '@/components/sms/Destinations';
import { useDebounce } from '@/hooks/useDebounce';
import { siteService } from '@/services/businessService';
import { cn, fmtMoney, fmtNumber } from '@/utils/format';

/**
 * Country pricing: one card per telecom with its price ladder, and a calculator. All data comes from the
 * backend; the calculator uses the same engine as checkout, which re-prices before any purchase.
 */

const TILE = ['bg-slate-900', 'bg-brand-600', 'bg-emerald-600', 'bg-amber-500', 'bg-rose-600', 'bg-sky-600'];
const tileColor = (name: string) => TILE[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % TILE.length];
const initials = (name: string) => name.split(/\s+/)[0].slice(0, 3).toUpperCase();
const range = (t: CatalogTier) => (t.maxQuantity === null ? `${fmtNumber(t.minQuantity)}+` : `${fmtNumber(t.minQuantity)} – ${fmtNumber(t.maxQuantity)}`);

/** The next cheaper tier above a quantity: "buy N more to pay X per SMS". */
export function nextTier(tiers: CatalogTier[], quantity: number, currentPrice: string | null) {
  const next = tiers.filter((t) => t.minQuantity > quantity).sort((a, b) => a.minQuantity - b.minQuantity)[0];
  if (!next || (currentPrice !== null && Number(next.unitPrice) >= Number(currentPrice))) return null;
  return { more: next.minQuantity - quantity, price: next.unitPrice, currency: next.currency };
}

function TelecomCard({ n, onAdd, added }: { n: CatalogNetwork; onAdd: () => void; added: boolean }) {
  const prices = n.tiers.map((t) => Number(t.unitPrice));
  const max = Math.max(...prices, 0);
  const min = Math.min(...prices, Infinity);
  const save = max > 0 && min < max ? Math.round(((max - min) / max) * 100) : 0;
  return (
    <article className={cn('flex flex-col rounded-2xl bg-white p-5 ring-1 transition', n.available ? 'ring-slate-200 hover:shadow-pop' : 'ring-slate-200/70 opacity-75')}>
      <header className="flex items-center gap-3">
        <span className={cn('flex h-11 w-11 items-center justify-center rounded-xl text-xs font-bold text-white', tileColor(n.name))} aria-hidden>{initials(n.name)}</span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-slate-900">{n.name}</h3>
          <p className="text-xs text-slate-500">Bulk SMS</p>
        </div>
        {save > 0 && n.available && (
          <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
            <TrendingDown className="h-3 w-3" /> Save {save}%
          </span>
        )}
      </header>

      {n.available ? (
        <>
          <p className="mt-5 flex items-baseline gap-1">
            <span className="text-xs text-slate-500">from</span>
            <span className="text-3xl font-bold tracking-tight tabular-nums text-slate-900">{fmtMoney(n.fromPrice, n.currency ?? undefined)}</span>
            <span className="text-sm text-slate-500">/ SMS</span>
          </p>
          <ul className="mt-4 space-y-2" aria-label={`${n.name} prices`}>
            {n.tiers.map((t) => (
              <li key={t.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 text-sm">
                <span className="tabular-nums text-slate-600">{range(t)} SMS</span>
                <span className="font-semibold tabular-nums text-slate-900">{fmtMoney(t.unitPrice, t.currency)}</span>
                <span className="col-span-2 mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                  <span className="block h-full rounded-full bg-brand-500/70" style={{ width: `${max ? (Number(t.unitPrice) / max) * 100 : 0}%` }} />
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-auto flex items-center justify-between gap-2 pt-5">
            {n.requiresSenderRegistration ? (
              <span className="flex items-center gap-1 text-xs text-slate-500"><ShieldCheck className="h-3.5 w-3.5" /> Sender ID approval</span>
            ) : (
              <span />
            )}
            <Button size="sm" variant={added ? 'secondary' : 'primary'} icon={added ? undefined : <Plus className="h-3.5 w-3.5" />} onClick={onAdd}>{added ? 'Added' : 'Calculate'}</Button>
          </div>
        </>
      ) : (
        <p className="mt-5 text-sm text-slate-500">{n.availability === 'MAINTENANCE' ? 'Temporarily unavailable' : 'Not available yet'}</p>
      )}
    </article>
  );
}

type Line = { networkId: string; text: string };

function PriceCalculator({ networks, lines, setLines, canPurchase, loggedIn, countryIso }: { networks: CatalogNetwork[]; lines: Line[]; setLines: (fn: (l: Line[]) => Line[]) => void; canPurchase: boolean; loggedIn: boolean; countryIso: string }) {
  const navigate = useNavigate();
  const parsed = lines
    .map((l) => {
      const q = Number(l.text.replace(/[\s,]/g, ''));
      return { ...l, network: networks.find((n) => n.id === l.networkId)!, q: l.text.trim() !== '' && Number.isInteger(q) && q >= 1 && q <= 100_000_000 ? q : null };
    })
    .filter((l) => l.network);
  const items = useMemo(() => (parsed.length && parsed.every((l) => l.q !== null) ? parsed.map((l) => ({ networkId: l.networkId, quantity: l.q! })) : null), [JSON.stringify(parsed.map((l) => [l.networkId, l.q]))]); // eslint-disable-line react-hooks/exhaustive-deps
  const debounced = useDebounce(items, 300);
  const quote = useQuery({ queryKey: ['site', 'quote', debounced], queryFn: () => siteService.quote(debounced!), enabled: !!debounced, retry: false, placeholderData: (p) => p });
  const current = !!quote.data && !!items && !quote.isError && JSON.stringify(quote.data.items.map((i) => [i.networkId, i.quantity])) === JSON.stringify(items.map((i) => [i.networkId, i.quantity]));
  const fieldError = (i: number) => (quote.error instanceof ApiError ? quote.error.errors.find((e) => e.field.startsWith(`items.${i}.`))?.message : undefined);
  const remove = (id: string) => setLines((ls) => ls.filter((l) => l.networkId !== id));
  const proceed = () => {
    const target = `/app/wallet/buy?country=${countryIso}&items=${encodeURIComponent(items!.map((i) => `${i.networkId}:${i.quantity}`).join(','))}`;
    navigate(loggedIn ? target : `/login?next=${encodeURIComponent(target)}`);
  };

  return (
    <section aria-labelledby="calc-title" className="rounded-2xl bg-slate-900 p-5 text-white shadow-pop sm:p-6">
      <h3 id="calc-title" className="flex items-center gap-2 font-semibold"><Calculator className="h-5 w-5 text-slate-400" /> Calculator</h3>
      {!parsed.length ? (
        <p className="mt-3 text-sm text-slate-400">Add a network to estimate your cost.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {parsed.map((l, i) => {
            const priced = current ? quote.data!.items.find((x) => x.networkId === l.networkId) : undefined;
            const err = l.q === null ? 'Enter a whole number' : fieldError(i);
            const hint = priced && l.q ? nextTier(l.network.tiers, l.q, priced.unitPrice) : null;
            return (
              <div key={l.networkId} className="rounded-xl bg-white/5 p-3 ring-1 ring-inset ring-white/10">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{l.network.name}</p>
                  <button type="button" onClick={() => remove(l.networkId)} className="text-slate-400 hover:text-white" aria-label={`Remove ${l.network.name}`}><X className="h-4 w-4" /></button>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <label className="sr-only" htmlFor={`qty-${l.networkId}`}>SMS for {l.network.name}</label>
                  <Input id={`qty-${l.networkId}`} inputMode="numeric" value={l.text} invalid={!!err} onChange={(e) => setLines((ls) => ls.map((x) => (x.networkId === l.networkId ? { ...x, text: e.target.value } : x)))} className="w-32 tabular-nums" />
                  <span className="text-sm text-slate-400">SMS</span>
                  <span className="ml-auto text-right" aria-live="polite">
                    {priced ? (
                      <>
                        <span className="block font-semibold tabular-nums">{fmtMoney(priced.subtotal, priced.currency)}</span>
                        <span className="block text-xs text-slate-400">{fmtMoney(priced.unitPrice, priced.currency)} / SMS</span>
                      </>
                    ) : err ? null : (
                      <Skeleton className="h-5 w-20 bg-white/10" />
                    )}
                  </span>
                </div>
                {err && <p className="mt-1 text-xs text-red-300">{err}</p>}
                {hint && <p className="mt-2 text-xs text-emerald-300">+{fmtNumber(hint.more)} SMS → {fmtMoney(hint.price, hint.currency)} / SMS</p>}
              </div>
            );
          })}
          {quote.isError && !parsed.some((_, i) => fieldError(i)) && <p className="text-sm text-amber-300">{errorMessage(quote.error)}</p>}
          <div className="flex items-end justify-between gap-3 border-t border-white/10 pt-4">
            <div>
              <p className="text-xs text-slate-400">Total{current ? ` · ${fmtNumber(quote.data!.totalQuantity)} SMS` : ''}</p>
              <p className="text-3xl font-bold tabular-nums">{current ? fmtMoney(quote.data!.total, quote.data!.currency) : '—'}</p>
            </div>
            {canPurchase && current && (
              <Button onClick={proceed} icon={<ArrowRight className="h-4 w-4" />} className="bg-white text-slate-900 hover:bg-slate-100">{loggedIn ? 'Buy' : 'Sign in to buy'}</Button>
            )}
          </div>
          <p className="text-xs text-slate-500">Estimate · confirmed at checkout</p>
        </div>
      )}
    </section>
  );
}

export function PricingExplorer({ loggedIn, canPurchase = true }: { loggedIn: boolean; canPurchase?: boolean }) {
  const [params, setParams] = useSearchParams();
  const home = useHomeCountry();
  const iso = params.get('country')?.toUpperCase() ?? home.isoCode;
  const country = useCountry(iso);
  const [lines, setLines] = useState<Line[]>([]);
  useEffect(() => setLines([]), [iso]);
  const networks = country.data?.networks ?? [];

  const add = (n: CatalogNetwork) =>
    setLines((ls) => (ls.some((l) => l.networkId === n.id) ? ls : [...ls, { networkId: n.id, text: String(Math.max(n.minQuantity ?? 1, 1000)) }]));

  if (home.isLoading && !iso) return <Skeleton className="h-80 rounded-2xl" />;
  if (!iso) return <EmptyState icon={<Globe2 />} title="Pricing coming soon" description="Contact us for a quote." />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CountrySwitcher value={iso} onChange={(c) => setParams((p) => { p.set('country', c); return p; }, { replace: true })} className="w-full max-w-xs" />
        <p className="text-sm text-slate-500">Price per SMS · buy more, pay less</p>
      </div>
      {country.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-72 rounded-2xl" />)}</div>
      ) : country.error ? (
        <Alert tone="warning">{errorMessage(country.error)}</Alert>
      ) : !networks.length || !country.data!.available ? (
        <EmptyState icon={<Globe2 />} title={`${country.data?.name ?? 'This country'} — coming soon`} description="Choose another country or contact us." />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="grid gap-4 md:grid-cols-2">
            {networks.map((n) => <TelecomCard key={n.id} n={n} added={lines.some((l) => l.networkId === n.id)} onAdd={() => add(n)} />)}
          </div>
          <div className="xl:sticky xl:top-20 xl:self-start">
            <PriceCalculator networks={networks} lines={lines} setLines={setLines} canPurchase={canPurchase} loggedIn={loggedIn} countryIso={iso} />
          </div>
        </div>
      )}
    </div>
  );
}
