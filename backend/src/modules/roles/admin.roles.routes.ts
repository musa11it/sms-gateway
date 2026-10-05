import { Router } from 'express';
import { z } from 'zod';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { asyncHandler, created, ok, parse, uuidParam } from '../../utils/http';
import * as roles from './role.service';

export const adminRolesRouter = Router();

const roleBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional().nullable(),
  permissions: z.array(z.string().max(60)).max(200),
});

const ctx = (req: Express.Request) => ({
  scope: 'PLATFORM' as const,
  organizationId: null,
  actorPermissions: req.user!.platformPermissions,
  actor: actorFromRequest(req as never),
  meta: metaFromRequest(req as never),
});

adminRolesRouter.get('/', requirePlatformPermission('roles.view'), asyncHandler(async (_req, res) => ok(res, await roles.listRoles('PLATFORM', null))));

/** Organization role templates (Owner/Manager/Staff) for reference in the admin UI. */
adminRolesRouter.get('/organization-templates', requirePlatformPermission('roles.view'), asyncHandler(async (_req, res) => ok(res, await roles.listRoles('ORGANIZATION', null))));

adminRolesRouter.get(
  '/permissions',
  requirePlatformPermission('permissions.view'),
  asyncHandler(async (req, res) => {
    const scope = parse(z.object({ scope: z.enum(['PLATFORM', 'ORGANIZATION']).default('PLATFORM') }), req.query).scope;
    return ok(res, await roles.listPermissionCatalog(scope));
  }),
);

adminRolesRouter.post('/', requirePlatformPermission('roles.create'), asyncHandler(async (req, res) => created(res, await roles.createRole(ctx(req), parse(roleBody, req.body)), 'Role created')));

adminRolesRouter.patch(
  '/:id',
  requirePlatformPermission('roles.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    return ok(res, await roles.updateRole(ctx(req), id, parse(roleBody.partial(), req.body)), 'Role updated');
  }),
);

adminRolesRouter.delete(
  '/:id',
  requirePlatformPermission('roles.delete'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await roles.deleteRole(ctx(req), id);
    return ok(res, null, 'Role deleted');
  }),
);
