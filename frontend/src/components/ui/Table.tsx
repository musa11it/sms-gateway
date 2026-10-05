import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Pagination as PaginationT } from '@/api/types';
import { cn, fmtNumber } from '@/utils/format';
import { ErrorState, TableSkeleton } from './Feedback';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
}

/**
 * Data table with loading, error and empty states. On small screens it scrolls horizontally.
 */
export function DataTable<T extends { id: string }>({
  columns,
  rows,
  loading,
  error,
  onRetry,
  empty,
  onRowClick,
  rowClassName,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
}) {
  if (loading) return <TableSkeleton cols={Math.min(columns.length, 5)} />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!rows || rows.length === 0) return <>{empty}</>;
  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200/80 bg-slate-50/70">
            {columns.map((c) => (
              <th key={c.key} className={cn('whitespace-nowrap px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500', c.headerClassName)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn('transition-colors', onRowClick && 'cursor-pointer hover:bg-slate-50/80', rowClassName?.(row))}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn('whitespace-nowrap px-5 py-3 text-slate-700', c.className)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ pagination, onPage }: { pagination?: PaginationT; onPage: (p: number) => void }) {
  if (!pagination || pagination.total === 0) return null;
  const { page, limit, total, totalPages } = pagination;
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  return (
    <div className="flex items-center justify-between gap-4 border-t border-slate-100 px-5 py-3 text-sm text-slate-500">
      <span>
        <span className="font-medium text-slate-700">{fmtNumber(from)}</span>–<span className="font-medium text-slate-700">{fmtNumber(to)}</span> of{' '}
        <span className="font-medium text-slate-700">{fmtNumber(total)}</span>
      </span>
      <div className="flex items-center gap-1">
        <button
          className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 disabled:opacity-40"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft className="h-4 w-4" /> Prev
        </button>
        <span className="px-2 tabular-nums">
          {page} / {totalPages}
        </span>
        <button
          className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 disabled:opacity-40"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
