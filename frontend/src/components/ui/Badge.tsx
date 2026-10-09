import type { ReactNode } from 'react';
import { cn, titleCase } from '@/utils/format';

const colors = {
  // Neutral for draft/disabled/unknown, green for healthy/done, amber for in-progress, red for failures.
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-white text-slate-800 ring-slate-300',
  violet: 'bg-slate-100 text-slate-700 ring-slate-200',
  green: 'bg-accent-100 text-accent-700 ring-accent-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200/80',
  red: 'bg-red-50 text-red-700 ring-red-200/70',
  sky: 'bg-slate-100 text-slate-700 ring-slate-200',
} as const;
export type BadgeColor = keyof typeof colors;

export function Badge({ color = 'gray', children, dot, className }: { color?: BadgeColor; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', colors[color], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

const STATUS_COLORS: Record<string, BadgeColor> = {
  ACTIVE: 'green',
  APPROVED: 'green',
  DELIVERED: 'green',
  SUCCESS: 'green',
  COMPLETED: 'green',
  PAID: 'green',
  ACCEPTED: 'green',
  SENT: 'gray',
  PROCESSING: 'amber',
  QUEUED: 'amber',
  SCHEDULED: 'gray',
  SUBMITTED: 'gray',
  UNDER_REVIEW: 'amber',
  RETRYING: 'amber',
  PENDING: 'amber',
  PENDING_REVIEW: 'amber',
  PENDING_EMAIL_VERIFICATION: 'amber',
  NEEDS_INFORMATION: 'amber',
  MORE_INFORMATION_REQUIRED: 'amber',
  NEW: 'blue',
  HANDLED: 'green',
  INACTIVE: 'gray',
  MAINTENANCE: 'amber',
  LOW: 'amber',
  EMPTY: 'red',
  OK: 'green',
  REPLACEMENT_REQUESTED: 'amber',
  PARTIALLY_COMPLETED: 'amber',
  DRAFT: 'gray',
  CANCELLED: 'gray',
  EXPIRED: 'gray',
  REVOKED: 'gray',
  DEACTIVATED: 'gray',
  DISABLED: 'gray',
  UNSUBSCRIBED: 'gray',
  REFUNDED: 'gray',
  FAILED: 'red',
  REJECTED: 'red',
  SUSPENDED: 'red',
  BLOCKED: 'red',
  VOID: 'red',
};

const LABELS: Record<string, string> = {
  PENDING_EMAIL_VERIFICATION: 'Email unverified',
  PENDING_REVIEW: 'Pending review',
  PARTIALLY_COMPLETED: 'Partially delivered',
  NEEDS_INFORMATION: 'Needs info',
  MORE_INFORMATION_REQUIRED: 'More info required',
  REPLACEMENT_REQUESTED: 'Replace',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge color={STATUS_COLORS[status] ?? 'gray'} dot className={className}>
      {LABELS[status] ?? titleCase(status)}
    </Badge>
  );
}
