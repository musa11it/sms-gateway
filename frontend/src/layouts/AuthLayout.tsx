import type { ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Logo } from '@/components/layout/Brand';

const highlights = [
  'Approved sender IDs and verified businesses only',
  'Real-time delivery reports for every message',
  'Transparent, prepaid SMS credits with full ledger',
  'Developer API, webhooks and API keys',
];

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_minmax(0,560px)] xl:grid-cols-[1fr_minmax(0,620px)]">
      <div className="relative hidden overflow-hidden bg-ink-950 lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_10%,rgba(99,102,241,0.45),transparent_50%),radial-gradient(ellipse_at_80%_90%,rgba(124,58,237,0.35),transparent_50%)]" />
        <div className="bg-grid absolute inset-0 opacity-[0.15]" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <Logo dark />
          <div className="max-w-md">
            <h2 className="text-4xl font-semibold leading-tight tracking-tight text-white">Reach every customer, reliably.</h2>
            <p className="mt-4 text-base leading-relaxed text-slate-300">
              Send transactional messages and campaigns, track delivery in real time, and integrate SMS into your products with a clean API.
            </p>
            <ul className="mt-8 space-y-3">
              {highlights.map((h) => (
                <li key={h} className="flex items-center gap-3 text-sm text-slate-200">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
                  {h}
                </li>
              ))}
            </ul>
          </div>
          <div className="grid max-w-md grid-cols-3 gap-4 rounded-2xl bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur">
            {[
              ['Unicode', 'Segment-aware pricing'],
              ['REST API', 'Keys & webhooks'],
              ['Audited', 'Every sensitive action'],
            ].map(([v, l]) => (
              <div key={l}>
                <p className="text-xl font-semibold text-white">{v}</p>
                <p className="text-xs text-slate-400">{l}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-col bg-white">
        <div className="flex flex-1 flex-col justify-center px-6 py-10 sm:px-12">
          <div className="mx-auto w-full max-w-[400px]">
            <div className="mb-8 lg:hidden">
              <Logo />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
            {subtitle && <p className="mt-2 text-sm text-slate-500">{subtitle}</p>}
            <div className="mt-8">{children}</div>
            {footer && <div className="mt-8 text-center text-sm text-slate-500">{footer}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
