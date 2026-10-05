import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, FlaskConical, LogOut, Menu, Settings, Shield, UserRound, X, type LucideIcon } from 'lucide-react';
import { useLogout, useMe, useSystemInfo } from '@/hooks/useAuth';
import { useUiStore } from '@/stores/authStore';
import { cn } from '@/utils/format';
import { Avatar, Dropdown, MenuItem } from '../ui/Misc';
import { Logo } from './Brand';
import { NotificationBell } from './NotificationBell';

export interface NavItem {
  label: string;
  to: string;
  icon?: LucideIcon;
  /** Shown only when the check passes (permissions come from the API). */
  visible?: boolean;
  end?: boolean;
  children?: NavItem[];
}

function NavGroup({ item }: { item: NavItem }) {
  const location = useLocation();
  const children = (item.children ?? []).filter((c) => c.visible !== false);
  const active = children.some((c) => location.pathname.startsWith(c.to));
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  if (children.length === 0) return null;
  const Icon = item.icon;
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition', active ? 'text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100')}
      >
        {Icon && <Icon className="h-[18px] w-[18px] shrink-0" />}
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronDown className={cn('h-4 w-4 transition-transform', open ? 'rotate-0' : '-rotate-90')} />
      </button>
      {open && (
        <div className="relative ml-[21px] mt-0.5 space-y-0.5 border-l border-white/10 pl-3">
          {children.map((c) => (
            <NavLink
              key={c.to}
              to={c.to}
              end={c.end}
              className={({ isActive }) =>
                cn('block rounded-md px-3 py-1.5 text-[13px] transition', isActive ? 'bg-white/10 font-medium text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100')
              }
            >
              {c.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

function Sidebar({ nav, suffix, footer, onNavigate }: { nav: NavItem[]; suffix?: string; footer?: ReactNode; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col bg-ink-950 bg-[radial-gradient(ellipse_at_top_left,rgba(99,102,241,0.18),transparent_55%)]">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Logo dark suffix={suffix} />
      </div>
      <nav className="scrollbar-thin flex-1 space-y-1 overflow-y-auto px-3 pb-4" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
        {nav
          .filter((i) => i.visible !== false)
          .map((item) =>
            item.children ? (
              <NavGroup key={item.label} item={item} />
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition',
                    isActive ? 'bg-gradient-to-r from-brand-600/90 to-violet-600/70 text-white shadow-lg shadow-brand-900/30' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100',
                  )
                }
              >
                {item.icon && <item.icon className="h-[18px] w-[18px] shrink-0" />}
                {item.label}
              </NavLink>
            ),
          )}
      </nav>
      {footer && <div className="border-t border-white/10 p-3">{footer}</div>}
    </div>
  );
}

export function SimulationPill() {
  const { data } = useSystemInfo();
  if (!data?.smsSimulation) return null;
  return (
    <span
      title={`SMS provider: ${data.smsProvider} (simulation). Payment provider: ${data.paymentProvider}${data.paymentSimulation ? ' (simulation)' : ''}. No real SMS are sent and no real money moves.`}
      className="hidden items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200 sm:inline-flex"
    >
      <FlaskConical className="h-3.5 w-3.5" /> Simulation mode
    </span>
  );
}

export function Shell({
  nav,
  suffix,
  topLeft,
  banners,
  children,
  notificationsLink,
  settingsLink,
  sidebarFooter,
}: {
  nav: NavItem[];
  suffix?: string;
  topLeft?: ReactNode;
  banners?: ReactNode;
  children: ReactNode;
  notificationsLink: string;
  settingsLink: string;
  sidebarFooter?: ReactNode;
}) {
  const { sidebarOpen, setSidebarOpen } = useUiStore();
  const { data: me } = useMe();
  const logout = useLogout();
  const location = useLocation();
  useEffect(() => setSidebarOpen(false), [location.pathname, setSidebarOpen]);

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">
        <Sidebar nav={nav} suffix={suffix} footer={sidebarFooter} />
      </aside>
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-slate-900/50" onClick={() => setSidebarOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 animate-slide-up">
            <Sidebar nav={nav} suffix={suffix} footer={sidebarFooter} onNavigate={() => setSidebarOpen(false)} />
            <button className="absolute right-3 top-4 rounded-lg p-1.5 text-slate-400 hover:bg-white/10" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200/70 bg-white/80 px-4 backdrop-blur-md sm:px-6">
          <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">{topLeft}</div>
          <SimulationPill />
          <NotificationBell allLink={notificationsLink} />
          <Dropdown
            trigger={
              <button className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-slate-100">
                <Avatar name={me?.user.fullName ?? ''} size="sm" />
                <span className="hidden max-w-[140px] truncate text-sm font-medium text-slate-700 md:block">{me?.user.fullName}</span>
                <ChevronDown className="hidden h-4 w-4 text-slate-400 md:block" />
              </button>
            }
          >
            {(close) => (
              <>
                <div className="border-b border-slate-100 px-3 py-2.5">
                  <p className="truncate text-sm font-medium text-slate-900">{me?.user.fullName}</p>
                  <p className="truncate text-xs text-slate-500">{me?.user.email}</p>
                </div>
                <div className="py-1">
                  <MenuItem icon={<UserRound />} to={settingsLink} onClick={close}>
                    Profile & security
                  </MenuItem>
                  {me?.isStaff && me.organization && (
                    <>
                      <MenuItem icon={<Shield />} to="/admin" onClick={close}>
                        Admin console
                      </MenuItem>
                      <MenuItem icon={<Settings />} to="/app" onClick={close}>
                        Customer workspace
                      </MenuItem>
                    </>
                  )}
                </div>
                <div className="border-t border-slate-100 pt-1">
                  <MenuItem icon={<LogOut />} danger onClick={() => void logout()}>
                    Sign out
                  </MenuItem>
                </div>
              </>
            )}
          </Dropdown>
        </header>
        {banners}
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
