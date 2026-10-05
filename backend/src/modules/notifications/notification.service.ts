import { prisma, type Db } from '../../config/prisma';
import { logger } from '../../config/logger';

export type NotificationType =
  | 'ACCOUNT_APPROVED'
  | 'ACCOUNT_REJECTED'
  | 'VERIFICATION_CHANGES_REQUESTED'
  | 'VERIFICATION_SUBMITTED'
  | 'SENDER_APPROVED'
  | 'SENDER_REJECTED'
  | 'SENDER_NEEDS_INFORMATION'
  | 'SENDER_SUSPENDED'
  | 'SENDER_REQUESTED'
  | 'PAYMENT_SUCCESS'
  | 'PAYMENT_FAILED'
  | 'WALLET_CREDITED'
  | 'WALLET_DEBITED'
  | 'LOW_BALANCE'
  | 'SENDER_ALLOCATION_LOW'
  | 'CREDITS_EXPIRED'
  | 'CAMPAIGN_COMPLETED'
  | 'CAMPAIGN_FAILED'
  | 'API_KEY_CREATED'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_REACTIVATED'
  | 'TEAM_JOINED';

interface NotifyInput {
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
}

export async function notifyUser(userId: string, organizationId: string | null, n: NotifyInput, db: Db = prisma) {
  await db.notification.create({ data: { userId, organizationId, ...n } });
}

/**
 * Notify active members of an organization. When `permission` is given, only members
 * whose role grants it are notified (e.g. billing alerts go to people who can buy credits).
 */
export async function notifyOrganization(organizationId: string, n: NotifyInput, permission?: string, db: Db = prisma) {
  try {
    const members = await db.organizationMember.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        ...(permission
          ? {
              OR: [
                { isOwner: true },
                { role: { permissions: { some: { permission: { key: permission, scope: 'ORGANIZATION' } } } } },
              ],
            }
          : {}),
      },
      select: { userId: true },
    });
    if (members.length === 0) return;
    await db.notification.createMany({ data: members.map((m) => ({ userId: m.userId, organizationId, ...n })) });
  } catch (err) {
    if (db !== prisma) throw err;
    logger.error({ err, organizationId, type: n.type }, 'Failed to create notifications');
  }
}

/** Notify platform staff holding a given platform permission (e.g. new verification to review). */
export async function notifyStaff(permission: string, n: NotifyInput) {
  try {
    const users = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        roles: {
          some: {
            role: {
              scope: 'PLATFORM',
              OR: [{ code: 'SUPER_ADMIN' }, { permissions: { some: { permission: { key: permission, scope: 'PLATFORM' } } } }],
            },
          },
        },
      },
      select: { id: true },
    });
    if (users.length === 0) return;
    await prisma.notification.createMany({ data: users.map((u) => ({ userId: u.id, organizationId: null, ...n })) });
  } catch (err) {
    logger.error({ err, type: n.type }, 'Failed to notify staff');
  }
}
