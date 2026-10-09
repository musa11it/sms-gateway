import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { CatalogNetwork } from '@/api/types';
import { Input } from '@/components/ui/Form';
import { useMe } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { siteService } from '@/services/businessService';
import { cn, fmtMoney } from '@/utils/format';

/**
 * Destination helpers shared by the pricing, purchase, send, campaign and sender ID screens.
 * Countries are never loaded all at once: the list is searched on the server (20 at a time) and only
 * the opened country's telecoms and prices are fetched.
 */

export const flag = (iso: string) => String.fromCodePoint(...[...iso.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

/** The customer's home country (their organization's country), else the platform default. */
export function useHomeCountry() {
  const me = useMe();
  const prefer = me.data?.organization?.country ?? undefined;
  const q = useQuery({
    queryKey: ['site', 'countries', 'home', prefer ?? null],
    queryFn: () => siteService.countries({ limit: 1, prefer }),
    staleTime: 5 * 60_000,
    enabled: !me.isLoading,
  });
  return { isoCode: q.data?.defaultIsoCode ?? null, isLoading: me.isLoading || q.isLoading };
}

/** One country's telecoms, prices and availability. */
export function useCountry(isoCode: string | null) {
  return useQuery({ queryKey: ['site', 'country', isoCode], queryFn: () => siteService.country(isoCode!), enabled: !!isoCode, staleTime: 60_000 });
}

/** Button + searchable popover. Shows the current country; searches all countries on the server. */
export function CountrySwitcher({ value, onChange, size = 'md', className }: { value: string | null; onChange: (iso: string) => void; size?: 'sm' | 'md'; className?: string }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 250);
  const ref = useRef<HTMLDivElement>(null);
  const current = useCountry(value);
  const list = useQuery({ queryKey: ['site', 'countries', 'search', debounced], queryFn: () => siteService.countries({ search: debounced || undefined, limit: 20 }), enabled: open, staleTime: 60_000, placeholderData: (p) => p });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const c = current.data;
  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-xl bg-white text-left ring-1 ring-slate-200 transition hover:ring-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
          size === 'md' ? 'px-4 py-3 shadow-sm' : 'px-3 py-1.5 text-sm',
        )}
      >
        {c ? (
          <>
            <span className={size === 'md' ? 'text-2xl leading-none' : 'text-base leading-none'} aria-hidden>{flag(c.isoCode)}</span>
            <span className="min-w-0 flex-1 truncate font-semibold text-slate-900">{c.name}</span>
            {size === 'md' && c.callingCode && <span className="text-sm text-slate-400">+{c.callingCode}</span>}
          </>
        ) : (
          <span className="flex-1 text-slate-500">{value ? '…' : 'Choose country'}</span>
        )}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-slate-400 transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl bg-white p-2 shadow-pop ring-1 ring-slate-200">
          <Input autoFocus leading={<Search className="h-4 w-4" />} placeholder="Search country or +code" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} aria-label="Search countries" />
          <ul role="listbox" aria-label="Countries" className="mt-2 max-h-72 overflow-y-auto">
            {list.data?.countries.map((x) => (
              <li key={x.isoCode}>
                <button
                  type="button"
                  role="option"
                  aria-selected={x.isoCode === value}
                  onClick={() => {
                    onChange(x.isoCode);
                    setOpen(false);
                    setSearch('');
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
                >
                  <span className="text-lg leading-none" aria-hidden>{flag(x.isoCode)}</span>
                  <span className={cn('flex-1 truncate', x.available ? 'font-medium text-slate-800' : 'text-slate-400')}>{x.name}</span>
                  {x.fromPrice ? <span className="text-xs tabular-nums text-slate-500">from {fmtMoney(x.fromPrice, list.data?.currency)}</span> : <span className="text-xs text-slate-400">Soon</span>}
                  {x.isoCode === value && <Check className="h-4 w-4 text-brand-600" />}
                </button>
              </li>
            ))}
            {list.data && !list.data.countries.length && <li className="px-3 py-2 text-sm text-slate-500">No match</li>}
            {list.data && list.data.total > list.data.countries.length && <li className="px-3 py-1.5 text-xs text-slate-400">Type to find more…</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Country switcher + telecom chips. Selection is a list of network ids (kept when switching country). */
export function NetworkPicker({ selected, onChange, label = 'Networks' }: { selected: string[]; onChange: (ids: string[]) => void; label?: string }) {
  const home = useHomeCountry();
  const [iso, setIso] = useState<string | null>(null);
  const country = useCountry(iso ?? home.isoCode);
  const networks: CatalogNetwork[] = (country.data?.networks ?? []).filter((n) => n.availability !== 'NO_ROUTE' && n.availability !== 'OUTBOUND_UNAVAILABLE');
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="label mb-0">{label}</p>
        <CountrySwitcher size="sm" value={iso ?? home.isoCode} onChange={setIso} className="w-48" />
        {selected.length > 0 && <button type="button" className="text-xs text-slate-500 underline" onClick={() => onChange([])}>Clear</button>}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {networks.map((n) => {
          const on = selected.includes(n.id);
          return (
            <button
              key={n.id}
              type="button"
              aria-pressed={on}
              disabled={n.availability === 'MAINTENANCE'}
              onClick={() => onChange(on ? selected.filter((i) => i !== n.id) : [...selected, n.id])}
              className={cn('rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset transition disabled:opacity-40', on ? 'bg-brand-50 text-brand-800 ring-brand-300' : 'text-slate-600 ring-slate-200 hover:bg-slate-50')}
            >
              {on && <Check className="mr-1 inline h-3.5 w-3.5" />}
              {n.name}
            </button>
          );
        })}
        {country.data && !networks.length && <span className="text-sm text-slate-400">No telecoms</span>}
      </div>
    </div>
  );
}
