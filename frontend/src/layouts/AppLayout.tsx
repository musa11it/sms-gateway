import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet, Link } from 'react-router-dom';
import {
  BarChart3,
  Building2,
  Code2,
  Contact,
  LayoutDashboard,
  MessageSquareText,
  Settings,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { Shell, type NavItem } from '@/components/layout/Shell';
import { usePermissions, useMe } from '@/hooks/useAuth';
import { walletService } from '@/services/walletService';
import { useAuthStore } from '@/stores/authStore';
import { fmtNumber } from '@/utils/format';
import { Dropdown, MenuItem } from '@/components/ui/Misc';
import { Check, ChevronsUpDown } from 'lucide-react';

function OrgSwitcher() {
  const { data: me } = useMe();
  const setOrg = useAuthStore((s) => s.setCurrentOrgId);
  const qc = useQueryClient();
  if (!me?.organization) return null;
  const org = me.organization;
  const single = me.memberships.length <= 1;
  const label = (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-xs font-semibold text-white">
        {org.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="min-w-0 text-left">
        <span className="block truncate text-sm font-semibold text-slate-900">{org.name}</span>
        <span className="block truncate text-xs text-slate-500">{org.role.name}</span>
      </span>
      {!single && <ChevronsUpDown className="h-4 w-4 shrink-0 text-slate-400" />}
    </span>
  );
  if (single) return <div className="max-w-xs">{label}</div>;
  return (
    <Dropdown align="left" trigger={<button className="max-w-xs rounded-lg px-1.5 py-1 hover:bg-slate-100">{label}</button>}>
      {(close) =>
        me.memberships.map((m) => (
          <MenuItem
            key={m.organizationId}
            icon={m.organizationId === org.id ? <Check /> : <span className="h-4 w-4" />}
            onClick={() => {
              setOrg(m.organizationId);
              qc.invalidateQueries();
              close();
            }}
          >
            <span className="truncate">{m.organizationName}</span>
          </MenuItem>
        ))
      }
    </Dropdown>
  );
}

function Banners() {
  const { data: me } = useMe();
  const { can } = usePermissions();
  const org = me?.organization;
  const { data: wallet } = useQuery({ queryKey: ['wallet'], queryFn: walletService.wallet, enabled: !!org && org.status === 'ACTIVE' && can('wallet.view') });
  if (!org) return null;
  if (org.status === 'SUSPENDED')
    return (
      <div className="border-b border-red-200 bg-red-50 px-6 py-2.5 text-center text-sm text-red-800">
        <strong>Your organization is suspended.</strong> Sending SMS, campaigns and API access are disabled. {org.statusReason && <>Reason: {org.statusReason}. </>}Contact support to resolve this.
      </div>
    );
  if (org.status !== 'ACTIVE')
    return (
      <div className="border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-center text-sm text-amber-900">
        {org.status === 'PENDING_REVIEW' ? 'Your verification is under review — we’ll notify you once approved.' : 'Complete your business verification to start sending SMS.'}{' '}
        <Link to="/onboarding" className="font-semibold underline underline-offset-2">
          {org.status === 'PENDING_REVIEW' ? 'View status' : 'Continue verification'} →
        </Link>
      </div>
    );
  if (wallet?.isLow)
    return (
      <div className="border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-center text-sm text-amber-900">
        <strong>Low balance:</strong> {fmtNumber(wallet.balance)} SMS credits left (alert threshold {fmtNumber(wallet.lowBalanceThreshold)}).{' '}
        {can('wallet.purchase') && (
          <Link to="/app/wallet/buy" className="font-semibold underline underline-offset-2">
            Buy SMS →
          </Link>
        )}
      </div>
    );
  return null;
}

export function AppLayout() {
  const { can } = usePermissions();
  const nav: NavItem[] = [
    { label: 'Overview', to: '/app', icon: LayoutDashboard, end: true },
    {
      label: 'Messaging',
      section: 'Workspace',
      to: '/app/sms',
      icon: MessageSquareText,
      children: [
        { label: 'Send SMS', to: '/app/sms/send', visible: can('sms.send') },
        { label: 'Campaigns', to: '/app/campaigns', visible: can('campaigns.view') },
        { label: 'SMS History', to: '/app/sms/history', visible: can('sms.view') },
        { label: 'Scheduled', to: '/app/sms/scheduled', visible: can('sms.view') },
      ],
    },
    {
      label: 'Contacts',
      to: '/app/contacts',
      icon: Contact,
      children: [
        { label: 'Contacts', to: '/app/contacts', end: true, visible: can('contacts.view') },
        { label: 'Groups', to: '/app/contacts/groups', visible: can('contacts.view') },
        { label: 'Import CSV', to: '/app/contacts/import', visible: can('contacts.import') },
      ],
    },
    { label: 'Sender IDs', to: '/app/senders', icon: ShieldCheck, visible: can('senders.view') },
    {
      label: 'Wallet',
      section: 'Finance',
      to: '/app/wallet',
      icon: Wallet,
      children: [
        { label: 'Buy SMS', to: '/app/wallet/buy', visible: can('wallet.purchase') },
        { label: 'Pricing', to: '/app/pricing' },
        { label: 'Transactions', to: '/app/wallet/transactions', visible: can('wallet.view') },
        { label: 'Payments', to: '/app/wallet/payments', visible: can('payments.view') },
        { label: 'Invoices', to: '/app/wallet/invoices', visible: can('invoices.view') },
      ],
    },
    {
      label: 'Developer',
      section: 'Developer',
      to: '/app/developer',
      icon: Code2,
      children: [
        { label: 'API Keys', to: '/app/developer/api-keys', visible: can('api_keys.view') },
        { label: 'API Logs', to: '/app/developer/logs', visible: can('api_keys.view') },
        { label: 'Webhooks', to: '/app/developer/webhooks', visible: can('webhooks.view') },
        { label: 'Documentation', to: '/app/developer/docs' },
      ],
    },
    { label: 'Reports', section: 'Organization', to: '/app/reports', icon: BarChart3, visible: can('reports.view') },
    { label: 'Organization', to: '/app/organization', icon: Building2, visible: can('organizations.view') },
    { label: 'Settings', to: '/app/settings', icon: Settings },
  ];
  return (
    <Shell nav={nav} topLeft={<OrgSwitcher />} banners={<Banners />} notificationsLink="/app/notifications" settingsLink="/app/settings">
      <Outlet />
    </Shell>
  );
}
