import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { ORGANIZATION_SCOPES } from '../integrations/scopes';
import { createOrganizationByAdmin, grantOrganizationAccess } from './admin.provisioning.service';
import { audit } from '../audit-logs/audit.service';
import { notifyOrganization } from '../notifications/notification.service';
import { documentUpload } from '../../middlewares/upload';
import {
  decideVerification,
  deleteDocument,
  markDocumentOnFile,
  getCurrentVerification,
  getVerificationOverview,
  submitDocumentValue,
  submitVerification,
  syncVerificationSuspension,
  uploadDocument,
} from '../verification/verification.service';

export const adminOrganizationsRouter = Router();

adminOrganizationsRouter.get(
  '/',
  requirePlatformPermission('organizations.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({ search: z.string().trim().max(100).optional(), status: z.enum(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED']).optional() }),
      req.query,
    );
    const where: Prisma.OrganizationWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { OR: [{ name: { contains: q.search } }, { registrationNumber: { contains: q.search } }] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(q),
        include: {
          wallet: { select: { balance: true } },
          members: { where: { isOwner: true }, select: { user: { select: { fullName: true, email: true } } } },
          _count: { select: { members: true, senders: true } },
        },
      }),
      prisma.organization.count({ where }),
    ]);
    return paginated(
      res,
      items.map(({ members, wallet, _count, ...o }) => ({ ...o, owner: members[0]?.user ?? null, balance: wallet?.balance ?? 0, memberCount: _count.members, senderCount: _count.senders })),
      q.page,
      q.limit,
      total,
    );
  }),
);

const person = z.object({ fullName: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(255), phone: z.string().trim().max(30).optional() });
const text = (max: number) => z.string().trim().max(max).optional();

/** Creates an organization and its owner. Activating skips verification, so it also needs verification.approve. */
adminOrganizationsRouter.post(
  '/',
  requirePlatformPermission('organizations.create'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(160),
        businessType: text(80),
        country: text(80),
        city: text(80),
        address: text(500),
        registrationNumber: text(80),
        taxId: text(80),
        website: text(300),
        contactPersonName: text(120),
        contactPersonPhone: text(30),
        contactPersonEmail: text(255),
        smsPurpose: text(1000),
        expectedMonthlyVolume: z.coerce.number().int().min(0).max(100_000_000).optional(),
        owner: person,
        activate: z.boolean().default(false),
        apiAccess: z.object({ enabled: z.boolean(), allowedScopes: z.array(z.enum(ORGANIZATION_SCOPES)).nullable() }).optional(),
      }),
      req.body,
    );
    const perms = req.user!.platformPermissions;
    if (body.activate && !perms.has('verification.approve')) throw AppError.forbidden('Approving an organization without verification needs the verification.approve permission', 'PERMISSION_DENIED');
    if (body.apiAccess && !perms.has('api_keys.revoke')) throw AppError.forbidden('Setting API access needs the api_keys.revoke permission', 'PERMISSION_DENIED');
    const { name, owner, activate, apiAccess, ...profile } = body;
    const result = await createOrganizationByAdmin({ name, owner, activate, apiAccess, profile }, actorFromRequest(req), metaFromRequest(req));
    return created(res, result, result.owner.created ? 'Organization created — copy the owner’s temporary password now, it will not be shown again' : 'Organization created');
  }),
);

/** Roles that can be given to a person for this organization (system roles and its own custom roles, never Owner). */
adminOrganizationsRouter.get(
  '/:id/roles',
  requirePlatformPermission('organizations.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const roles = await prisma.role.findMany({
      where: { scope: 'ORGANIZATION', code: { not: 'CUSTOMER_OWNER' }, OR: [{ organizationId: null }, { organizationId: id }] },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, description: true, isSystem: true },
    });
    return ok(res, roles);
  }),
);

/** Gives a person access to an existing organization. */
adminOrganizationsRouter.post(
  '/:id/members',
  requirePlatformPermission('organizations.create'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ person, roleId: z.string().uuid() }), req.body);
    const result = await grantOrganizationAccess(id, body, actorFromRequest(req), metaFromRequest(req));
    return created(res, result, result.user.created ? 'Access granted — copy the temporary password now, it will not be shown again' : 'Access granted');
  }),
);

adminOrganizationsRouter.get(
  '/:id',
  requirePlatformPermission('organizations.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const org = await prisma.organization.findUnique({
      where: { id },
      include: {
        wallet: true,
        members: { include: { user: { select: { id: true, fullName: true, email: true, status: true, lastLoginAt: true } }, role: { select: { name: true } } } },
        senders: { orderBy: { createdAt: 'desc' } },
        verifications: { orderBy: { createdAt: 'desc' }, take: 1, include: { documents: { select: { id: true, documentType: true, originalName: true, status: true, createdAt: true } } } },
        _count: { select: { contacts: true, campaigns: true, apiKeys: true, webhooks: true } },
      },
    });
    if (!org) throw AppError.notFound('Organization');
    const [smsTotal, paymentsTotal] = await Promise.all([
      prisma.smsRecipient.count({ where: { organizationId: id } }),
      prisma.payment.aggregate({ where: { organizationId: id, status: 'SUCCESS' }, _sum: { amount: true }, _count: true }),
    ]);
    return ok(res, { ...org, stats: { smsTotal, payments: paymentsTotal._count, revenue: (paymentsTotal._sum.amount ?? 0).toString() } });
  }),
);

/** Suspension blocks SMS, campaigns, API and purchases; billing/history stay readable. */
adminOrganizationsRouter.post(
  '/:id/status',
  requirePlatformPermission('organizations.suspend'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ action: z.enum(['suspend', 'reactivate']), reason: z.string().trim().max(500).optional() }), req.body);
    const org = await prisma.organization.findUnique({ where: { id } });
    if (!org) throw AppError.notFound('Organization');
    if (body.action === 'suspend') {
      if (org.status === 'SUSPENDED') throw AppError.conflict('Organization is already suspended', 'INVALID_TRANSITION');
      if (!body.reason) throw AppError.unprocessable('A reason is required', 'NOTE_REQUIRED', [{ field: 'reason', message: 'Required' }]);
    } else if (org.status !== 'SUSPENDED') throw AppError.conflict('Organization is not suspended', 'INVALID_TRANSITION');

    await prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id },
        data: body.action === 'suspend'
          ? { status: 'SUSPENDED', suspendedAt: new Date(), statusReason: body.reason }
          : { status: org.approvedAt ? 'ACTIVE' : 'DRAFT', suspendedAt: null, statusReason: null },
      });
      await syncVerificationSuspension(tx, id, body.action === 'suspend', body.reason, actorFromRequest(req));
      await audit({ actor: actorFromRequest(req), action: body.action === 'suspend' ? 'CUSTOMER_SUSPENDED' : 'CUSTOMER_REACTIVATED', resource: 'organization', resourceId: id, organizationId: id, metadata: { reason: body.reason }, meta: metaFromRequest(req) }, tx);
    });
    await notifyOrganization(id, body.action === 'suspend'
      ? { type: 'ACCOUNT_SUSPENDED', title: 'Your account has been suspended', body: `Messaging is disabled. Reason: ${body.reason}`, link: '/app' }
      : { type: 'ACCOUNT_REACTIVATED', title: 'Your account has been reactivated', body: 'Messaging is enabled again.', link: '/app' });
    return ok(res, null, body.action === 'suspend' ? 'Organization suspended' : 'Organization reactivated');
  }),
);

adminOrganizationsRouter.patch(
  '/:id',
  requirePlatformPermission('organizations.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(160).optional(),
        registrationNumber: nullableText(80),
        taxId: nullableText(80),
        businessType: nullableText(80),
        country: nullableText(80),
        city: nullableText(80),
        address: nullableText(500),
        website: nullableText(300),
        contactPersonName: nullableText(120),
        contactPersonPhone: nullableText(30),
        contactPersonEmail: nullableText(255),
        smsPurpose: nullableText(1000),
        expectedMonthlyVolume: z.coerce.number().int().min(0).max(100_000_000).nullable().optional(),
      }),
      req.body,
    );
    const updated = await prisma.organization.update({ where: { id }, data: body });
    await audit({ actor: actorFromRequest(req), action: 'ORGANIZATION_UPDATED', resource: 'organization', resourceId: id, organizationId: id, metadata: { fields: Object.keys(body), byStaff: true }, meta: metaFromRequest(req) });
    return ok(res, updated, 'Organization updated');
  }),
);

// ── Completing an organization's onboarding on its behalf ────────────────────
// The same dynamic requirements and rules a customer sees, performed by platform staff.

adminOrganizationsRouter.get(
  '/:id/verification',
  requirePlatformPermission('organizations.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    return ok(res, await getVerificationOverview(id));
  }),
);

adminOrganizationsRouter.post(
  '/:id/documents',
  requirePlatformPermission('organizations.create'),
  documentUpload.single('file'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    if (!req.file) throw AppError.badRequest('Attach the document in the "file" field', 'FILE_REQUIRED');
    const { documentType } = parse(z.object({ documentType: z.string().trim().min(1).max(64) }), req.body);
    return created(res, await uploadDocument(id, req.file, documentType, actorFromRequest(req), metaFromRequest(req)), 'Document uploaded');
  }),
);

adminOrganizationsRouter.post(
  '/:id/documents/value',
  requirePlatformPermission('organizations.create'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ documentType: z.string().trim().min(1).max(64), value: z.string().trim().min(1).max(2000) }), req.body);
    return created(res, await submitDocumentValue(id, body.documentType, body.value, actorFromRequest(req), metaFromRequest(req)), 'Saved');
  }),
);

adminOrganizationsRouter.post(
  '/:id/documents/on-file',
  requirePlatformPermission('organizations.create'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ documentType: z.string().trim().min(1).max(64), note: z.string().trim().max(300).optional() }), req.body);
    return created(res, await markDocumentOnFile(id, body.documentType, body.note, actorFromRequest(req), metaFromRequest(req)), 'Marked as already on file');
  }),
);

adminOrganizationsRouter.delete(
  '/:id/documents/:documentId',
  requirePlatformPermission('organizations.create'),
  asyncHandler(async (req, res) => {
    const { id, documentId } = parse(z.object({ id: z.string().uuid(), documentId: z.string().uuid() }), req.params);
    await deleteDocument(id, documentId, actorFromRequest(req), metaFromRequest(req), { allowOnFile: true });
    return ok(res, null, 'Removed');
  }),
);

/**
 * Last step of the wizard. Submitting and approving go through the same services a customer
 * submission and a staff decision use, so history, notifications and audit entries are identical.
 */
adminOrganizationsRouter.post(
  '/:id/finalize',
  requirePlatformPermission('organizations.create'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ outcome: z.enum(['SAVE_DRAFT', 'SUBMIT', 'APPROVE']), note: z.string().trim().max(1000).optional() }), req.body);
    if (body.outcome === 'APPROVE' && !req.user!.platformPermissions.has('verification.approve')) throw AppError.forbidden('Approving needs the verification.approve permission', 'PERMISSION_DENIED');
    const actor = actorFromRequest(req);
    const meta = metaFromRequest(req);
    if (body.outcome !== 'SAVE_DRAFT') {
      await submitVerification(id, actor, meta); // refuses with a field list while required details or documents are missing
      if (body.outcome === 'APPROVE') {
        const v = await getCurrentVerification(id);
        await decideVerification(v.id, 'APPROVE', body.note || 'Completed and approved by a platform administrator', actor, meta);
      }
    }
    return ok(res, await getVerificationOverview(id), body.outcome === 'APPROVE' ? 'Organization approved' : body.outcome === 'SUBMIT' ? 'Submitted for review' : 'Saved as draft');
  }),
);

/** Platform control over an organization's API keys: on/off and a ceiling on the scopes it may use. */
adminOrganizationsRouter.put(
  '/:id/api-access',
  requirePlatformPermission('api_keys.revoke'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ enabled: z.boolean(), allowedScopes: z.array(z.enum(ORGANIZATION_SCOPES)).nullable() }), req.body);
    const before = await prisma.organization.findUnique({ where: { id }, select: { apiAccessEnabled: true, apiAllowedScopes: true } });
    if (!before) throw AppError.notFound('Organization');
    const org = await prisma.organization.update({
      where: { id },
      data: { apiAccessEnabled: body.enabled, apiAllowedScopes: body.allowedScopes ?? Prisma.DbNull },
      select: { apiAccessEnabled: true, apiAllowedScopes: true },
    });
    await audit({ actor: actorFromRequest(req), action: 'ORGANIZATION_API_ACCESS_CHANGED', resource: 'organization', resourceId: id, organizationId: id, metadata: { before, after: org }, meta: metaFromRequest(req) });
    return ok(res, org, 'API access updated');
  }),
);
