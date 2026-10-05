import { Prisma } from '@prisma/client';
import { prisma, type Db } from '../../config/prisma';
import { logger } from '../../config/logger';
import type { Actor, RequestMeta } from '../../types/actor';

export interface AuditEntry {
  actor: Actor;
  action: string;
  resource: string;
  resourceId?: string | null;
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  meta?: RequestMeta;
}

/**
 * Append an immutable audit record. Pass a transaction client to make the audit entry
 * commit atomically with the change it describes.
 */
export async function audit(entry: AuditEntry, db: Db = prisma): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorType: entry.actor.type,
        actorId: entry.actor.type === 'USER' ? entry.actor.userId : null,
        apiKeyId: entry.actor.type === 'API_KEY' ? entry.actor.apiKeyId : null,
        actorEmail: entry.actor.type === 'USER' ? entry.actor.email ?? null : null,
        organizationId: entry.organizationId ?? null,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId ?? null,
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        ipAddress: entry.meta?.ip ?? null,
        userAgent: entry.meta?.userAgent?.slice(0, 500) ?? null,
        requestId: entry.meta?.requestId ?? null,
      },
    });
  } catch (err) {
    // Inside a transaction, failing the audit must fail the operation.
    if (db !== prisma) throw err;
    logger.error({ err, action: entry.action }, 'Failed to write audit log');
  }
}
