import { clsx, type ClassValue } from 'clsx';
import { format, formatDistanceToNowStrict, isValid } from 'date-fns';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fmtNumber = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US');

/** Money arrives from the API as a decimal string — format it without float arithmetic. */
export function fmtMoney(amount: string | null | undefined, currency = 'RWF') {
  if (amount == null) return '—';
  const [int, frac = ''] = amount.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (frac + '00').slice(0, 2);
  return `${currency} ${grouped}${cents !== '00' ? `.${cents}` : ''}`;
}

export function fmtDate(d: string | Date | null | undefined, pattern = 'MMM d, yyyy') {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return isValid(date) ? format(date, pattern) : '—';
}

export const fmtDateTime = (d: string | Date | null | undefined) => fmtDate(d, 'MMM d, yyyy · HH:mm');

export function fmtRelative(d: string | Date | null | undefined) {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return isValid(date) ? `${formatDistanceToNowStrict(date)} ago` : '—';
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export const titleCase = (s: string) =>
  s
    .toLowerCase()
    .split(/[_\s.]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

export function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
