import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Compass, FlaskConical, Inbox, RefreshCw } from 'lucide-react';
import { Logo } from '@/components/layout/Brand';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Input } from '@/components/ui/Form';
import { authService } from '@/services/authService';
import { cn, fmtRelative } from '@/utils/format';

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState icon={<Compass />} title="Page not found" description="The page you’re looking for doesn’t exist or has moved." action={<LinkButton to="/start">Go to dashboard</LinkButton>} />
    </div>
  );
}

/** Development-only viewer for the email outbox (no real email delivery in dev). */
export function DevMailboxPage() {
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['dev-mailbox', to], queryFn: () => authService.devMailbox(to || undefined), refetchInterval: 5000, retry: false });
  const email = q.data?.find((e) => e.id === selected) ?? q.data?.[0];
  const linkify = (text: string) =>
    text.split(/(https?:\/\/\S+)/g).map((part, i) =>
      /^https?:\/\//.test(part) ? (
        <a key={i} href={part.replace(/^https?:\/\/[^/]+/, '')} className="break-all font-medium text-brand-600 underline">
          {part}
        </a>
      ) : (
        <span key={i}>{part}</span>
      ),
    );
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Logo suffix="Dev outbox" />
          <Button variant="ghost" size="sm" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void q.refetch()}>Refresh</Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 px-6 py-6">
        <Alert tone="warning" title="Development only">
          <span className="flex items-center gap-2"><FlaskConical className="h-4 w-4" /> The mail driver is set to <code>log</code>: emails and phone verification codes are stored in the outbox and shown here instead of being delivered.</span>
        </Alert>
        <Input placeholder="Filter by recipient…" value={to} onChange={(e) => setTo(e.target.value)} className="max-w-sm" />
        {q.isLoading ? (
          <PageLoader />
        ) : q.error ? (
          <Card><ErrorState error={q.error} /></Card>
        ) : !q.data?.length ? (
          <Card><EmptyState icon={<Inbox />} title="No emails yet" description="Register an account or request a password reset to see emails here." /></Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
            <Card padded={false} className="max-h-[70vh] overflow-y-auto">
              {q.data.map((e) => (
                <button key={e.id} onClick={() => setSelected(e.id)} className={cn('block w-full border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50', email?.id === e.id && 'bg-brand-50/60')}>
                  <p className="truncate text-sm font-medium text-slate-900">{e.subject}</p>
                  <p className="truncate text-xs text-slate-500">To {e.to} · {fmtRelative(e.createdAt)}</p>
                </button>
              ))}
            </Card>
            {email && (
              <Card>
                <p className="text-lg font-semibold text-slate-900">{email.subject}</p>
                <p className="mt-1 text-sm text-slate-500">To: {email.to}</p>
                <div className="mt-6 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{linkify(email.text)}</div>
              </Card>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
