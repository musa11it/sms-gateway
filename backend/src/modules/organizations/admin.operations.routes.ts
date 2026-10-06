import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, parse, uuidParam } from '../../utils/http';
import { audit } from '../audit-logs/audit.service';
import { deleteSenderRequest, requestSender, reviewSender, senderNameSchema } from '../senders/sender.service';

/**
 * Operations platform staff perform on an organization's behalf (its Sender IDs, Team, ...).
 * Every one of them REQUIRES a reason, and is written to the organization's own audit log marked
 * `byStaff` together with the reason and, where something changes, the before and after values.
 * Money is handled by the existing wallet adjustment endpoint, which has the same rule.
 */
export const adminOrganizationOperationsRouter = Router();

const reason = z.string().trim().min(5, 'Explain why (at least 5 characters)').max(500);
const orgAndMember = z.object({ id: z.string().uuid(), memberId: z.string().uuid() });

async function requireOrganization(id: string) {
  const org = await prisma.organization.findUnique({ where: { id } });
  if (!org) throw AppError.notFound('Organization');
  return org;
}

// ── Sender IDs ──────────────────────────────────────────────────────────────

adminOrganizationOperationsRouter.post(
  '/:id/senders',
  requirePlatformPermission('senders.review'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        name: senderNameSchema,
        purpose: z.string().trim().min(3).max(500),
        sampleMessage: z.string().trim().max(500).nullable().optional(),
        useCase: z.string().trim().max(500).nullable().optional(),
        approveNow: z.boolean().default(false),
        reason,
      }),
      req.body,
    );
    if (body.approveNow && !req.user!.platformPermissions.has('senders.approve')) throw AppError.forbidden('Approving needs the senders.approve permission', 'PERMISSION_DENIED');
    await requireOrganization(id);
    const actor = actorFromRequest(req);
    const meta = metaFromRequest(req);
    let sender = await requestSender(id, { name: body.name, purpose: body.purpose, sampleMessage: body.sampleMessage, useCase: body.useCase }, actor, meta);
    await audit({ actor, action: 'SENDER_CREATED_BY_STAFF', resource: 'sender_id', resourceId: sender.id, organizationId: id, metadata: { byStaff: true, reason: body.reason, name: sender.name, approvedImmediately: body.approveNow }, meta });
    if (body.approveNow) sender = await reviewSender(sender.id, 'approve', body.reason, actor, meta);
    return created(res, sender, body.approveNow ? 'Sender ID created and approved' : 'Sender ID created and sent for review');
  }),
);

/** Withdraws a sender ID that was never used (pending, rejected or needs information). */
adminOrganizationOperationsRouter.post(
  '/:id/senders/:senderId/withdraw',
  requirePlatformPermission('senders.review'),
  asyncHandler(async (req, res) => {
    const { id, senderId } = parse(z.object({ id: z.string().uuid(), senderId: z.string().uuid() }), req.params);
    const body = parse(z.object({ reason }), req.body);
    const sender = await prisma.senderId.findFirst({ where: { id: senderId, organizationId: id } });
    if (!sender) throw AppError.notFound('Sender ID');
    const actor = actorFromRequest(req);
    const meta = metaFromRequest(req);
    await deleteSenderRequest(id, senderId, actor, meta);
    await audit({ actor, action: 'SENDER_WITHDRAWN_BY_STAFF', resource: 'sender_id', resourceId: senderId, organizationId: id, metadata: { byStaff: true, reason: body.reason, name: sender.name, status: sender.status }, meta });
    return ok(res, null, 'Sender ID withdrawn');
  }),
);

// ── Team ────────────────────────────────────────────────────────────────────

adminOrganizationOperationsRouter.patch(
  '/:id/members/:memberId',
  requirePlatformPermission('organizations.update'),
  asyncHandler(async (req, res) => {
    const { id, memberId } = parse(orgAndMember, req.params);
    const body = parse(z.object({ roleId: z.string().uuid().optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), reason }).refine((b) => b.roleId || b.status, { message: 'Change a role or a status' }), req.body);
    const member = await prisma.organizationMember.findFirst({ where: { id: memberId, organizationId: id }, include: { role: { select: { id: true, name: true } }, user: { select: { email: true } } } });
    if (!member) throw AppError.notFound('Member');
    if (member.isOwner) throw AppError.forbidden('The organization owner cannot be changed', 'OWNER_PROTECTED');
    if (body.roleId) {
      const role = await prisma.role.findFirst({ where: { id: body.roleId, scope: 'ORGANIZATION', code: { not: 'CUSTOMER_OWNER' }, OR: [{ organizationId: null }, { organizationId: id }] } });
      if (!role) throw AppError.unprocessable('Choose a valid role for this organization', 'INVALID_ROLE', [{ field: 'roleId', message: 'Invalid role' }]);
    }
    const updated = await prisma.organizationMember.update({ where: { id: memberId }, data: { roleId: body.roleId, status: body.status }, include: { role: { select: { id: true, name: true } } } });
    await audit({
      actor: actorFromRequest(req),
      action: 'MEMBER_UPDATED',
      resource: 'organization_member',
      resourceId: memberId,
      organizationId: id,
      metadata: { byStaff: true, reason: body.reason, email: member.user.email, before: { role: member.role.name, status: member.status }, after: { role: updated.role.name, status: updated.status } },
      meta: metaFromRequest(req),
    });
    return ok(res, { id: updated.id, status: updated.status, role: updated.role }, 'Member updated');
  }),
);

adminOrganizationOperationsRouter.post(
  '/:id/members/:memberId/remove',
  requirePlatformPermission('organizations.update'),
  asyncHandler(async (req, res) => {
    const { id, memberId } = parse(orgAndMember, req.params);
    const body = parse(z.object({ reason }), req.body);
    const member = await prisma.organizationMember.findFirst({ where: { id: memberId, organizationId: id }, include: { user: { select: { email: true } }, role: { select: { name: true } } } });
    if (!member) throw AppError.notFound('Member');
    if (member.isOwner) throw AppError.forbidden('The organization owner cannot be removed', 'OWNER_PROTECTED');
    await prisma.organizationMember.delete({ where: { id: memberId } });
    await audit({ actor: actorFromRequest(req), action: 'MEMBER_REMOVED', resource: 'organization_member', resourceId: memberId, organizationId: id, metadata: { byStaff: true, reason: body.reason, email: member.user.email, role: member.role.name }, meta: metaFromRequest(req) });
    return ok(res, null, 'Access removed');
  }),
);
