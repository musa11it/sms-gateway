import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn, initials } from '@/utils/format';

export function PageHeader({ title, description, actions, breadcrumbs, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumbs?: { label: string; to?: string }[]; className?: string }) {
  return (
    <div className={cn('mb-6', className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="mb-2 flex items-center gap-1 text-xs font-medium text-slate-500">
          {breadcrumbs.map((b, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 text-slate-300" />}
              {b.to ? (
                <Link to={b.to} className="hover:text-slate-800">
                  {b.label}
                </Link>
              ) : (
                <span className="text-slate-700">{b.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cn('scrollbar-thin flex gap-1 overflow-x-auto border-b border-slate-200', className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            '-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition',
            value === t.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800',
          )}
        >
          {t.label}
          {t.count !== undefined && (
            <span className={cn('rounded-full px-1.5 py-px text-[11px] tabular-nums', value === t.value ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-600')}>{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function SegmentedControl<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5 ring-1 ring-inset ring-slate-200/60">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn('rounded-md px-3 py-1 text-xs font-medium transition', value === o.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success('Copied to clipboard');
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error('Could not copy');
        }
      }}
      className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800', className)}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

export function CodeBlock({ code, language, className }: { code: string; language?: string; className?: string }) {
  return (
    <div className={cn('group relative overflow-hidden rounded-xl bg-ink-950 ring-1 ring-white/10', className)}>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-400">{language}</span>
        <CopyButton value={code} className="text-slate-400 hover:bg-white/10 hover:text-white" />
      </div>
      <pre className="scrollbar-thin overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-slate-200">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Avatar({ name, size = 'md', className }: { name: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const s = { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-xs', lg: 'h-12 w-12 text-sm' }[size];
  return <span className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-violet-600 font-semibold text-white', s, className)}>{initials(name) || '?'}</span>;
}

/** Click-outside dropdown menu. */
export function Dropdown({ trigger, children, align = 'right', className }: { trigger: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div className={cn('absolute z-40 mt-2 min-w-[200px] animate-slide-up rounded-xl bg-white p-1 shadow-pop ring-1 ring-slate-200', align === 'right' ? 'right-0' : 'left-0', className)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, danger, to }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; to?: string }) {
  const cls = cn(
    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition [&>svg]:h-4 [&>svg]:w-4',
    danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-100',
  );
  if (to)
    return (
      <Link to={to} className={cls} onClick={onClick}>
        {icon}
        {children}
      </Link>
    );
  return (
    <button className={cls} onClick={onClick}>
      {icon}
      {children}
    </button>
  );
}

export function DescriptionList({ items, className }: { items: { label: string; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2', className)}>
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{i.label}</dt>
          <dd className="mt-1 break-words text-sm text-slate-900">{i.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ProgressBar({ value, className, tone = 'brand' }: { value: number; className?: string; tone?: 'brand' | 'emerald' | 'amber' | 'red' }) {
  const c = { brand: 'bg-brand-600', emerald: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500' }[tone];
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-slate-100', className)}>
      <div className={cn('h-full rounded-full transition-all', c)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
