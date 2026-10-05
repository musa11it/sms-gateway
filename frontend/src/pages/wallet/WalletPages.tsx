import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, Bell, Download, Check, CheckCircle2, CreditCard, FileText, FlaskConical, Hourglass, Loader2, Printer, Receipt, Smartphone, Sparkles, Wallet, XCircle } from 'lucide-react';
import type { Payment, SmsPackage, TxType } from '@/api/types';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, StatCard } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader, Skeleton } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Overlay';
import { DataTable, Pagination } from '@/components/ui/Table';
import { PageHeader, SegmentedControl } from '@/components/ui/Misc';
import { errorMessage } from '@/api/client';
import { useApiMutation } from '@/hooks/useApiMutation';
import { useDebounce } from '@/hooks/useDebounce';
import { usePermissions } from '@/hooks/useAuth';
import { invoiceService, paymentService, walletService, type NextAction } from '@/services/walletService';
import { cn, fmtDate, fmtDateTime, fmtMoney, fmtNumber, titleCase } from '@/utils/format';

// ── Buy SMS ─────────────────────────────────────────────────────────────

function CheckoutModal({ payment, nextAction, simulation, onClose }: { payment: Payment | null; nextAction: NextAction | null; simulation: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const status = useQuery({
    queryKey: ['payment', payment?.id],
    queryFn: () => paymentService.get(payment!.id),
    enabled: !!payment,
    refetchInterval: (q) => (q.state.data && ['SUCCESS', 'FAILED', 'CANCELLED'].includes(q.state.data.status) ? false : 1500),
  });
  const p = status.data ?? payment;
  const [acted, setActed] = useState<'APPROVE' | 'DECLINE' | null>(null);
  useEffect(() => setActed(null), [payment?.id]);
  const act = useApiMutation((a: 'APPROVE' | 'DECLINE') => paymentService.simulate(payment!.id, a), { onSuccess: (_d, a) => setActed(a) });
  const verify = useApiMutation(() => paymentService.verify(payment!.id), { onSuccess: () => void status.refetch() });
  useEffect(() => {
    if (p?.status === 'SUCCESS') {
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['reports'] });
      void qc.invalidateQueries({ queryKey: ['payments'] });
    }
  }, [p?.status, qc]);
  if (!payment || !p) return null;
  const final = ['SUCCESS', 'FAILED', 'CANCELLED'].includes(p.status);

  return (
    <Modal open onClose={onClose} title="Complete your payment" description={`${p.packageName} · ${fmtNumber(p.credits)} SMS credits`} size="md">
      {p.status === 'SUCCESS' ? (
        <div className="py-4 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100"><CheckCircle2 className="h-8 w-8 text-emerald-600" /></div>
          <p className="mt-4 text-lg font-semibold text-slate-900">Payment confirmed</p>
          <p className="mt-1 text-sm text-slate-500">{fmtNumber(p.credits)} credits were added to your wallet after the provider verified the payment.</p>
          <div className="mt-6 flex justify-center gap-2">
            {p.invoice && <Button variant="secondary" icon={<FileText className="h-4 w-4" />} onClick={() => navigate(`/app/wallet/invoices/${p.invoice!.id}`)}>View invoice {p.invoice.number}</Button>}
            <Button onClick={() => navigate('/app/sms/send')}>Send SMS</Button>
          </div>
        </div>
      ) : p.status === 'FAILED' || p.status === 'CANCELLED' ? (
        <div className="py-4 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-100"><XCircle className="h-8 w-8 text-red-600" /></div>
          <p className="mt-4 text-lg font-semibold text-slate-900">Payment {p.status.toLowerCase()}</p>
          <p className="mt-1 text-sm text-slate-500">{p.failureReason ?? 'No credits were added.'}</p>
          <Button className="mt-6" variant="secondary" onClick={onClose}>Try again</Button>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center justify-between rounded-xl bg-slate-50 p-4 ring-1 ring-inset ring-slate-100">
            <div>
              <p className="text-xs text-slate-500">Amount due</p>
              <p className="text-2xl font-semibold tabular-nums text-slate-900">{fmtMoney(p.amount, p.currency)}</p>
            </div>
            <div className="text-right text-xs text-slate-500">
              <p>Reference</p>
              <p className="font-mono text-slate-700">{p.reference}</p>
            </div>
          </div>
          {nextAction && <p className="text-sm text-slate-600">{nextAction.message}</p>}
          {simulation ? (
            <div className="rounded-2xl border border-amber-200 bg-gradient-to-b from-amber-50 to-white p-4">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-800"><FlaskConical className="h-4 w-4" /> Simulated payer device</p>
              <div className="mx-auto mt-3 max-w-[260px] rounded-[1.6rem] bg-slate-900 p-2 shadow-pop">
                <div className="rounded-[1.2rem] bg-white p-4 text-center">
                  <Smartphone className="mx-auto h-6 w-6 text-slate-400" />
                  <p className="mt-2 text-xs text-slate-500">{titleCase(p.method)} request</p>
                  <p className="text-lg font-semibold text-slate-900">{fmtMoney(p.amount, p.currency)}</p>
                  <p className="text-[11px] text-slate-500">to SMS Gateway · {p.payerPhone ?? 'card'}</p>
                  {acted ? (
                    <p className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-600"><Loader2 className="h-3.5 w-3.5 animate-spin" />Waiting for provider confirmation…</p>
                  ) : (
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <Button size="sm" variant="secondary" loading={act.isPending && act.variables === 'DECLINE'} onClick={() => act.mutate('DECLINE')}>Decline</Button>
                      <Button size="sm" variant="success" loading={act.isPending && act.variables === 'APPROVE'} onClick={() => act.mutate('APPROVE')}>Approve</Button>
                    </div>
                  )}
                </div>
              </div>
              <p className="mt-3 text-center text-[11px] text-amber-800">No real money moves. Credits are added only after the backend verifies the payment with the provider.</p>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" /> Waiting for payment confirmation…</p>
          )}
          {!final && (
            <div className="flex items-center justify-between border-t border-slate-100 pt-4">
              <span className="flex items-center gap-2 text-xs text-slate-500"><StatusBadge status={p.status} /> checking automatically</span>
              <Button size="sm" variant="ghost" loading={verify.isPending} onClick={() => verify.mutate(undefined)}>Check status now</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const MAX_QUANTITY = 100_000_000;
const QUICK_AMOUNTS = [500, 1_000, 2_500, 5_000, 10_000, 25_000];

const tierRange = (t: { minQuantity: number; maxQuantity: number | null }) =>
  t.maxQuantity === null ? `${fmtNumber(t.minQuantity)}+` : `${fmtNumber(t.minQuantity)} – ${fmtNumber(t.maxQuantity)}`;

export function BuySmsPage() {
  const packages = useQuery({ queryKey: ['packages'], queryFn: walletService.packages });
  const tiers = useQuery({ queryKey: ['pricing', 'tiers'], queryFn: walletService.tiers });
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: walletService.wallet });
  const [mode, setMode] = useState<'amount' | 'package'>('amount');
  const [quantityText, setQuantityText] = useState('1000');
  const [selected, setSelected] = useState<SmsPackage | null>(null);
  const [method, setMethod] = useState<'MOBILE_MONEY' | 'CARD'>('MOBILE_MONEY');
  const [phone, setPhone] = useState('');
  const [checkout, setCheckout] = useState<{ payment: Payment; nextAction: NextAction; simulation: boolean } | null>(null);

  const quantity = Number(quantityText.replace(/[\s,]/g, ''));
  const quantityValid = quantityText.trim() !== '' && Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QUANTITY;
  const debounced = useDebounce(quantityValid ? quantity : null, 300);
  // The price shown always comes from the server's pricing engine.
  const quote = useQuery({
    queryKey: ['pricing', 'quote', debounced],
    queryFn: () => walletService.quote(debounced!),
    enabled: mode === 'amount' && debounced !== null,
    placeholderData: (p) => p,
    retry: false,
  });
  const quoteCurrent = quote.data && quantityValid && quote.data.quantity === quantity && !quote.isError;
  const hasTiers = !!tiers.data?.length;
  const effectiveMode = hasTiers ? mode : 'package';

  useEffect(() => {
    if (!selected && packages.data?.length) setSelected(packages.data.find((p) => p.isPopular) ?? packages.data[0]);
  }, [packages.data, selected]);

  const create = useApiMutation(
    () =>
      paymentService.create({
        ...(effectiveMode === 'amount' ? { quantity } : { packageId: selected!.id }),
        method,
        payerPhone: method === 'MOBILE_MONEY' ? phone : undefined,
      }),
    { onSuccess: (d) => setCheckout(d), invalidate: [['payments']] },
  );

  const summary =
    effectiveMode === 'amount'
      ? quoteCurrent
        ? { credits: quote.data!.quantity, total: quote.data!.total, currency: quote.data!.currency, unit: quote.data!.unitPrice, label: `Tier ${quote.data!.tier.label}` }
        : null
      : selected
        ? { credits: selected.credits, total: selected.price, currency: selected.currency, unit: selected.pricePerSms, label: `${selected.name} package` }
        : null;
  const canPay = !!summary && !(method === 'MOBILE_MONEY' && phone.trim().length < 9);
  const loading = tiers.isLoading || packages.isLoading;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Buy SMS"
        description="Buy any amount of SMS credits. Your quantity determines the applicable discounted rate."
        breadcrumbs={[{ label: 'Wallet' }, { label: 'Buy SMS' }]}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Current balance" icon={<Wallet />} value={fmtNumber(wallet.data?.balance)} loading={wallet.isLoading} hint="credits" />
        <StatCard label="Purchased this month" icon={<ArrowDownLeft />} tone="emerald" value={fmtNumber(wallet.data?.thisMonth.purchased)} loading={wallet.isLoading} />
        <StatCard label="Used this month" icon={<ArrowUpRight />} tone="violet" value={fmtNumber(wallet.data?.thisMonth.consumed)} loading={wallet.isLoading} />
        <StatCard
          label="Expiring soon"
          icon={<Hourglass />}
          tone={wallet.data?.expiringSoon?.credits ? 'amber' : 'brand'}
          value={fmtNumber(wallet.data?.expiringSoon?.credits ?? 0)}
          loading={wallet.isLoading}
          hint={
            wallet.data?.expiringSoon?.nextExpiry
              ? `next: ${fmtNumber(wallet.data.expiringSoon.nextExpiry.credits)} on ${fmtDate(wallet.data.expiringSoon.nextExpiry.at)}`
              : `within ${wallet.data?.expiringSoon?.withinDays ?? 30} days`
          }
        />
      </div>

      {loading ? (
        <Skeleton className="h-72 rounded-xl" />
      ) : tiers.error && packages.error ? (
        <Card><ErrorState error={tiers.error} /></Card>
      ) : !hasTiers && !packages.data?.length ? (
        <Card><EmptyState icon={<Receipt />} title="SMS credits are not on sale yet" description="Please check back soon or contact support." /></Card>
      ) : (
        <>
          {hasTiers && !!packages.data?.length && (
            <SegmentedControl
              value={effectiveMode}
              onChange={setMode}
              options={[
                { value: 'amount', label: 'Any amount' },
                { value: 'package', label: 'Packages' },
              ]}
            />
          )}

          {effectiveMode === 'amount' ? (
            <Card className="grid gap-6 p-6 lg:grid-cols-[1fr_340px]">
              <div className="space-y-5">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Buy SMS credits</h2>
                  <p className="mt-1 text-sm text-slate-500">Enter any whole number of SMS. The whole purchase is charged at the rate of the tier your quantity falls in.</p>
                </div>
                <Field label="Quantity (SMS credits)" error={quantityText.trim() !== '' && !quantityValid ? `Enter a whole number between 1 and ${fmtNumber(MAX_QUANTITY)}` : undefined}>
                  <Input
                    inputMode="numeric"
                    value={quantityText}
                    onChange={(e) => setQuantityText(e.target.value)}
                    invalid={quantityText.trim() !== '' && !quantityValid}
                    className="max-w-xs text-lg font-semibold tabular-nums"
                    aria-describedby="quick-amounts"
                  />
                </Field>
                <div id="quick-amounts" className="flex flex-wrap gap-2">
                  {QUICK_AMOUNTS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setQuantityText(String(n))}
                      className={cn('rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition', quantity === n ? 'bg-brand-50 text-brand-700 ring-brand-300' : 'text-slate-600 ring-slate-200 hover:bg-slate-50')}
                    >
                      {fmtNumber(n)}
                    </button>
                  ))}
                </div>
                <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                      <tr><th className="px-4 py-2">SMS quantity</th><th className="px-4 py-2 text-right">Price per SMS</th></tr>
                    </thead>
                    <tbody>
                      {tiers.data!.map((t) => {
                        const active = quoteCurrent && quote.data!.tier.id === t.id;
                        return (
                          <tr key={t.id} className={cn('border-t border-slate-100', active && 'bg-brand-50/60 font-semibold text-brand-900')}>
                            <td className="px-4 py-2 tabular-nums">{tierRange(t)}{active && <Check className="ml-2 inline h-3.5 w-3.5" />}</td>
                            <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(t.unitPrice, t.currency)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 p-5 ring-1 ring-inset ring-slate-100" aria-live="polite">
                <p className="text-sm font-semibold text-slate-900">Your price</p>
                {quote.isError && quantityValid ? (
                  <Alert tone="warning" className="mt-3">{errorMessage(quote.error)}</Alert>
                ) : !quoteCurrent ? (
                  <div className="mt-4 space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-5" />)}</div>
                ) : (
                  <dl className="mt-3 space-y-2.5 text-sm">
                    <div className="flex justify-between gap-4"><dt className="text-slate-500">Pricing tier</dt><dd className="tabular-nums">{quote.data!.tier.label.replace('–', ' – ')}</dd></div>
                    <div className="flex justify-between gap-4"><dt className="text-slate-500">Price per SMS</dt><dd className="font-medium tabular-nums">{fmtMoney(quote.data!.unitPrice, quote.data!.currency)}</dd></div>
                    <div className="flex justify-between gap-4"><dt className="text-slate-500">SMS credits</dt><dd className="tabular-nums">{fmtNumber(quote.data!.quantity)}</dd></div>
                    {quote.data!.savings && (
                      <div className="flex justify-between gap-4 text-emerald-700">
                        <dt>You save vs. {fmtMoney(quote.data!.savings.comparedToUnitPrice, quote.data!.currency)}/SMS</dt>
                        <dd className="font-medium tabular-nums">{fmtMoney(quote.data!.savings.amount, quote.data!.currency)}</dd>
                      </div>
                    )}
                    <div className="border-t border-slate-200 pt-3">
                      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Total</dt>
                      <dd className="mt-0.5 text-3xl font-bold tracking-tight text-slate-900 tabular-nums">{fmtMoney(quote.data!.total, quote.data!.currency)}</dd>
                      <dd className="mt-1 text-xs text-slate-500">{fmtNumber(quote.data!.quantity)} × {fmtMoney(quote.data!.unitPrice, quote.data!.currency)}</dd>
                    </div>
                  </dl>
                )}
              </div>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {packages.data?.map((p) => {
                const active = selected?.id === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelected(p)}
                    className={cn('card relative flex flex-col p-5 text-left transition hover:-translate-y-0.5 hover:shadow-pop', active && 'ring-2 ring-brand-600')}
                  >
                    {p.isPopular && <span className="absolute -top-2.5 left-4 flex items-center gap-1 rounded-full bg-gradient-to-r from-brand-600 to-violet-600 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow"><Sparkles className="h-3 w-3" /> Best value</span>}
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-500">{p.name}</span>
                      <span className={cn('flex h-5 w-5 items-center justify-center rounded-full ring-1', active ? 'bg-brand-600 text-white ring-brand-600' : 'ring-slate-300')}>{active && <Check className="h-3 w-3" />}</span>
                    </span>
                    <span className="mt-3 text-3xl font-bold tracking-tight text-slate-900 tabular-nums">{fmtNumber(p.credits)}</span>
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-400">SMS credits</span>
                    <span className="mt-4 text-lg font-semibold text-slate-900">{fmtMoney(p.price, p.currency)}</span>
                    <span className="text-xs text-slate-500">{fmtMoney(p.pricePerSms, p.currency)} per SMS{p.validityDays ? ` · valid ${p.validityDays} days` : ''}</span>
                  </button>
                );
              })}
            </div>
          )}

          <Card className="grid gap-6 p-6 lg:grid-cols-[1fr_340px]">
            <div className="space-y-4">
              <p className="text-sm font-semibold text-slate-900">Payment method</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {([
                  ['MOBILE_MONEY', 'Mobile money', Smartphone, 'Approve the request on your phone'],
                  ['CARD', 'Card', CreditCard, 'Visa / Mastercard'],
                ] as const).map(([v, l, Icon, d]) => (
                  <label key={v} className={cn('flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition', method === v ? 'border-brand-300 bg-brand-50/50' : 'border-slate-200 hover:bg-slate-50')}>
                    <input type="radio" className="text-brand-600" checked={method === v} onChange={() => setMethod(v)} />
                    <Icon className="h-5 w-5 text-slate-500" />
                    <span><span className="block text-sm font-medium text-slate-900">{l}</span><span className="text-xs text-slate-500">{d}</span></span>
                  </label>
                ))}
              </div>
              {method === 'MOBILE_MONEY' && (
                <Field label="Mobile money number" hint="The payment request is sent to this number.">
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0788 123 456" className="max-w-xs" />
                </Field>
              )}
            </div>
            <div className="rounded-xl bg-slate-50 p-5 ring-1 ring-inset ring-slate-100">
              <p className="text-sm font-semibold text-slate-900">Order summary</p>
              {summary ? (
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between"><dt className="text-slate-500">{summary.label}</dt><dd className="tabular-nums">{fmtNumber(summary.credits)} credits</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Price per SMS</dt><dd className="tabular-nums">{fmtMoney(summary.unit, summary.currency)}</dd></div>
                  <div className="flex justify-between border-t border-slate-200 pt-2 font-semibold"><dt>Total</dt><dd className="tabular-nums">{fmtMoney(summary.total, summary.currency)}</dd></div>
                </dl>
              ) : (
                <p className="mt-3 text-sm text-slate-500">{effectiveMode === 'amount' ? 'Enter a quantity to see your price.' : 'Choose a package.'}</p>
              )}
              <Button className="mt-4 w-full" size="lg" loading={create.isPending} disabled={!canPay} onClick={() => create.mutate(undefined)}>
                {summary ? `Continue to payment · ${fmtMoney(summary.total, summary.currency)}` : 'Continue to payment'}
              </Button>
              <p className="mt-2 text-center text-[11px] text-slate-500">Credits are added only after the payment is confirmed. The price is set by the server and an invoice is issued automatically.</p>
            </div>
          </Card>
        </>
      )}
      <CheckoutModal payment={checkout?.payment ?? null} nextAction={checkout?.nextAction ?? null} simulation={!!checkout?.simulation} onClose={() => setCheckout(null)} />
    </div>
  );
}

// ── Transactions ────────────────────────────────────────────────────────

const TX_LABEL: Record<TxType, { label: string; color: 'green' | 'gray' | 'blue' | 'amber' | 'red' | 'violet' }> = {
  PURCHASE: { label: 'Purchase', color: 'green' },
  SMS_DEBIT: { label: 'SMS charge', color: 'gray' },
  REFUND: { label: 'Refund', color: 'blue' },
  ADMIN_CREDIT: { label: 'Credit (admin)', color: 'violet' },
  ADMIN_DEBIT: { label: 'Debit (admin)', color: 'amber' },
  ADJUSTMENT: { label: 'Adjustment', color: 'amber' },
  EXPIRATION: { label: 'Expiration', color: 'red' },
};
export { TX_LABEL };

export function TransactionsPage() {
  const { can } = usePermissions();
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: walletService.wallet });
  const q = useQuery({ queryKey: ['wallet', 'tx', { page, type }], queryFn: () => walletService.transactions({ page, limit: 20, type: type || undefined }), placeholderData: (p) => p });
  const [threshold, setThreshold] = useState<string>('');
  useEffect(() => {
    if (wallet.data) setThreshold(String(wallet.data.lowBalanceThreshold));
  }, [wallet.data]);
  const saveThreshold = useApiMutation(() => walletService.updateThreshold(Number(threshold)), { success: 'Low balance alert saved', invalidate: [['wallet'], ['reports']] });

  return (
    <div className="space-y-6">
      <PageHeader title="Transactions" description="Your complete, immutable credit ledger." breadcrumbs={[{ label: 'Wallet' }, { label: 'Transactions' }]} actions={can('wallet.purchase') && <LinkButton to="/app/wallet/buy">Buy SMS</LinkButton>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <StatCard label="Balance" icon={<Wallet />} value={fmtNumber(wallet.data?.balance)} loading={wallet.isLoading} hint="SMS credits" tone={wallet.data?.isLow ? 'amber' : 'brand'} />
        <StatCard label="Purchased this month" icon={<ArrowDownLeft />} tone="emerald" value={fmtNumber(wallet.data?.thisMonth.purchased)} loading={wallet.isLoading} />
        <Card>
          <p className="flex items-center gap-2 text-sm font-medium text-slate-500"><Bell className="h-4 w-4" /> Low balance alert</p>
          <p className="mt-1 text-xs text-slate-500">Notify me when my balance drops below:</p>
          <div className="mt-3 flex gap-2">
            <Input type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} disabled={!can('settings.update')} />
            {can('settings.update') && <Button variant="secondary" loading={saveThreshold.isPending} onClick={() => saveThreshold.mutate(undefined)}>Save</Button>}
          </div>
        </Card>
      </div>
      <Card padded={false}>
        <div className="flex items-center gap-3 border-b border-slate-100 p-4">
          <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-auto">
            <option value="">All types</option>
            {Object.entries(TX_LABEL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        </div>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'date', header: 'Date', cell: (t) => <span className="text-slate-500">{fmtDateTime(t.createdAt)}</span> },
            { key: 'type', header: 'Type', cell: (t) => <Badge color={TX_LABEL[t.type].color}>{TX_LABEL[t.type].label}</Badge> },
            { key: 'desc', header: 'Description', cell: (t) => <span className="block max-w-sm truncate">{t.description}</span> },
            { key: 'amount', header: 'Credits', className: 'text-right', headerClassName: 'text-right', cell: (t) => <span className={cn('font-semibold tabular-nums', t.amount > 0 ? 'text-emerald-600' : 'text-slate-800')}>{t.amount > 0 ? '+' : ''}{fmtNumber(t.amount)}</span> },
            { key: 'bal', header: 'Balance after', className: 'text-right', headerClassName: 'text-right', cell: (t) => <span className="tabular-nums text-slate-600">{fmtNumber(t.balanceAfter)}</span> },
            { key: 'ref', header: 'Reference', cell: (t) => <span className="font-mono text-[11px] text-slate-400">{t.reference.length > 28 ? `${t.reference.slice(0, 28)}…` : t.reference}</span> },
          ]}
          empty={<EmptyState icon={<Receipt />} title="No transactions yet" description="Purchases, SMS charges and refunds appear here." />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

// ── Payments ────────────────────────────────────────────────────────────

export function PaymentsPage() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['payments', page], queryFn: () => paymentService.list({ page, limit: 20 }), placeholderData: (p) => p });
  const [checkout, setCheckout] = useState<Payment | null>(null);
  const verify = useApiMutation((id: string) => paymentService.verify(id), { invalidate: [['payments'], ['wallet']], success: (p) => `Payment status: ${p.status.toLowerCase()}` });
  const cancel = useApiMutation((id: string) => paymentService.cancel(id), { invalidate: [['payments']], success: 'Payment cancelled' });
  return (
    <div className="space-y-6">
      <PageHeader title="Payments" description="Every purchase attempt and its verified status." breadcrumbs={[{ label: 'Wallet' }, { label: 'Payments' }]} actions={<LinkButton to="/app/wallet/buy">Buy SMS</LinkButton>} />
      <Card padded={false}>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          columns={[
            { key: 'ref', header: 'Reference', cell: (p) => <span className="font-mono text-xs">{p.reference}</span> },
            {
              key: 'pkg',
              header: 'Purchase',
              cell: (p) => (
                <span>
                  {p.unitPrice ? `Purchased ${fmtNumber(p.credits)} SMS` : p.packageName}
                  <span className="block text-xs text-slate-500">{p.unitPrice ? `${fmtMoney(p.unitPrice, p.currency)} per SMS` : `${fmtNumber(p.credits)} credits`}</span>
                </span>
              ),
            },
            { key: 'amount', header: 'Amount', cell: (p) => <span className="font-medium tabular-nums">{fmtMoney(p.amount, p.currency)}</span> },
            { key: 'method', header: 'Method', cell: (p) => titleCase(p.method) },
            { key: 'status', header: 'Status', cell: (p) => <span title={p.failureReason ?? undefined}><StatusBadge status={p.status} /></span> },
            { key: 'date', header: 'Date', cell: (p) => <span className="text-slate-500">{fmtDateTime(p.createdAt)}</span> },
            {
              key: 'act',
              header: '',
              className: 'text-right',
              cell: (p) =>
                p.invoice ? (
                  <Link to={`/app/wallet/invoices/${p.invoice.id}`} className="link text-xs">{p.invoice.number}</Link>
                ) : p.status === 'PROCESSING' ? (
                  <span className="flex justify-end gap-1">
                    {p.provider === 'simulation' && <Button size="xs" onClick={() => setCheckout(p)}>Continue</Button>}
                    <Button size="xs" variant="secondary" loading={verify.isPending && verify.variables === p.id} onClick={() => verify.mutate(p.id)}>Check</Button>
                    <Button size="xs" variant="ghost" onClick={() => cancel.mutate(p.id)}>Cancel</Button>
                  </span>
                ) : null,
            },
          ]}
          empty={<EmptyState icon={<CreditCard />} title="No payments yet" action={<LinkButton to="/app/wallet/buy">Buy SMS</LinkButton>} />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
      <CheckoutModal payment={checkout} nextAction={null} simulation={checkout?.provider === 'simulation'} onClose={() => { setCheckout(null); void q.refetch(); }} />
    </div>
  );
}

// ── Invoices ────────────────────────────────────────────────────────────

export function InvoicesPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['invoices', page], queryFn: () => invoiceService.list({ page, limit: 20 }) });
  return (
    <div className="space-y-6">
      <PageHeader title="Invoices" description="Issued automatically for every verified payment." breadcrumbs={[{ label: 'Wallet' }, { label: 'Invoices' }]} />
      <Card padded={false}>
        <DataTable
          rows={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          onRowClick={(i) => navigate(`/app/wallet/invoices/${i.id}`)}
          columns={[
            { key: 'no', header: 'Invoice', cell: (i) => <span className="font-mono font-medium text-slate-900">{i.number}</span> },
            { key: 'desc', header: 'Description', cell: (i) => i.description },
            { key: 'total', header: 'Total', cell: (i) => <span className="font-medium tabular-nums">{fmtMoney(i.total, i.currency)}</span> },
            { key: 'status', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
            { key: 'date', header: 'Issued', cell: (i) => fmtDate(i.issuedAt) },
          ]}
          empty={<EmptyState icon={<FileText />} title="No invoices yet" description="Invoices appear after your first successful purchase." />}
        />
        <Pagination pagination={q.data?.pagination} onPage={setPage} />
      </Card>
    </div>
  );
}

export function InvoiceView({ id, fetcher, back, onDownload }: { id: string; fetcher: (id: string) => ReturnType<typeof invoiceService.get>; back: string; onDownload?: (id: string, number: string) => Promise<void> }) {
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => fetcher(id) });
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const i = q.data;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <LinkButton to={back} variant="ghost">← Back</LinkButton>
        <div className="flex gap-2">
          {onDownload && <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => onDownload(i.id, i.number)}>Download PDF</Button>}
          <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>Print</Button>
        </div>
      </div>
      <Card className="mx-auto max-w-3xl p-8 sm:p-12 print:border-0 print:shadow-none">
        <div className="flex flex-col justify-between gap-6 sm:flex-row">
          <div>
            <p className="text-2xl font-bold tracking-tight text-slate-900">INVOICE</p>
            <p className="mt-1 font-mono text-sm text-slate-500">{i.number}</p>
            <div className="mt-3"><StatusBadge status={i.status} /></div>
          </div>
          <div className="text-sm sm:text-right">
            <p className="font-semibold text-slate-900">{i.issuer?.name}</p>
            <p className="text-slate-500">{i.issuer?.address}</p>
            <p className="mt-3 text-slate-500">Issued {fmtDate(i.issuedAt)}</p>
          </div>
        </div>
        <div className="mt-10 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Billed to</p>
            <p className="mt-2 font-medium text-slate-900">{i.customerName}</p>
            {i.billingAddress && <p className="text-sm text-slate-600">{i.billingAddress}</p>}
            {i.customerEmail && <p className="text-sm text-slate-600">{i.customerEmail}</p>}
            {i.taxId && <p className="text-sm text-slate-600">TIN: {i.taxId}</p>}
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Payment</p>
            <p className="mt-2 font-mono text-sm text-slate-700">{i.payment.reference}</p>
            <p className="text-sm text-slate-600">{titleCase(i.payment.method)} · {titleCase(i.payment.status)}</p>
          </div>
        </div>
        <table className="mt-10 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="pb-3 font-semibold">Description</th>
              <th className="pb-3 text-right font-semibold">Qty</th>
              <th className="pb-3 text-right font-semibold">Unit price</th>
              <th className="pb-3 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-100">
              <td className="py-4 text-slate-900">{i.description}</td>
              <td className="py-4 text-right tabular-nums">{fmtNumber(i.quantity)}</td>
              <td className="py-4 text-right tabular-nums">{fmtMoney(i.unitPrice, i.currency)}</td>
              <td className="py-4 text-right tabular-nums">{fmtMoney(i.subtotal, i.currency)}</td>
            </tr>
          </tbody>
        </table>
        <div className="ml-auto mt-6 w-full max-w-xs space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="tabular-nums">{fmtMoney(i.subtotal, i.currency)}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Tax ({Number(i.taxRate)}%)</span><span className="tabular-nums">{fmtMoney(i.taxAmount, i.currency)}</span></div>
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold"><span>Total</span><span className="tabular-nums">{fmtMoney(i.total, i.currency)}</span></div>
        </div>
        <p className="mt-12 text-center text-xs text-slate-400">Thank you for your business.</p>
      </Card>
    </div>
  );
}

export function InvoicePage() {
  const { id } = useParams();
  return <InvoiceView id={id!} fetcher={invoiceService.get} back="/app/wallet/invoices" onDownload={invoiceService.downloadPdf} />;
}
