import crypto from 'crypto';
import type { Tx } from '../../config/prisma';
import { getSetting } from '../settings/settings.service';

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 40);
  return `${base || 'org'}-${crypto.randomBytes(3).toString('hex')}`;
}

export async function getSystemRole(tx: Tx, code: string, scope: 'PLATFORM' | 'ORGANIZATION') {
  const role = await tx.role.findFirst({ where: { code, scope, organizationId: null, isSystem: true } });
  if (!role) throw new Error(`System role ${code} missing — run the database seed`);
  return role;
}

/** Creates an organization with its owner membership, wallet and an empty verification. */
export async function createOrganizationWithOwner(tx: Tx, input: { name: string; ownerId: string }) {
  const ownerRole = await getSystemRole(tx, 'CUSTOMER_OWNER', 'ORGANIZATION');
  const threshold = await getSetting('wallet.defaultLowBalanceThreshold');
  const org = await tx.organization.create({
    data: {
      name: input.name,
      slug: slugify(input.name),
      status: 'DRAFT',
      members: { create: { userId: input.ownerId, roleId: ownerRole.id, isOwner: true } },
      wallet: { create: { balance: 0, lowBalanceThreshold: threshold } },
      verifications: { create: { status: 'DRAFT' } },
    },
  });
  return org;
}
