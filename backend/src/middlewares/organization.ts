import type { RequestHandler } from 'express';
import { prisma } from '../config/prisma';
import { loadRolePermissions } from '../modules/permissions/permission.service';
import { AppError } from '../utils/errors';

/**
 * Resolves the tenant for the request from the `X-Organization-Id` header (or the user's
 * first membership) and loads the member's organization-scoped permissions.
 * Every tenant route runs behind this middleware and scopes queries by `req.org.id`.
 */
export const orgContext: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user) throw AppError.unauthorized();
    const requested = req.get('x-organization-id');
    if (requested && !/^[0-9a-f-]{36}$/i.test(requested)) throw AppError.badRequest('Invalid organization id');

    const membership = await prisma.organizationMember.findFirst({
      where: { userId: req.user.id, status: 'ACTIVE', ...(requested ? { organizationId: requested } : {}) },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) {
      throw requested
        ? AppError.forbidden('You are not a member of this organization', 'NOT_A_MEMBER')
        : AppError.forbidden('You do not belong to an organization yet', 'NO_ORGANIZATION');
    }

    const role = await loadRolePermissions(membership.roleId);
    req.org = {
      id: membership.organizationId,
      name: membership.organization.name,
      status: membership.organization.status,
      memberId: membership.id,
      roleCode: role.code,
      isOwner: membership.isOwner,
      permissions: role.permissions,
    };
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Operational gate: messaging, campaigns and public API require an approved, non-suspended
 * organization and an active user.
 */
export const requireActiveOrganization: RequestHandler = (req, _res, next) => {
  const org = req.org;
  if (!org) return next(AppError.forbidden('No organization selected', 'NO_ORGANIZATION'));
  if (org.status === 'SUSPENDED') {
    return next(AppError.forbidden('This organization is suspended. Messaging is disabled — contact support.', 'ORGANIZATION_SUSPENDED'));
  }
  if (org.status !== 'ACTIVE') {
    return next(
      AppError.forbidden('Your organization must be verified and approved before you can do this', 'ORGANIZATION_NOT_APPROVED'),
    );
  }
  if (req.user && req.user.status !== 'ACTIVE') {
    return next(AppError.forbidden('Your account is not active yet', 'ACCOUNT_INACTIVE'));
  }
  next();
};
