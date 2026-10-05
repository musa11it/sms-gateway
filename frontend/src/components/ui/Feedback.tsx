import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { cn } from '@/utils/format';
import { Button } from './Button';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-brand-600', className)} />;
}

export function PageLoader() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner className="h-7 w-7" />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-200/70', className)} />;
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-slate-100">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-5 py-3.5">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cn('h-4', c === 0 ? 'w-40' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && (
        <div className="relative mb-4">
          <div className="absolute inset-0 -m-3 rounded-full bg-brand-100/50 blur-xl" />
          <div className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-violet-50 text-brand-600 ring-1 ring-brand-100 [&>svg]:h-6 [&>svg]:w-6">
            {icon}
          </div>
        </div>
      )}
      <h3 className="text-[15px] font-semibold text-slate-900">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-red-600">
        <AlertCircle className="h-5 w-5" />
      </div>
      <p className="text-sm font-semibold text-slate-900">Couldn’t load this data</p>
      <p className="mt-1 max-w-sm text-sm text-slate-500">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry} icon={<RefreshCw className="h-3.5 w-3.5" />}>
          Try again
        </Button>
      )}
    </div>
  );
}

const alertTones = {
  info: { cls: 'bg-brand-50/70 text-brand-900 ring-brand-200/70', icon: Info, iconCls: 'text-brand-600' },
  success: { cls: 'bg-emerald-50 text-emerald-900 ring-emerald-200/70', icon: CheckCircle2, iconCls: 'text-emerald-600' },
  warning: { cls: 'bg-amber-50 text-amber-900 ring-amber-200/80', icon: TriangleAlert, iconCls: 'text-amber-600' },
  danger: { cls: 'bg-red-50 text-red-900 ring-red-200/70', icon: AlertCircle, iconCls: 'text-red-600' },
};

export function Alert({ tone = 'info', title, children, action, className }: { tone?: keyof typeof alertTones; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const t = alertTones[tone];
  const Icon = t.icon;
  return (
    <div className={cn('flex gap-3 rounded-xl p-4 ring-1 ring-inset', t.cls, className)}>
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', t.iconCls)} />
      <div className="min-w-0 flex-1 text-sm">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn('leading-relaxed opacity-90', title && 'mt-0.5')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
