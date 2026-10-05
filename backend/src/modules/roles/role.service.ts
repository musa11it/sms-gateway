import type { RoleScope } from '@prisma/client';
import { prisma } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { audit } from '../audit-logs/audit.service';
import { isFullAccessRole } from '../permissions/permission.service';

/**
 * Role management shared by platform roles (/admin/roles, organizationId = null) and
 * organization custom roles (/organization/roles).
 *
 * Anti-escalation rule: an actor can only grant permissions they hold themselves.
 * Full-access system roles (SUPER_ADMIN, CUSTOMER_OWNER) are immutable.
 */
interface Ctx {
  scope: RoleScope;
  organizationId: string | null;
  actorPermissions: Set<string>;
  actor: Actor;
  meta?: RequestMeta;
}

export async function listRoles(scope: RoleScope, organizationId: string | null) {
  const roles = await prisma.role.findMany({
    where: { scope, OR: [{ organizationId: null }, ...(organizationId ? [{ organizationId }] : [])] },
    include: {
      permissions: { include: { permission: { select: { key: true } } } },
      _count: { select: { users: true, members: organizationId ? { where: { organizationId } } : true } },
    },
    orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
  });
  const all = await prisma.permission.findMany({ where: { scope }, select: { key: true } });
  return roles.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem,
    isCustom: r.organizationId !== null,
    fullAccess: isFullAccessRole(r.code, r.isSystem),
    editable: !isFullAccessRole(r.code, r.isSystem) && (scope === 'PLATFORM' || r.organizationId !== null),
    permissions: isFullAccessRole(r.code, r.isSystem) ? all.map((p) => p.key) : r.permissions.map((p) => p.permission.key),
    assignedCount: scope === 'PLATFORM' ? r._count.users : r._count.members,
  }));
}

async function resolvePermissionIds(scope: RoleScope, keys: string[], actorPermissions: Set<string>) {
  const unique = [...new Set(keys)];
  const escalation = unique.filter((k) => !actorPermissions.has(k));
  if (escalation.length) {
    throw AppError.forbidden(`You cannot grant permissions you do not hold: ${escalation.join(', ')}`, 'PRIVILEGE_ESCALATION');
  }
  const perms = await prisma.permission.findMany({ where: { scope, key: { in: unique } } });
  if (perms.length !== unique.length) {
    const known = new Set(perms.map((p) => p.key));
    throw AppError.unprocessable(`Unknown permissions: ${unique.filter((k) => !known.has(k)).join(', ')}`, 'UNKNOWN_PERMISSION');
  }
  return perms.map((p) => p.id);
}

function codeFromName(name: string) {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'ROLE';
}

export async function createRole(ctx: Ctx, input: { name: string; description?: string | null; permissions: string[] }) {
  const code = codeFromName(input.name);
  const exists = await prisma.role.findFirst({ where: { scope: ctx.scope, code, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] } });
  if (exists) throw AppError.conflict('A role with this name already exists', 'ROLE_EXISTS');
  const permissionIds = await resolvePermissionIds(ctx.scope, input.permissions, ctx.actorPermissions);
  const role = await prisma.$transaction(async (tx) => {
    const role = await tx.role.create({
      data: {
        code,
        name: input.name,
        description: input.description,
        scope: ctx.scope,
        isSystem: false,
        organizationId: ctx.organizationId,
        permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
      },
    });
    await audit({ actor: ctx.actor, action: 'ROLE_CREATED', resource: 'role', resourceId: role.id, organizationId: ctx.organizationId, metadata: { name: role.name, permissions: input.permissions }, meta: ctx.meta }, tx);
    return role;
  });
  return role;
}

async function getEditableRole(ctx: Ctx, id: string) {
  const role = await prisma.role.findFirst({ where: { id, scope: ctx.scope } });
  if (!role) throw AppError.notFound('Role');
  if (ctx.scope === 'ORGANIZATION' && role.organizationId !== ctx.organizationId) {
    throw role.organizationId === null ? AppError.forbidden('Built-in roles cannot be modified; create a custom role instead', 'SYSTEM_ROLE') : AppError.notFound('Role');
  }
  if (isFullAccessRole(role.code, role.isSystem)) throw AppError.forbidden('This role always has full access and cannot be modified', 'SYSTEM_ROLE');
  return role;
}

export async function updateRole(ctx: Ctx, id: string, input: { name?: string; description?: string | null; permissions?: string[] }) {
  const role = await getEditableRole(ctx, id);
  const before = await prisma.rolePermission.findMany({ where: { roleId: id }, include: { permission: true } });
  const beforeKeys = before.map((b) => b.permission.key);
  let permissionIds: string[] | null = null;
  if (input.permissions) {
    // Only newly added permissions need to be held by the actor; removal is always allowed.
    const added = input.permissions.filter((k) => !beforeKeys.includes(k));
    await resolvePermissionIds(ctx.scope, added, ctx.actorPermissions);
    permissionIds = await resolvePermissionIds(ctx.scope, input.permissions, new Set([...ctx.actorPermissions, ...beforeKeys]));
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.role.update({ where: { id }, data: { name: input.name, description: input.description } });
    if (permissionIds) {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId: id, permissionId })) });
      await audit(
        {
          actor: ctx.actor,
          action: 'PERMISSION_CHANGED',
          resource: 'role',
          resourceId: id,
          organizationId: ctx.organizationId,
          metadata: {
            role: role.name,
            added: input.permissions!.filter((k) => !beforeKeys.includes(k)),
            removed: beforeKeys.filter((k) => !input.permissions!.includes(k)),
          },
          meta: ctx.meta,
        },
        tx,
      );
    }
    if (input.name || input.description !== undefined) {
      await audit({ actor: ctx.actor, action: 'ROLE_UPDATED', resource: 'role', resourceId: id, organizationId: ctx.organizationId, metadata: { name: input.name }, meta: ctx.meta }, tx);
    }
    return updated;
  });
}

export async function deleteRole(ctx: Ctx, id: string) {
  const role = await getEditableRole(ctx, id);
  if (role.isSystem) throw AppError.forbidden('System roles cannot be deleted', 'SYSTEM_ROLE');
  const inUse = (await prisma.userRole.count({ where: { roleId: id } })) + (await prisma.organizationMember.count({ where: { roleId: id } }));
  if (inUse > 0) throw AppError.conflict('Reassign users of this role before deleting it', 'ROLE_IN_USE');
  await prisma.$transaction(async (tx) => {
    await tx.organizationInvitation.updateMany({ where: { roleId: id, status: 'PENDING' }, data: { status: 'REVOKED' } });
    await tx.organizationInvitation.deleteMany({ where: { roleId: id } });
    await tx.role.delete({ where: { id } });
    await audit({ actor: ctx.actor, action: 'ROLE_DELETED', resource: 'role', resourceId: id, organizationId: ctx.organizationId, metadata: { name: role.name }, meta: ctx.meta }, tx);
  });
}

export async function listPermissionCatalog(scope: RoleScope) {
  const perms = await prisma.permission.findMany({ where: { scope }, orderBy: [{ group: 'asc' }, { key: 'asc' }] });
  return perms.map((p) => ({ key: p.key, group: p.group, description: p.description }));
}
