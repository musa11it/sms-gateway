import crypto from 'crypto';
import { logger } from '../config/logger';
import { prisma } from '../config/prisma';
import { reconcilePendingPayments } from '../modules/payments/payment.service';
import {
  pollPendingDeliveryStatuses,
  recoverStalledDispatches,
  releaseDueScheduledMessages,
} from '../modules/sms/sms.service';
import { expireCreditLots } from '../modules/wallet/wallet.service';
import { enqueueDueWebhookDeliveries } from '../modules/webhooks/webhook.service';

/**
 * Periodic, database-driven sweeps. Each task is guarded by a lease row (job_leases) so only
 * one instance executes it at a time when several API/worker processes are deployed.
 */
interface Task {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

const tasks: Task[] = [
  { name: 'release-scheduled-sms', everyMs: 10_000, run: releaseDueScheduledMessages },
  { name: 'poll-delivery-status', everyMs: 15_000, run: () => pollPendingDeliveryStatuses() },
  { name: 'retry-webhooks', everyMs: 10_000, run: enqueueDueWebhookDeliveries },
  { name: 'recover-stalled-dispatch', everyMs: 60_000, run: recoverStalledDispatches },
  { name: 'reconcile-payments', everyMs: 30_000, run: reconcilePendingPayments },
  { name: 'expire-credit-lots', everyMs: 3_600_000, run: expireCreditLots },
  {
    name: 'expire-invitations',
    everyMs: 3_600_000,
    run: () => prisma.organizationInvitation.updateMany({ where: { status: 'PENDING', expiresAt: { lt: new Date() } }, data: { status: 'EXPIRED' } }),
  },
];

const OWNER = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const LEASE_MS = 5 * 60_000;

async function acquireLease(name: string): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + LEASE_MS);
  // First claim of a task creates the lease row; afterwards it can only be taken over once expired (or renewed by its owner).
  const inserted = await prisma.$executeRaw`
    INSERT IGNORE INTO job_leases (name, owner, lockedUntil) VALUES (${name}, ${OWNER}, ${until})`;
  if (inserted === 1) return true;
  const rows = await prisma.$executeRaw`
    UPDATE job_leases SET owner = ${OWNER}, lockedUntil = ${until}
    WHERE name = ${name} AND (lockedUntil < ${now} OR owner = ${OWNER})`;
  return rows === 1;
}

async function releaseLease(name: string) {
  await prisma.jobLease.updateMany({ where: { name, owner: OWNER }, data: { lockedUntil: new Date(0) } });
}

const timers: NodeJS.Timeout[] = [];
const running = new Set<string>();

export function startScheduler() {
  for (const task of tasks) {
    const tick = async () => {
      if (running.has(task.name)) return;
      running.add(task.name);
      try {
        if (!(await acquireLease(task.name))) return;
        try {
          await task.run();
        } finally {
          await releaseLease(task.name);
        }
      } catch (err) {
        logger.error({ err, task: task.name }, 'Scheduled task failed');
      } finally {
        running.delete(task.name);
      }
    };
    timers.push(setInterval(tick, task.everyMs));
    setTimeout(tick, 2_000).unref();
  }
  logger.info({ tasks: tasks.map((t) => t.name) }, 'Scheduler started');
}

export function stopScheduler() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
