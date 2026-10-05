import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  BellRing,
  Building,
  Check,
  ChevronDown,
  Code2,
  Contact,
  GraduationCap,
  HeartHandshake,
  HeartPulse,
  KeyRound,
  Landmark,
  LineChart,
  Lock,
  Megaphone,
  Menu,
  MessagesSquare,
  PartyPopper,
  Send,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  Users,
  UtensilsCrossed,
  Wallet,
  Webhook,
  X,
} from 'lucide-react';
import { errorMessage } from '@/api/client';
import { Logo } from '@/components/layout/Brand';
import { Button, LinkButton } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Form';
import { useAuthStore } from '@/stores/authStore';
import { siteService } from '@/services/businessService';
import { cn, fmtMoney, fmtNumber } from '@/utils/format';

const NAV = [
  ['Services', '#services'],
  ['How it works', '#how'],
  ['Pricing', '#pricing'],
  ['Developers', '#developers'],
  ['FAQ', '#faq'],
  ['Contact', '#contact'],
];

function SiteHeader() {
  const [open, setOpen] = useState(false);
  const loggedIn = !!useAuthStore((s) => s.accessToken);
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link to="/"><Logo /></Link>
        <nav className="hidden items-center gap-7 text-sm font-medium text-slate-600 lg:flex">
          {NAV.map(([l, h]) => <a key={h} href={h} className="hover:text-slate-900">{l}</a>)}
        </nav>
        <div className="hidden items-center gap-2 lg:flex">
          {loggedIn ? (
            <LinkButton to="/start">Go to dashboard</LinkButton>
          ) : (
            <>
              <LinkButton to="/login" variant="ghost">Log in</LinkButton>
              <LinkButton to="/register">Get started</LinkButton>
            </>
          )}
        </div>
        <button className="rounded-lg p-2 text-slate-600 lg:hidden" onClick={() => setOpen(!open)} aria-label="Menu">{open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
      </div>
      {open && (
        <div className="border-t border-slate-100 bg-white px-4 py-4 lg:hidden">
          <nav className="flex flex-col gap-3 text-sm font-medium text-slate-700">
            {NAV.map(([l, h]) => <a key={h} href={h} onClick={() => setOpen(false)}>{l}</a>)}
          </nav>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <LinkButton to="/login" variant="secondary">Log in</LinkButton>
            <LinkButton to="/register">Get started</LinkButton>
          </div>
        </div>
      )}
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-4">
        <div className="md:col-span-1">
          <Logo />
          <p className="mt-4 text-sm leading-relaxed text-slate-500">SMS management and messaging for businesses, organizations and developers.</p>
        </div>
        {[
          ['Product', [['Services', '/#services'], ['Pricing', '/#pricing'], ['Developers', '/#developers'], ['Documentation', '/app/developer/docs']]],
          ['Company', [['About', '/#about'], ['Contact', '/#contact'], ['FAQ', '/#faq']]],
          ['Account', [['Log in', '/login'], ['Register', '/register'], ['Privacy policy', '/privacy'], ['Terms of service', '/terms']]],
        ].map(([title, links]) => (
          <div key={title as string}>
            <p className="text-sm font-semibold text-slate-900">{title as string}</p>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-500">
              {(links as string[][]).map(([l, h]) => (
                <li key={l}>{h.startsWith('/#') ? <a href={h} className="hover:text-slate-900">{l}</a> : <Link to={h} className="hover:text-slate-900">{l}</Link>}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-slate-100 py-6 text-center text-xs text-slate-400">© {new Date().getFullYear()} SMS Gateway. All rights reserved.</div>
    </footer>
  );
}

function Section({ id, eyebrow, title, subtitle, children, className }: { id?: string; eyebrow?: string; title: string; subtitle?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn('scroll-mt-20 py-20 sm:py-24', className)}>
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          {eyebrow && <p className="text-sm font-semibold uppercase tracking-wider text-brand-600">{eyebrow}</p>}
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{title}</h2>
          {subtitle && <p className="mt-4 text-base leading-relaxed text-slate-600">{subtitle}</p>}
        </div>
        <div className="mt-14">{children}</div>
      </div>
    </section>
  );
}

function HeroMock() {
  return (
    <div className="relative mx-auto w-full max-w-xl">
      <div className="absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-brand-500/20 via-violet-500/10 to-transparent blur-2xl" />
      <div className="relative overflow-hidden rounded-2xl bg-white shadow-pop ring-1 ring-slate-200">
        <div className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-300" /><span className="h-2.5 w-2.5 rounded-full bg-amber-300" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
          <span className="ml-3 text-xs text-slate-400">New campaign</span>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-[1fr_180px]">
          <div className="space-y-3">
            <div><p className="text-[11px] font-medium text-slate-500">Sender ID</p><div className="mt-1 rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm">YOURBRAND</div></div>
            <div><p className="text-[11px] font-medium text-slate-500">Audience</p><div className="mt-1 flex flex-wrap gap-1.5">{['Customers', 'VIP', 'Subscribers'].map((g) => <span key={g} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 ring-1 ring-brand-100">{g}</span>)}</div></div>
            <div><p className="text-[11px] font-medium text-slate-500">Message</p><div className="mt-1 rounded-lg border border-slate-200 p-3 text-sm text-slate-700">Hi! Your order is ready for pickup. Show this SMS at the counter. Thank you!</div><p className="mt-1 text-right text-[11px] text-slate-400">76 chars · 1 segment</p></div>
            <div className="flex gap-2"><span className="flex-1 rounded-lg bg-gradient-to-b from-brand-500 to-brand-600 py-2 text-center text-sm font-medium text-white">Send now</span><span className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600">Schedule</span></div>
          </div>
          <div className="hidden rounded-[1.4rem] bg-slate-900 p-1.5 sm:block">
            <div className="h-full rounded-[1.1rem] bg-slate-50 p-2.5">
              <p className="text-center text-[10px] font-medium text-slate-500">YOURBRAND</p>
              <div className="mt-3 rounded-xl rounded-bl-sm bg-white p-2 text-[11px] leading-snug text-slate-700 shadow-sm">Hi! Your order is ready for pickup. Show this SMS at the counter. Thank you!</div>
              <p className="mt-2 flex items-center gap-1 text-[10px] text-emerald-600"><Check className="h-3 w-3" /> Delivered</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const FEATURES = [
  [Send, 'Mass SMS', 'Send one message to thousands of recipients, with numbers validated and de-duplicated automatically.'],
  [Megaphone, 'SMS campaigns', 'Target contact groups, send now or schedule for later — our servers handle delivery.'],
  [ShieldCheck, 'Sender IDs', 'Send under your own approved brand name so customers instantly recognise you.'],
  [Contact, 'Contact management', 'Organise contacts in groups, import from CSV with validation, and honour opt-outs.'],
  [Code2, 'Developer API', 'A clean REST API with API keys, idempotency and signed webhooks.'],
  [LineChart, 'Delivery reports', 'Follow every message from queued to delivered, with failure reasons when it does not arrive.'],
  [Wallet, 'SMS wallet', 'Prepaid credits with a full transaction history, invoices and low-balance alerts.'],
  [BarChart3, 'Business analytics', 'Volume, delivery and spending reports for any period.'],
] as const;

const USE_CASES = [
  [UtensilsCrossed, 'Restaurants', 'Order-ready alerts and reservations'],
  [GraduationCap, 'Schools & universities', 'Parent notices, exam and fee reminders'],
  [HeartHandshake, 'NGOs', 'Community outreach and field coordination'],
  [Store, 'Shops & e-commerce', 'Order updates and promotions to opted-in customers'],
  [Landmark, 'Financial businesses', 'Account notifications and reminders'],
  [HeartPulse, 'Healthcare organizations', 'Appointment reminders'],
  [Building, 'Institutions', 'Public announcements and alerts'],
  [PartyPopper, 'Events', 'Tickets, schedules and last-minute changes'],
  [ShoppingBag, 'Online platforms', 'One-time codes and account alerts via the API'],
] as const;

const FAQS = [
  ['How quickly can I start sending?', 'Create an account, verify your email and submit your business details. Once our team approves your business and your sender ID, you can buy credits and send immediately.'],
  ['Why do you verify businesses?', 'Verification protects recipients from scams and spam and keeps sender names trustworthy. Every sender ID is reviewed before it can be used.'],
  ['How is SMS cost calculated?', 'One credit covers one SMS segment to one recipient. Standard messages fit 160 characters per segment (153 when split); messages with emoji or special characters use 70 (67). The platform calculates cost before you send.'],
  ['Do credits expire?', 'Each package lists its validity. Your wallet history shows every purchase and deduction.'],
  ['Can I integrate SMS into my own software?', 'Yes. Create an API key in the Developer section, send messages with a single HTTP request and receive delivery reports through signed webhooks.'],
  ['Can my team use the same account?', 'Yes. Invite team members and give each person a role — owner, manager, finance, marketing, developer or staff — with exactly the access they need.'],
];

function Pricing() {
  const q = useQuery({ queryKey: ['site', 'packages'], queryFn: siteService.packages, staleTime: 60_000 });
  if (q.isLoading) return <div className="grid gap-5 md:grid-cols-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-72 animate-pulse rounded-2xl bg-slate-100" />)}</div>;
  if (q.error || !q.data?.length) return <p className="text-center text-sm text-slate-500">Pricing is currently unavailable. <a href="#contact" className="link">Contact us</a> for a quote.</p>;
  return (
    <div className="grid gap-5 md:grid-cols-3 lg:grid-cols-5">
      {q.data.map((p) => (
        <div key={p.id} className={cn('relative flex flex-col rounded-2xl bg-white p-6 ring-1', p.isPopular ? 'shadow-pop ring-2 ring-brand-500' : 'ring-slate-200')}>
          {p.isPopular && <span className="absolute -top-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-1 text-xs font-semibold text-white"><Sparkles className="h-3 w-3" /> Best value</span>}
          <p className="text-sm font-semibold text-slate-500">{p.name}</p>
          <p className="mt-3 text-3xl font-bold tracking-tight text-slate-900">{fmtNumber(p.credits)}</p>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">SMS credits</p>
          <p className="mt-5 text-xl font-semibold text-slate-900">{fmtMoney(p.price, p.currency)}</p>
          <p className="text-xs text-slate-500">{fmtMoney(p.pricePerSms, p.currency)} per SMS</p>
          {p.description && <p className="mt-4 flex-1 text-sm text-slate-600">{p.description}</p>}
          <LinkButton to="/register" variant={p.isPopular ? 'primary' : 'secondary'} className="mt-6 w-full">Get started</LinkButton>
        </div>
      ))}
    </div>
  );
}

function ContactForm() {
  const [form, setForm] = useState({ name: '', email: '', phone: '', company: '', message: '', website: '' });
  const m = useMutation({ mutationFn: () => siteService.contact(form) });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  if (m.isSuccess)
    return (
      <div className="rounded-2xl bg-emerald-50 p-8 text-center ring-1 ring-emerald-200">
        <Check className="mx-auto h-10 w-10 text-emerald-600" />
        <p className="mt-3 font-semibold text-emerald-900">Thank you — we received your message.</p>
        <p className="mt-1 text-sm text-emerald-800">Our team will get back to you by email.</p>
      </div>
    );
  return (
    <form className="grid gap-4 rounded-2xl bg-white p-6 ring-1 ring-slate-200 sm:grid-cols-2 sm:p-8" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <Field label="Name" required><Input value={form.name} onChange={set('name')} required minLength={2} /></Field>
      <Field label="Email" required><Input type="email" value={form.email} onChange={set('email')} required /></Field>
      <Field label="Phone"><Input value={form.phone} onChange={set('phone')} /></Field>
      <Field label="Organization"><Input value={form.company} onChange={set('company')} /></Field>
      <Field label="How can we help?" required className="sm:col-span-2"><Textarea rows={4} value={form.message} onChange={set('message')} required minLength={10} /></Field>
      <input type="text" name="website" value={form.website} onChange={set('website')} className="hidden" tabIndex={-1} autoComplete="off" aria-hidden />
      {m.isError && <p className="text-sm text-red-600 sm:col-span-2">{errorMessage(m.error)}</p>}
      <div className="sm:col-span-2"><Button type="submit" size="lg" loading={m.isPending}>Send message</Button></div>
    </form>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-slate-200">
      <button className="flex w-full items-center justify-between gap-4 py-5 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="font-medium text-slate-900">{q}</span>
        <ChevronDown className={cn('h-5 w-5 shrink-0 text-slate-400 transition', open && 'rotate-180')} />
      </button>
      {open && <p className="pb-5 text-sm leading-relaxed text-slate-600">{a}</p>}
    </div>
  );
}

export function LandingPage() {
  return (
    <div className="bg-white">
      <SiteHeader />
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="bg-grid absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-4 pb-20 pt-16 sm:px-6 lg:grid-cols-2 lg:pb-28 lg:pt-24">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100"><MessagesSquare className="h-3.5 w-3.5" /> Powerful SMS management system</p>
            <h1 className="mt-6 text-4xl font-semibold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl lg:text-[56px]">
              Reach every customer with <span className="bg-gradient-to-r from-brand-600 to-violet-600 bg-clip-text text-transparent">SMS that works</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-600">
              Send mass messages, run marketing campaigns, and deliver notifications, alerts and reminders — from one platform built for businesses, organizations and developers. Pay only for what you send, track every message, and integrate with a simple API.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton to="/register" size="lg" icon={<ArrowRight className="h-4 w-4" />}>Get started</LinkButton>
              <a href="#services" className="inline-flex h-11 items-center rounded-xl px-5 text-[15px] font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">View services</a>
              <a href="#contact" className="inline-flex h-11 items-center rounded-xl px-5 text-[15px] font-medium text-slate-600 hover:text-slate-900">Contact us</a>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
              {['Verified businesses only', 'Delivery tracking', 'Prepaid, transparent pricing'].map((t) => <li key={t} className="flex items-center gap-1.5"><Check className="h-4 w-4 text-emerald-500" />{t}</li>)}
            </ul>
          </div>
          <HeroMock />
        </div>
      </section>

      <Section id="services" eyebrow="Services" title="Everything you need to communicate by SMS" subtitle="From a single notification to a nationwide campaign — managed from one dashboard.">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(([Icon, title, text]) => (
            <div key={title} className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-pop">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-violet-50 text-brand-600 ring-1 ring-brand-100"><Icon className="h-5 w-5" /></span>
              <p className="mt-4 font-semibold text-slate-900">{title}</p>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{text}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="how" eyebrow="How it works" title="From sign-up to delivered in six steps" className="bg-slate-50">
        <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ['Create your business account', 'Register with your email and organization name.'],
            ['Verify your business', 'Submit your details and documents. Our team reviews them to keep the network trustworthy.'],
            ['Buy SMS credits', 'Choose a package and pay by mobile money or card. Credits arrive as soon as payment is confirmed.'],
            ['Request a Sender ID', 'Choose the name recipients see. We review and register it with the networks.'],
            ['Send SMS', 'Send to numbers or contact groups, schedule campaigns or use the API.'],
            ['Track delivery', 'See every message move from queued to delivered, with reports for any period.'],
          ].map(([t, d], i) => (
            <li key={t} className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">{i + 1}</span>
              <p className="mt-4 font-semibold text-slate-900">{t}</p>
              <p className="mt-1.5 text-sm text-slate-600">{d}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="about" eyebrow="For every organization" title="Built for the way you communicate" subtitle="Whether you message ten people or ten thousand, the platform scales with you.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map(([Icon, title, text]) => (
            <div key={title} className="flex items-start gap-4 rounded-2xl p-5 ring-1 ring-slate-200">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700"><Icon className="h-5 w-5" /></span>
              <div><p className="font-semibold text-slate-900">{title}</p><p className="mt-0.5 text-sm text-slate-600">{text}</p></div>
            </div>
          ))}
        </div>
      </Section>

      <section id="developers" className="scroll-mt-20 bg-ink-950 py-20 sm:py-24">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-violet-300">Developer API</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">Integrate SMS directly into your software</h2>
            <p className="mt-4 text-base leading-relaxed text-slate-300">Send messages with one HTTP request. Every API call goes through the same verification, sender approval and billing rules as the dashboard.</p>
            <ul className="mt-8 space-y-3">
              {[
                [KeyRound, 'API keys with scopes, IP allow-lists and rotation'],
                [Webhook, 'Signed webhooks for delivered, failed and payment events'],
                [BellRing, 'Idempotency keys so retries never double-send'],
                [Lock, 'Rate limits and detailed request logs'],
              ].map(([Icon, t]) => {
                const I = Icon as typeof KeyRound;
                return <li key={t as string} className="flex items-center gap-3 text-sm text-slate-200"><I className="h-5 w-5 text-violet-300" />{t as string}</li>;
              })}
            </ul>
          </div>
          <div className="overflow-hidden rounded-2xl bg-black/40 ring-1 ring-white/10">
            <div className="border-b border-white/10 px-4 py-2 font-mono text-xs text-slate-400">POST /api/v1/public/sms/send</div>
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-slate-200">{`curl -X POST ${window.location.origin}/api/v1/public/sms/send \\
  -H "Authorization: Bearer $SMS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "senderId": "YOURBRAND",
    "to": ["+250788123456"],
    "message": "Your order is ready."
  }'

# → 201 Created
{ "success": true, "messageId": "5f0c2b1e-…" }`}</pre>
          </div>
        </div>
      </section>

      <Section eyebrow="Why choose us" title="A platform you can run your communication on">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [MessagesSquare, 'Centralized SMS management', 'Messages, campaigns, contacts and sender IDs in one place.'],
            [Users, 'Role-based access', 'Owners, finance, marketing, developers and staff each get the right access.'],
            [LineChart, 'Delivery tracking', 'Honest reports — pending messages are never counted as delivered.'],
            [Wallet, 'Wallet-based billing', 'Prepaid credits, invoices and a complete transaction ledger.'],
            [BarChart3, 'Business analytics', 'Usage and spending reports for any date range.'],
            [Code2, 'API integration', 'Documented REST API with examples in five languages.'],
            [ShieldCheck, 'Verified senders', 'Businesses and sender names are reviewed to prevent abuse.'],
            [Lock, 'Secure by design', 'Encrypted secrets, private documents and a full audit trail.'],
          ].map(([Icon, t, d]) => {
            const I = Icon as typeof Lock;
            return (
              <div key={t as string} className="rounded-2xl bg-slate-50 p-6">
                <I className="h-6 w-6 text-brand-600" />
                <p className="mt-3 font-semibold text-slate-900">{t as string}</p>
                <p className="mt-1.5 text-sm text-slate-600">{d as string}</p>
              </div>
            );
          })}
        </div>
      </Section>

      <Section id="pricing" eyebrow="Pricing" title="Simple, prepaid SMS packages" subtitle="Buy credits once and use them for any message. 1 credit = 1 SMS segment to one recipient." className="bg-slate-50">
        <Pricing />
        <p className="mt-8 text-center text-sm text-slate-500">Need a larger volume? <a href="#contact" className="link">Talk to us</a>.</p>
      </Section>

      <Section id="faq" eyebrow="FAQ" title="Frequently asked questions">
        <div className="mx-auto max-w-3xl">{FAQS.map(([q, a]) => <FaqItem key={q} q={q} a={a} />)}</div>
      </Section>

      <section className="px-4 sm:px-6">
        <div className="mx-auto max-w-7xl overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 via-brand-700 to-violet-700 px-6 py-16 text-center sm:px-12">
          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Ready to communicate with your customers?</h2>
          <p className="mx-auto mt-4 max-w-2xl text-brand-100">Create your business account and manage all your SMS communication from one platform.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/register" className="inline-flex h-11 items-center gap-2 rounded-xl bg-white px-6 text-[15px] font-semibold text-brand-700 hover:bg-brand-50">Create business account <ArrowRight className="h-4 w-4" /></Link>
            <a href="#contact" className="inline-flex h-11 items-center rounded-xl px-6 text-[15px] font-medium text-white ring-1 ring-inset ring-white/40 hover:bg-white/10">Contact sales</a>
          </div>
        </div>
      </section>

      <Section id="contact" eyebrow="Contact" title="Talk to our team" subtitle="Questions about pricing, verification or integration? Send us a message.">
        <div className="mx-auto max-w-3xl"><ContactForm /></div>
      </Section>
      <SiteFooter />
    </div>
  );
}

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-white">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
        <div className="mt-8 space-y-6 text-[15px] leading-relaxed text-slate-700 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-slate-900">{children}</div>
        <p className="mt-12 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">This is a template. Have it reviewed by legal counsel before publishing.</p>
      </main>
      <SiteFooter />
    </div>
  );
}

export function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <p>This policy explains what information we collect when you use the SMS Gateway platform and how we use it.</p>
      <h2>Information we collect</h2>
      <p>Account details (name, email, phone), business verification information and documents, contacts you upload, messages you send, payment records and technical logs such as IP addresses.</p>
      <h2>How we use it</h2>
      <p>To provide and bill the service, verify businesses and sender IDs, prevent fraud and abuse, deliver messages through network providers, and meet legal obligations.</p>
      <h2>Sharing</h2>
      <p>Message content and recipient numbers are shared with the telecommunication providers that deliver them. Payment information is processed by our payment providers. We do not sell personal data.</p>
      <h2>Security and retention</h2>
      <p>Verification documents are stored privately and access is logged. Records are retained as long as needed for the service and for legal, accounting and audit requirements.</p>
      <h2>Your rights</h2>
      <p>You may request access to, correction of, or deletion of your personal data by contacting us.</p>
    </LegalPage>
  );
}

export function TermsPage() {
  return (
    <LegalPage title="Terms of service">
      <p>By creating an account you agree to these terms.</p>
      <h2>Acceptable use</h2>
      <p>You may only send messages to recipients who have agreed to receive them. Spam, fraud, phishing, and illegal or misleading content are prohibited. We may suspend accounts that break these rules.</p>
      <h2>Verification and sender IDs</h2>
      <p>Businesses must provide accurate information. Sender IDs must represent your organization and are subject to review and network rules.</p>
      <h2>Credits and payments</h2>
      <p>Credits are prepaid and consumed per SMS segment per recipient. Package validity is shown at purchase. Refunds are handled case by case.</p>
      <h2>Service</h2>
      <p>Message delivery depends on telecommunication networks and recipient devices; we report the delivery status we receive but cannot guarantee delivery.</p>
      <h2>Liability</h2>
      <p>To the extent permitted by law, our liability is limited to the amount you paid for the affected service.</p>
    </LegalPage>
  );
}
