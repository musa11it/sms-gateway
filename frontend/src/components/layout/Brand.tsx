import { cn } from '@/utils/format';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('h-8 w-8', className)} aria-hidden>
      <defs>
        <linearGradient id="lm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#lm)" />
      <path d="M9 11.5A3.5 3.5 0 0 1 12.5 8h7A3.5 3.5 0 0 1 23 11.5v5a3.5 3.5 0 0 1-3.5 3.5H15l-4 3.5V20a3.5 3.5 0 0 1-2-3.2z" fill="#fff" />
      <circle cx="13" cy="14" r="1.3" fill="#6366f1" />
      <circle cx="16" cy="14" r="1.3" fill="#6366f1" />
      <circle cx="19" cy="14" r="1.3" fill="#6366f1" />
    </svg>
  );
}

export function Logo({ dark, suffix }: { dark?: boolean; suffix?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark />
      <span className={cn('text-[15px] font-semibold tracking-tight', dark ? 'text-white' : 'text-slate-900')}>
        SMS Gateway
        {suffix && <span className={cn('ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider', dark ? 'bg-white/10 text-violet-200' : 'bg-brand-50 text-brand-700')}>{suffix}</span>}
      </span>
    </span>
  );
}
