import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { cn } from '@/utils/format';

export function Card({ className, children, padded = true }: { className?: string; children: ReactNode; padded?: boolean }) {
  return <div className={cn('card min-w-0', padded && 'p-5', className)}>{children}</div>;
}

export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4', className)}>
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-slate-500">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

const tones = {
  brand: 'text-slate-400',
  violet: 'text-slate-400',
  emerald: 'text-accent-600',
  amber: 'text-amber-600',
  red: 'text-red-600',
  slate: 'text-slate-400',
  sky: 'text-slate-400',
};
export type Tone = keyof typeof tones;

export function StatCard({
  label,
  value,
  icon,
  tone = 'brand',
  hint,
  trend,
  loading,
  className,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  hint?: ReactNode;
  trend?: { value: number; label?: string } | null;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('card relative overflow-hidden p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        {icon && <span className={cn('shrink-0 [&>svg]:h-4 [&>svg]:w-4', tones[tone])}>{icon}</span>}
      </div>
      {loading ? (
        <div className="mt-2 h-8 w-24 animate-pulse rounded-md bg-slate-100" />
      ) : (
        <p className="mt-1.5 text-[28px] font-semibold leading-tight tracking-tight text-slate-900 tabular-nums">{value}</p>
      )}
      <div className="mt-1 flex items-center gap-2 text-[13px] text-slate-500">
        {trend && (
          <span className={cn('inline-flex items-center font-medium', trend.value >= 0 ? 'text-accent-700' : 'text-red-600')}>
            {trend.value >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
            {Math.abs(trend.value)}%
          </span>
        )}
        {hint}
      </div>
    </div>
  );
}
