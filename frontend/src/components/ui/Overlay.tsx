import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '@/utils/format';
import { Button } from './Button';
import { Field, Textarea } from './Form';

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', h);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  useEscape(open, onClose);
  if (!open) return null;
  const widths = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 animate-fade-in bg-slate-900/40" onClick={onClose} />
      <div role="dialog" aria-modal className={cn('relative flex max-h-[92vh] w-full animate-slide-up flex-col rounded-t-2xl bg-white shadow-pop sm:rounded-2xl', widths[size])}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          <button onClick={onClose} className="-mr-2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="scrollbar-thin overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex flex-col-reverse gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-3.5 sm:flex-row sm:justify-end sm:rounded-b-2xl">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, description, children, footer, width = 'max-w-xl' }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 animate-fade-in bg-slate-900/30" onClick={onClose} />
      <aside className={cn('absolute inset-y-0 right-0 flex w-full animate-slide-in-right flex-col bg-white shadow-pop', width)}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          <button onClick={onClose} className="-mr-2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-3.5">{footer}</div>}
      </aside>
    </div>,
    document.body,
  );
}

/**
 * Confirmation dialog. With `requireReason`, collects a note that is passed to onConfirm
 * (used for rejections, suspensions, refunds...).
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  tone = 'danger',
  loading,
  requireReason,
  reasonLabel = 'Reason',
  reasonPlaceholder,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason?: string) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary' | 'success';
  loading?: boolean;
  requireReason?: boolean | 'optional';
  reasonLabel?: string;
  reasonPlaceholder?: string;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const reasonMissing = requireReason === true && reason.trim().length < 3;
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          {tone === 'danger' && (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-red-50 text-red-600">
              <AlertTriangle className="h-4 w-4" />
            </span>
          )}
          {title}
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant={tone} onClick={() => onConfirm(reason.trim() || undefined)} loading={loading} disabled={reasonMissing}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && <div className="text-sm leading-relaxed text-slate-600">{description}</div>}
      {requireReason && (
        <Field label={reasonLabel} className="mt-4" required={requireReason === true}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonPlaceholder} rows={3} autoFocus />
        </Field>
      )}
    </Modal>
  );
}
