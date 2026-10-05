import { Router } from 'express';
import { isProduction } from '../config/env';
import { prisma } from '../config/prisma';
import { authenticate, requireVerifiedEmail } from '../middlewares/auth';
import { authenticateStaff } from '../middlewares/integrationAuth';
import { orgContext } from '../middlewares/organization';
import { adminLimiter } from '../middlewares/rateLimit';
import { requireStaff } from '../middlewares/rbac';
import { adminApiKeysRouter } from '../modules/api-keys/admin.apiKeys.routes';
import { apiKeyRouter, apiLogRouter } from '../modules/api-keys/apiKey.routes';
import { adminAuditRouter, orgAuditRouter } from '../modules/audit-logs/audit.routes';
import { authRouter, meRouter } from '../modules/auth/auth.routes';
import { campaignRouter } from '../modules/campaigns/campaign.routes';
import { contactRouter, groupRouter } from '../modules/contacts/contact.routes';
import { notificationRouter } from '../modules/notifications/notification.routes';
import { adminOrganizationsRouter } from '../modules/organizations/admin.organizations.routes';
import { invitationRouter, organizationRouter } from '../modules/organizations/organization.routes';
import { adminBillingRouter } from '../modules/payments/admin.billing.routes';
import { invoiceRouter, packageRouter, paymentRouter } from '../modules/payments/payment.routes';
import { adminReportsRouter } from '../modules/reports/admin.reports.routes';
import { reportRouter } from '../modules/reports/report.routes';
import { adminRolesRouter } from '../modules/roles/admin.roles.routes';
import { adminSendersRouter } from '../modules/senders/admin.senders.routes';
import { senderRouter } from '../modules/senders/sender.routes';
import { adminSettingsRouter, providerInfo } from '../modules/settings/admin.settings.routes';
import { adminSmsRouter } from '../modules/sms/admin.sms.routes';
import { publicRouter } from '../modules/sms/public.routes';
import { smsRouter } from '../modules/sms/sms.routes';
import { adminUsersRouter } from '../modules/users/admin.users.routes';
import { adminFinanceRouter } from '../modules/finance/admin.finance.routes';
import { adminProvidersRouter } from '../modules/providers/admin.providers.routes';
import { adminDeveloperRouter } from '../modules/api-keys/admin.developer.routes';
import { adminInquiriesRouter, siteRouter } from '../modules/site/site.routes';
import { adminIntegrationsRouter } from '../modules/integrations/admin.integrations.routes';
import { financeIntegrationRouter } from '../modules/integrations/finance.routes';
import { adminVerificationRouter } from '../modules/verification/admin.verification.routes';
import { verificationRouter } from '../modules/verification/verification.routes';
import { walletRouter } from '../modules/wallet/wallet.routes';
import { webhookRouter } from '../modules/webhooks/webhook.routes';
import { asyncHandler, ok, paginationSchema, parse } from '../utils/http';

export const apiRouter = Router();

// ── Public / session ─────────────────────────────────────────────────────
apiRouter.use('/auth', authRouter);
apiRouter.use('/me', meRouter);
apiRouter.use('/invitations', invitationRouter);

/** Public API (API key auth) — /api/v1/public/... */
apiRouter.use('/public', publicRouter);

/** External systems (integration-key auth) — /api/v1/integrations/... */
apiRouter.use('/integrations/finance', financeIntegrationRouter);

/** Public website (no auth): pricing and contact form. */
apiRouter.use('/site', siteRouter);

apiRouter.get(
  '/system/info',
  authenticate,
  asyncHandler(async (_req, res) => {
    const p = providerInfo();
    return ok(res, { smsProvider: p.sms.mode, smsSimulation: p.sms.isSimulation, paymentProvider: p.payments.active, paymentSimulation: p.payments.isSimulation, environment: p.environment });
  }),
);

// ── Tenant (customer) API: authenticated + organization context ─────────
// The tenant stack is mounted per path so it never intercepts other routes.
const tenantRoutes: [string, Router][] = [
  ['/organization', organizationRouter],
  ['/verification', verificationRouter],
  ['/wallet', walletRouter],
  ['/payments', paymentRouter],
  ['/invoices', invoiceRouter],
  ['/sms', smsRouter],
  ['/campaigns', campaignRouter],
  ['/contacts', contactRouter],
  ['/contact-groups', groupRouter],
  // Developer section (API keys, API logs, webhooks) lives under /developer.
  ['/developer/api-keys', apiKeyRouter],
  ['/developer/api-logs', apiLogRouter],
  ['/developer/webhooks', webhookRouter],
  ['/reports', reportRouter],
  ['/audit-logs', orgAuditRouter],
];
for (const [path, router] of tenantRoutes) apiRouter.use(path, authenticate, orgContext, router);
apiRouter.use('/senders', authenticate, requireVerifiedEmail, orgContext, senderRouter);
apiRouter.use('/packages', authenticate, packageRouter);
apiRouter.use('/notifications', authenticate, notificationRouter);

// ── Platform admin API: staff only, permission-checked per route ────────
const admin = Router();
admin.use(authenticateStaff, requireStaff, adminLimiter);
export const adminMounts: [string, Router][] = [
  ['/reports', adminReportsRouter],
  ['/users', adminUsersRouter],
  ['/organizations', adminOrganizationsRouter],
  ['/verifications', adminVerificationRouter],
  ['/senders', adminSendersRouter],
  ['/sms', adminSmsRouter],
  ['/billing', adminBillingRouter],
  ['/roles', adminRolesRouter],
  ['/audit-logs', adminAuditRouter],
  ['/settings', adminSettingsRouter],
  ['/api-keys', adminApiKeysRouter],
  ['/finance', adminFinanceRouter],
  ['/providers', adminProvidersRouter],
  ['/developer', adminDeveloperRouter],
  ['/inquiries', adminInquiriesRouter],
  ['/integrations', adminIntegrationsRouter],
];
for (const [path, router] of adminMounts) admin.use(path, router);
apiRouter.use('/admin', admin);

// ── Development-only: outbox viewer (no real email delivery in dev) ─────
if (!isProduction) {
  apiRouter.get(
    '/dev/mailbox',
    asyncHandler(async (req, res) => {
      const q = parse(paginationSchema, req.query);
      const to = typeof req.query.to === 'string' ? req.query.to : undefined;
      const items = await prisma.emailMessage.findMany({
        where: to ? { to: { contains: to } } : {},
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        skip: (q.page - 1) * q.limit,
      });
      return ok(res, items);
    }),
  );
}
