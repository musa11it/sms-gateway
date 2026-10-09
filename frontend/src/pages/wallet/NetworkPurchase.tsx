import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Check, CreditCard, Globe2, Radio, ShieldCheck, Smartphone } from 'lucide-react';
import { ApiError, errorMessage } from '@/api/client';
import type { CatalogNetwork, NetworkBalances, Payment } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert, EmptyState, Skeleton } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Form';
import { CountrySwitcher, flag, useCountry, useHomeCountry } from '@/components/sms/Destinations';
import { useApiMutation } from '@/hooks/useApiMutation';
import { useDebounce } from '@/hooks/useDebounce';
import { paymentService, type NextAction } from '@/services/walletService';
import { cn, fmtDate, fmtMoney, fmtNumber } from '@/utils/format';
import { nextTier } from '../site/PricingExplorer';

const PRESETS = [500, 1_000, 5_000, 10_000, 50_000];
const MAX_QUANTITY = 100_000_000;

const parseQty = (text: string) => {
  const n = Number(text.replace(/[\s,]/g, ''));
  return text.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= MAX_QUANTITY ? n : null;
};

function quantityProblem(n: CatalogNetwork, q: number | null) {
  if (q === null) return 'Enter a whole number';
  if (n.minQuantity !== null && q < n.minQuantity) return `Minimum ${fmtNumber(n.minQuantity)}`;
  if (n.maxQuantity !== null && q > n.maxQuantity) return `Maximum ${fmtNumber(n.maxQuantity)}`;
  return null;
}

/** Selectable telecom card with its price ladder (the range the quantity is in is highlighted). */
function NetworkCard({ n, selected, onToggle, quantity }: { n: CatalogNetwork; selected: boolean; onToggle: () => void; quantity: number | null }) {
  const tier = quantity !== null ? n.tiers.find((t) => quantity >= t.minQuantity && (t.maxQuantity === null || quantity <= t.maxQuantity)) : null;
  return (
    <label
      className={cn(
        'flex cursor-pointer flex-col gap-3 rounded-xl border p-4 transition',
        !n.available ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-70' : selected ? 'border-brand-300 bg-brand-50/50 ring-1 ring-brand-200' : 'border-slate-200 hover:bg-slate-50',
      )}
    >
      <div className="flex items-center gap-3">
        <input type="checkbox" className="rounded text-brand-600" checked={selected} disabled={!n.available} onChange={onToggle} />
        <span className="flex-1 font-semibold text-slate-900">{n.name}</span>
        {n.available ? <span className="text-sm text-slate-500">from <span className="font-semibold text-slate-900">{fmtMoney(n.fromPrice, n.currency ?? undefined)}</span></span> : <Badge color="gray">{n.availability === 'MAINTENANCE' ? 'Maintenance' : 'Unavailable'}</Badge>}
      </div>
      {n.available && (
        <ul className="space-y-1 text-xs">
          {n.tiers.map((t) => (
            <li key={t.id} className={cn('flex justify-between rounded-md px-2 py-1 tabular-nums', tier?.id === t.id ? 'bg-brand-100/70 font-semibold text-brand-900' : 'text-slate-600')}>
              <span>{t.label.replace('–', ' – ')} SMS</span>
              <span>{fmtMoney(t.unitPrice, t.currency)}</span>
            </li>
          ))}
        </ul>
      )}
      {n.available && n.requiresSenderRegistration && <p className="flex items-center gap-1 text-xs text-slate-500"><ShieldCheck className="h-3.5 w-3.5" /> Sender ID approval needed</p>}
    </label>
  );
}

export function NetworkBalancesCard({ balances, loading }: { balances?: NetworkBalances; loading: boolean }) {
  if (loading) return <Skeleton className="h-28 rounded-xl" />;
  if (!balances || (!balances.networks.length && !balances.general.credits)) return null;
  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">Balances</p>
        <p className="text-sm text-slate-500"><span className="font-semibold tabular-nums text-slate-900">{fmtNumber(balances.total)}</span> SMS total</p>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {balances.networks.map((n) => (
          <div key={n.networkId} className="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
            <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600">{n.countryCode && <span aria-hidden>{flag(n.countryCode)}</span>}{n.name}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{fmtNumber(n.credits)}</p>
            <p className="text-xs text-slate-500">{!n.sendable ? 'Paused — kept' : n.nextExpiry ? `Expires ${fmtDate(n.nextExpiry)}` : `${n.name} only`}</p>
          </div>
        ))}
        {balances.general.credits > 0 && (
          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
            <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600"><Globe2 className="h-3.5 w-3.5" /> Any network</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{fmtNumber(balances.general.credits)}</p>
            <p className="text-xs text-slate-500">General credits</p>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Buy SMS by country and telecom. Every price comes from the server (organization-aware quote). */
export function NetworkPurchase({ onCheckout }: { onCheckout: (c: { payment: Payment; nextAction: NextAction; simulation: boolean }) => void }) {
  // Prefill from the Pricing page: ?country=RW&items=<networkId>:<quantity>,…
  const [params] = useSearchParams();
  const prefill = (params.get('items') ?? '')
    .split(',')
    .map((s) => s.split(':'))
    .filter(([id, q]) => /^[0-9a-f-]{36}$/i.test(id ?? '') && /^\d{1,9}$/.test(q ?? ''));
  const home = useHomeCountry();
  const [countryIso, setCountryIso] = useState<string | null>(params.get('country')?.toUpperCase() ?? null);
  const iso = countryIso ?? home.isoCode;
  const country = useCountry(iso);
  const [selected, setSelected] = useState<string[]>(prefill.map(([id]) => id));
  const [quantities, setQuantities] = useState<Record<string, string>>(Object.fromEntries(prefill));
  const [method, setMethod] = useState<'MOBILE_MONEY' | 'CARD'>('MOBILE_MONEY');
  const [phone, setPhone] = useState('');
  const firstIso = useState(iso)[0];
  useEffect(() => {
    if (iso !== firstIso) setSelected([]);
  }, [iso, firstIso]);

  const networks = country.data?.networks ?? [];
  const lines = networks
    .filter((n) => selected.includes(n.id) && n.available)
    .map((n) => {
      const text = quantities[n.id] ?? String(Math.max(n.minQuantity ?? 1, 1000));
      const q = parseQty(text);
      return { n, text, q, problem: quantityProblem(n, q) };
    });
  const valid = lines.length > 0 && lines.every((l) => !l.problem);
  const items = useMemo(() => (valid ? lines.map((l) => ({ networkId: l.n.id, quantity: l.q! })) : null), [valid, JSON.stringify(lines.map((l) => [l.n.id, l.q]))]); // eslint-disable-line react-hooks/exhaustive-deps
  const debounced = useDebounce(items, 300);
  const quote = useQuery({ queryKey: ['payments', 'quote', debounced], queryFn: () => paymentService.quote(debounced!), enabled: !!debounced, retry: false, placeholderData: (p) => p });
  const current = !!quote.data && !!items && !quote.isError && JSON.stringify(quote.data.items.map((i) => [i.networkId, i.quantity])) === JSON.stringify(items.map((i) => [i.networkId, i.quantity]));
  const quoteErrorFor = (index: number) => (quote.error instanceof ApiError ? quote.error.errors.find((e) => e.field.startsWith(`items.${index}.`))?.message : undefined);

  const create = useApiMutation(() => paymentService.create({ items: items!, method, payerPhone: method === 'MOBILE_MONEY' ? phone : undefined }), { onSuccess: (d) => onCheckout(d), invalidate: [['payments']] });
  const canPay = current && !(method === 'MOBILE_MONEY' && phone.trim().length < 9);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  if (!iso && home.isLoading) return <Skeleton className="h-72 rounded-xl" />;
  if (!iso) return <Card><EmptyState icon={<Radio />} title="Nothing on sale yet" /></Card>;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <Card className="space-y-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">Choose networks</h2>
            <CountrySwitcher size="sm" value={iso} onChange={(c) => { setCountryIso(c); setSelected([]); }} className="w-56" />
          </div>
          {country.isLoading ? (
            <Skeleton className="h-40" />
          ) : !networks.some((n) => n.available) ? (
            <EmptyState icon={<Radio />} title={`${country.data?.name ?? 'This country'} — coming soon`} className="py-6" />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {networks.map((n) => <NetworkCard key={n.id} n={n} selected={selected.includes(n.id)} onToggle={() => toggle(n.id)} quantity={lines.find((l) => l.n.id === n.id)?.q ?? null} />)}
            </div>
          )}
        </Card>

        {lines.length > 0 && (
          <Card className="space-y-4 p-6">
            <h2 className="text-base font-semibold text-slate-900">How many SMS?</h2>
            {lines.map((l, i) => {
              const priced = current ? quote.data!.items.find((x) => x.networkId === l.n.id) : undefined;
              const err = l.problem ?? quoteErrorFor(i);
              const hint = priced && l.q ? nextTier(l.n.tiers, l.q, priced.unitPrice) : null;
              return (
                <div key={l.n.id} className="rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Field label={l.n.name} error={err} className="min-w-[180px] flex-1">
                      <Input inputMode="numeric" value={l.text} onChange={(e) => setQuantities((q) => ({ ...q, [l.n.id]: e.target.value }))} invalid={!!err} className="max-w-[200px] text-lg font-semibold tabular-nums" aria-label={`SMS for ${l.n.name}`} />
                    </Field>
                    <div className="text-right" aria-live="polite">
                      {priced ? (
                        <>
                          <p className="text-lg font-semibold tabular-nums text-slate-900">{fmtMoney(priced.subtotal, priced.currency)}</p>
                          <p className="text-xs text-slate-500">{fmtMoney(priced.unitPrice, priced.currency)} / SMS · {priced.tier.label.replace('–', ' – ')}</p>
                        </>
                      ) : err ? <span className="text-slate-400">—</span> : <Skeleton className="ml-auto h-6 w-24" />}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {PRESETS.filter((p) => (l.n.minQuantity ?? 1) <= p && (l.n.maxQuantity === null || p <= l.n.maxQuantity)).map((p) => (
                      <button key={p} type="button" onClick={() => setQuantities((q) => ({ ...q, [l.n.id]: String(p) }))} className={cn('rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition', l.q === p ? 'bg-brand-50 text-brand-700 ring-brand-300' : 'text-slate-600 ring-slate-200 hover:bg-slate-50')}>
                        {fmtNumber(p)}
                      </button>
                    ))}
                    {hint && (
                      <button type="button" onClick={() => setQuantities((q) => ({ ...q, [l.n.id]: String(l.q! + hint.more) }))} className="ml-auto text-xs font-medium text-emerald-700 hover:underline">
                        +{fmtNumber(hint.more)} SMS → {fmtMoney(hint.price, hint.currency)} / SMS
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </div>

      <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-900">Summary</p>
          {!lines.length ? (
            <p className="mt-3 text-sm text-slate-500">Choose at least one network.</p>
          ) : quote.isError && !lines.some((l) => l.problem) ? (
            <Alert tone="warning" className="mt-3">{errorMessage(quote.error)}</Alert>
          ) : !current ? (
            <div className="mt-4 space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-5" />)}</div>
          ) : (
            <div className="mt-3 text-sm" aria-live="polite">
              {quote.data!.items.map((i) => (
                <div key={i.networkId} className="flex justify-between gap-3 border-t border-slate-100 py-2 first:border-t-0">
                  <span>
                    <span className="font-medium text-slate-900">{i.networkName}</span>
                    <span className="block text-xs text-slate-500">{fmtNumber(i.quantity)} × {fmtMoney(i.unitPrice, i.currency)}</span>
                  </span>
                  <span className="tabular-nums">{fmtMoney(i.subtotal, i.currency)}</span>
                </div>
              ))}
              <div className="mt-2 flex items-baseline justify-between border-t border-slate-200 pt-3">
                <span className="font-semibold text-slate-900">Total</span>
                <span className="text-2xl font-bold tabular-nums text-slate-900">{fmtMoney(quote.data!.total, quote.data!.currency)}</span>
              </div>
            </div>
          )}
        </Card>

        <Card className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-2">
            {([
              ['MOBILE_MONEY', 'Mobile money', Smartphone],
              ['CARD', 'Card', CreditCard],
            ] as const).map(([v, l, Icon]) => (
              <label key={v} className={cn('flex cursor-pointer items-center gap-2 rounded-xl border p-3 text-sm transition', method === v ? 'border-brand-300 bg-brand-50/50' : 'border-slate-200 hover:bg-slate-50')}>
                <input type="radio" name="network-pay-method" className="text-brand-600" checked={method === v} onChange={() => setMethod(v)} />
                <Icon className="h-4 w-4 text-slate-500" /> {l}
              </label>
            ))}
          </div>
          {method === 'MOBILE_MONEY' && (
            <Field label="Mobile money number">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0788 123 456" />
            </Field>
          )}
          <Button className="w-full" size="lg" loading={create.isPending} disabled={!canPay} icon={canPay ? <Check className="h-4 w-4" /> : undefined} onClick={() => create.mutate(undefined)}>
            {current ? `Pay ${fmtMoney(quote.data!.total, quote.data!.currency)}` : 'Pay'}
          </Button>
          <p className="text-center text-xs text-slate-500">SMS are added after payment is confirmed.</p>
        </Card>
      </div>
    </div>
  );
}
