import { prisma } from '../../config/prisma';
import { orgKeys, platformKeys } from './catalog';

/** Role codes whose permissions are implicitly "everything in scope". */
const FULL_PLATFORM_ROLE = 'SUPER_ADMIN';
const FULL_ORG_ROLE = 'CUSTOMER_OWNER';

export async function loadPlatformAccess(userId: string): Promise<{ roles: string[]; permissions: Set<string> }> {
  const userRoles = await prisma.userRole.findMany({
    where: { userId, role: { scope: 'PLATFORM' } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  const roles = userRoles.map((ur) => ur.role.code);
  if (roles.includes(FULL_PLATFORM_ROLE)) return { roles, permissions: new Set(platformKeys) };
  const permissions = new Set<string>();
  for (const ur of userRoles) {
    for (const rp of ur.role.permissions) {
      if (rp.permission.scope === 'PLATFORM') permissions.add(rp.permission.key);
    }
  }
  return { roles, permissions };
}

export async function loadRolePermissions(roleId: string): Promise<{ code: string; isSystem: boolean; permissions: Set<string> }> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { id: roleId },
    include: { permissions: { include: { permission: true } } },
  });
  if (role.isSystem && role.code === FULL_ORG_ROLE) return { code: role.code, isSystem: true, permissions: new Set(orgKeys) };
  return {
    code: role.code,
    isSystem: role.isSystem,
    permissions: new Set(role.permissions.filter((rp) => rp.permission.scope === role.scope).map((rp) => rp.permission.key)),
  };
}

export function isFullAccessRole(code: string, isSystem: boolean) {
  return isSystem && (code === FULL_PLATFORM_ROLE || code === FULL_ORG_ROLE);
}
