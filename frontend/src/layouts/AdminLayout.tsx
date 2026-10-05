import { Outlet } from 'react-router-dom';
import {
  Banknote,
  Code2,
  Inbox,
  RadioTower,
  BarChart3,
  Building2,
  CreditCard,
  FileCheck2,
  LayoutDashboard,
  Lock,
  MessagesSquare,
  Package,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Wallet,
} from 'lucide-react';
import { Shell, type NavItem } from '@/components/layout/Shell';
import { usePermissions } from '@/hooks/useAuth';

export function AdminLayout() {
  const { canAdmin } = usePermissions();
  const nav: NavItem[] = [
    { label: 'Dashboard', to: '/admin', icon: LayoutDashboard, end: true, visible: canAdmin('dashboard.view') },
    { label: 'Businesses', to: '/admin/organizations', icon: Building2, visible: canAdmin('organizations.view') },
    { label: 'Business verification', to: '/admin/verification', icon: FileCheck2, visible: canAdmin('verification.view') },
    { label: 'Sender IDs', to: '/admin/senders', icon: ShieldCheck, visible: canAdmin('senders.view') },
    {
      label: 'SMS providers',
      to: '/admin/providers-group',
      icon: RadioTower,
      children: [
        { label: 'Providers', to: '/admin/providers', visible: canAdmin('providers.view') },
        { label: 'Provider purchases', to: '/admin/provider-purchases', visible: canAdmin('provider_purchases.view') },
        { label: 'Provider wallets', to: '/admin/provider-wallets', visible: canAdmin('providers.view') },
      ],
    },
    {
      label: 'Finance',
      to: '/admin/finance-group',
      icon: Banknote,
      children: [
        { label: 'Business overview', to: '/admin/finance', visible: canAdmin('finance.view') },
        { label: 'Customer SMS sales', to: '/admin/sales', visible: canAdmin('finance.view') },
        { label: 'Expenses', to: '/admin/expenses', visible: canAdmin('expenses.view') },
      ],
    },
    {
      label: 'Messaging',
      to: '/admin/messaging',
      icon: MessagesSquare,
      children: [
        { label: 'SMS traffic', to: '/admin/messaging/sms', visible: canAdmin('sms.view') },
        { label: 'Campaigns', to: '/admin/messaging/campaigns', visible: canAdmin('campaigns.view') },
      ],
    },
    {
      label: 'Payments',
      to: '/admin/payments',
      icon: CreditCard,
      children: [
        { label: 'Payments', to: '/admin/payments', end: true, visible: canAdmin('payments.view') },
        { label: 'Invoices', to: '/admin/payments/invoices', visible: canAdmin('invoices.view') },
      ],
    },
    { label: 'Wallet transactions', to: '/admin/wallets', icon: Wallet, visible: canAdmin('wallet.view') },
    { label: 'SMS packages', to: '/admin/packages', icon: Package, visible: canAdmin('packages.view') },
    {
      label: 'Developer',
      to: '/admin/developer',
      icon: Code2,
      children: [
        { label: 'API usage', to: '/admin/developer/api-usage', visible: canAdmin('api_keys.view') },
        { label: 'API keys', to: '/admin/api-keys', visible: canAdmin('api_keys.view') },
        { label: 'Webhooks', to: '/admin/developer/webhooks', visible: canAdmin('webhooks.view') },
        { label: 'Integrations', to: '/admin/integrations', visible: canAdmin('integrations.view') },
      ],
    },
    { label: 'Reports', to: '/admin/reports', icon: BarChart3, visible: canAdmin('reports.view') },
    { label: 'Inquiries', to: '/admin/inquiries', icon: Inbox, visible: canAdmin('inquiries.view') },
    { label: 'Users', to: '/admin/users', icon: Users, visible: canAdmin('users.view') },
    { label: 'Roles & permissions', to: '/admin/roles', icon: Lock, visible: canAdmin('roles.view') },
    { label: 'Audit logs', to: '/admin/audit-logs', icon: ScrollText, visible: canAdmin('audit_logs.view') },
    { label: 'Settings', to: '/admin/settings', icon: SlidersHorizontal, visible: canAdmin('settings.view') || canAdmin('providers.view') },
  ];
  return (
    <Shell
      nav={nav}
      suffix="Admin"
      topLeft={<span className="text-sm font-medium text-slate-500">Platform administration</span>}
      notificationsLink="/admin/notifications"
      settingsLink="/admin/account"
    >
      <Outlet />
    </Shell>
  );
}
