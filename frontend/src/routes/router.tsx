import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';
import { PageLoader } from '@/components/ui/Feedback';
import { AdminLayout } from '@/layouts/AdminLayout';
import { AppLayout } from '@/layouts/AppLayout';
import { AdminRoute, CustomerRoute, GuestRoute, HomeRedirect, PermissionRoute, ProtectedRoute } from './guards';

/** Lazy-load a named export so each area ships as its own chunk. */
function page<T>(loader: () => Promise<T>, name: keyof T) {
  const C = lazy(() => loader().then((m) => ({ default: m[name] as unknown as ComponentType })));
  return (
    <Suspense fallback={<PageLoader />}>
      <C />
    </Suspense>
  );
}

const guard = (permission: string | string[], el: ReactNode, admin = false) => (
  <PermissionRoute permission={permission} admin={admin}>
    {el}
  </PermissionRoute>
);

const auth = () => import('@/pages/auth/AuthPages');
const onboarding = () => import('@/pages/onboarding/OnboardingPage');
const dashboard = () => import('@/pages/dashboard/DashboardPage');
const sms = () => import('@/pages/sms/SmsPages');
const campaigns = () => import('@/pages/campaigns/CampaignPages');
const contacts = () => import('@/pages/contacts/ContactPages');
const senders = () => import('@/pages/sms/SendersPage');
const wallet = () => import('@/pages/wallet/WalletPages');
const developer = () => import('@/pages/developer/DeveloperPages');
const docs = () => import('@/pages/developer/DocsPage');
const reports = () => import('@/pages/dashboard/ReportsPage');
const settings = () => import('@/pages/settings/SettingsPages');
const admin = () => import('@/pages/admin/AdminPages');
const adminOrgs = () => import('@/pages/admin/OrganizationPages');
const adminReview = () => import('@/pages/admin/ReviewPages');
const adminBilling = () => import('@/pages/admin/BillingPages');
const smsCommerce = () => import('@/pages/admin/SmsCommercePages');
const smsConfig = () => import('@/pages/admin/SmsConfigurationPage');
const providerMgmt = () => import('@/pages/admin/ProviderManagementPages');
const adminAccess = () => import('@/pages/admin/AccessPages');
const misc = () => import('@/pages/MiscPages');
const site = () => import('@/pages/site/SitePages');
const business = () => import('@/pages/admin/BusinessPages');

const appRoutes: RouteObject[] = [
  { index: true, element: page(dashboard, 'DashboardPage') },
  { path: 'sms/send', element: guard('sms.send', page(sms, 'SendSmsPage')) },
  { path: 'sms/history', element: guard('sms.view', page(sms, 'SmsHistoryPage')) },
  { path: 'sms/scheduled', element: guard('sms.view', page(sms, 'ScheduledPage')) },
  { path: 'campaigns', element: guard('campaigns.view', page(campaigns, 'CampaignsPage')) },
  { path: 'campaigns/new', element: guard('campaigns.create', page(campaigns, 'CampaignFormPage')) },
  { path: 'campaigns/:id/edit', element: guard('campaigns.update', page(campaigns, 'CampaignFormPage')) },
  { path: 'campaigns/:id', element: guard('campaigns.view', page(campaigns, 'CampaignDetailPage')) },
  { path: 'contacts', element: guard('contacts.view', page(contacts, 'ContactsPage')) },
  { path: 'contacts/groups', element: guard('contacts.view', page(contacts, 'GroupsPage')) },
  { path: 'contacts/import', element: guard('contacts.import', page(contacts, 'ImportContactsPage')) },
  { path: 'senders', element: guard('senders.view', page(senders, 'SendersPage')) },
  { path: 'wallet', element: <Navigate to="/app/wallet/transactions" replace /> },
  { path: 'wallet/buy', element: guard('wallet.purchase', page(wallet, 'BuySmsPage')) },
  { path: 'wallet/transactions', element: guard('wallet.view', page(wallet, 'TransactionsPage')) },
  { path: 'wallet/payments', element: guard('payments.view', page(wallet, 'PaymentsPage')) },
  { path: 'wallet/invoices', element: guard('invoices.view', page(wallet, 'InvoicesPage')) },
  { path: 'wallet/invoices/:id', element: guard('invoices.view', page(wallet, 'InvoicePage')) },
  { path: 'developer/api-keys', element: guard('api_keys.view', page(developer, 'ApiKeysPage')) },
  { path: 'developer/logs', element: guard('api_keys.view', page(developer, 'ApiLogsPage')) },
  { path: 'developer/webhooks', element: guard('webhooks.view', page(developer, 'WebhooksPage')) },
  { path: 'developer/docs', element: page(docs, 'DocsPage') },
  { path: 'reports', element: guard('reports.view', page(reports, 'ReportsPage')) },
  { path: 'organization', element: guard('organizations.view', page(settings, 'OrganizationPage')) },
  { path: 'settings', element: page(settings, 'SettingsPage') },
  { path: 'settings/team', element: <Navigate to="/app/organization?tab=team" replace /> },
  { path: 'notifications', element: page(settings, 'NotificationsPage') },
  { path: '*', element: page(misc, 'NotFoundPage') },
];

const adminRoutes: RouteObject[] = [
  { index: true, element: guard('dashboard.view', page(admin, 'AdminDashboardPage'), true) },
  { path: 'organizations', element: guard('organizations.view', page(adminOrgs, 'OrganizationsPage'), true) },
  { path: 'organizations/:id', element: guard('organizations.view', page(adminOrgs, 'OrganizationDetailPage'), true) },
  { path: 'users', element: guard('users.view', page(adminOrgs, 'UsersPage'), true) },
  { path: 'verification', element: guard('verification.view', page(adminReview, 'VerificationQueuePage'), true) },
  { path: 'verification/:id', element: guard('verification.view', page(adminReview, 'VerificationDetailPage'), true) },
  { path: 'senders', element: guard('senders.view', page(adminReview, 'SenderReviewPage'), true) },
  { path: 'messaging/sms', element: guard('sms.view', page(admin, 'SmsTrafficPage'), true) },
  { path: 'messaging/campaigns', element: guard('campaigns.view', page(admin, 'AdminCampaignsPage'), true) },
  { path: 'payments', element: guard('payments.view', page(adminBilling, 'AdminPaymentsPage'), true) },
  { path: 'payments/invoices', element: guard('invoices.view', page(adminBilling, 'AdminInvoicesPage'), true) },
  { path: 'payments/invoices/:id', element: guard('invoices.view', page(adminBilling, 'AdminInvoicePage'), true) },
  { path: 'wallets', element: guard('wallet.view', page(adminBilling, 'WalletsPage'), true) },
  { path: 'packages', element: guard('packages.view', page(adminBilling, 'PackagesPage'), true) },
  { path: 'pricing', element: guard('packages.view', page(smsCommerce, 'PricingTiersPage'), true) },
  { path: 'customer-report', element: guard('finance.view', page(smsCommerce, 'CustomerFinanceReportPage'), true) },
  { path: 'reports', element: guard('reports.view', page(admin, 'AdminReportsPage'), true) },
  { path: 'finance', element: guard('finance.view', page(business, 'FinancePage'), true) },
  { path: 'providers', element: guard('providers.view', page(providerMgmt, 'ProvidersPage'), true) },
  { path: 'providers/:id', element: guard('providers.view', page(providerMgmt, 'ProviderDetailPage'), true) },
  { path: 'routing', element: guard('providers.view', page(providerMgmt, 'RoutingRulesPage'), true) },
  { path: 'routing/simulator', element: guard('providers.view', page(providerMgmt, 'RoutingSimulatorPage'), true) },
  { path: 'provider-purchases', element: guard('provider_purchases.view', page(business, 'ProviderPurchasesPage'), true) },
  { path: 'provider-wallets', element: guard('providers.view', page(business, 'CapacityLedgerPage'), true) },
  { path: 'sales', element: guard('finance.view', page(business, 'CustomerSalesPage'), true) },
  { path: 'expenses', element: guard('expenses.view', page(business, 'ExpensesPage'), true) },
  { path: 'inquiries', element: guard('inquiries.view', page(business, 'InquiriesPage'), true) },
  { path: 'developer/api-usage', element: guard('api_keys.view', page(business, 'AdminApiUsagePage'), true) },
  { path: 'developer/webhooks', element: guard('webhooks.view', page(business, 'AdminWebhooksPage'), true) },
  { path: 'api-keys', element: guard('api_keys.view', page(adminAccess, 'AdminApiKeysPage'), true) },
  { path: 'roles', element: guard('roles.view', page(adminAccess, 'RolesPage'), true) },
  { path: 'audit-logs', element: guard('audit_logs.view', page(adminAccess, 'AuditLogsPage'), true) },
  { path: 'settings', element: guard(['settings.view', 'providers.view'], page(adminAccess, 'SystemSettingsPage'), true) },
  { path: 'sms-configuration', element: guard('settings.view', page(smsConfig, 'SmsConfigurationPage'), true) },
  { path: 'account', element: page(settings, 'SettingsPage') },
  { path: 'notifications', element: page(settings, 'NotificationsPage') },
  { path: '*', element: page(misc, 'NotFoundPage') },
];

export const router = createBrowserRouter([
  {
    element: <GuestRoute />,
    children: [
      { path: '/login', element: page(auth, 'LoginPage') },
      { path: '/register', element: page(auth, 'RegisterPage') },
      { path: '/forgot-password', element: page(auth, 'ForgotPasswordPage') },
      { path: '/reset-password', element: page(auth, 'ResetPasswordPage') },
    ],
  },
  { path: '/', element: page(site, 'LandingPage') },
  { path: '/privacy', element: page(site, 'PrivacyPage') },
  { path: '/terms', element: page(site, 'TermsPage') },
  { path: '/verify-email', element: page(auth, 'VerifyEmailPage') },
  { path: '/invitations/accept', element: page(auth, 'AcceptInvitationPage') },
  { path: '/dev/mailbox', element: page(misc, 'DevMailboxPage') },
  {
    element: <ProtectedRoute />,
    children: [
      { path: '/start', element: <HomeRedirect /> },
      { path: '/onboarding', element: page(onboarding, 'OnboardingPage') },
      { element: <CustomerRoute />, children: [{ path: '/app', element: <AppLayout />, children: appRoutes }] },
      { element: <AdminRoute />, children: [{ path: '/admin', element: <AdminLayout />, children: adminRoutes }] },
    ],
  },
  { path: '*', element: page(misc, 'NotFoundPage') },
], {
  future: { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true },
  
});
