import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { cn } from '@/utils/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
type Size = 'xs' | 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700 focus-visible:ring-accent-500/40',
  secondary: 'bg-white text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:ring-accent-500/40',
  outline: 'bg-transparent text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500/30',
  success: 'bg-accent-200 text-accent-700 hover:bg-accent-300 focus-visible:ring-accent-500/40',
};
const sizes: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-xs gap-1 rounded-lg',
  sm: 'h-8 px-3 text-sm gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-base gap-2 rounded-lg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const buttonClass = (variant: Variant = 'primary', size: Size = 'md', className?: string) =>
  cn(
    'inline-flex items-center justify-center whitespace-nowrap font-medium transition duration-150 focus:outline-none focus-visible:ring-4 disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    sizes[size],
    className,
  );

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) => (
  <button ref={ref} className={buttonClass(variant, size, className)} disabled={disabled || loading} {...rest}>
    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
    {children}
  </button>
));
Button.displayName = 'Button';

export function LinkButton({ to, variant = 'primary', size = 'md', icon, className, children }: { to: string; variant?: Variant; size?: Size; icon?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Link to={to} className={buttonClass(variant, size, className)}>
      {icon}
      {children}
    </Link>
  );
}

export function IconButton({ className, label, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn('inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40', className)}
      {...rest}
    />
  );
}
