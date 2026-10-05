import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Background job queue abstraction.
 *
 * - QUEUE_DRIVER=memory : in-process queue with retries/backoff (local development).
 * - QUEUE_DRIVER=bullmq : Redis-backed BullMQ queue (production, multiple workers).
 *
 * Business code only calls `queue.enqueue(...)`. All work that must survive a restart is
 * additionally persisted in the database (message/recipient status, webhook deliveries,
 * payment status) and recovered by the periodic sweeps in `scheduler.ts`, so losing the
 * in-memory queue never loses work.
 */
export interface JobPayloads {
  'sms.dispatch': { messageId: string };
  'webhook.deliver': { deliveryId: string };
  'wallet.lowBalanceCheck': { organizationId: string };
  'email.send': { emailId: string };
  'payment.verify': { paymentId: string };
}

export type JobName = keyof JobPayloads;
export type JobHandler<N extends JobName> = (payload: JobPayloads[N]) => Promise<void>;

export interface EnqueueOptions {
  delayMs?: number;
  attempts?: number;
  /** Deduplicates jobs with the same id while one is pending. */
  jobId?: string;
}

export interface JobQueue {
  enqueue<N extends JobName>(name: N, payload: JobPayloads[N], opts?: EnqueueOptions): Promise<void>;
  process<N extends JobName>(name: N, handler: JobHandler<N>, concurrency?: number): void;
  close(): Promise<void>;
}

// ── In-memory implementation ──────────────────────────────────────────

interface MemJob {
  name: JobName;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  jobId?: string;
}

class InMemoryQueue implements JobQueue {
  private handlers = new Map<JobName, { fn: (p: unknown) => Promise<void>; concurrency: number; running: number; waiting: MemJob[] }>();
  private pendingIds = new Set<string>();
  private timers = new Set<NodeJS.Timeout>();
  private closed = false;

  async enqueue<N extends JobName>(name: N, payload: JobPayloads[N], opts: EnqueueOptions = {}) {
    if (this.closed) return;
    const key = opts.jobId ? `${name}:${opts.jobId}` : undefined;
    if (key && this.pendingIds.has(key)) return;
    if (key) this.pendingIds.add(key);
    const job: MemJob = { name, payload, attempts: 0, maxAttempts: opts.attempts ?? 3, jobId: key };
    this.schedule(job, opts.delayMs ?? 0);
  }

  private schedule(job: MemJob, delayMs: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      const h = this.handlers.get(job.name);
      if (!h) {
        // No worker in this process (RUN_WORKERS=false). DB sweeps will pick the work up.
        if (job.jobId) this.pendingIds.delete(job.jobId);
        return;
      }
      h.waiting.push(job);
      this.drain(job.name);
    }, delayMs);
    t.unref?.();
    this.timers.add(t);
  }

  private drain(name: JobName) {
    const h = this.handlers.get(name);
    if (!h) return;
    while (h.running < h.concurrency && h.waiting.length > 0) {
      const job = h.waiting.shift()!;
      h.running += 1;
      job.attempts += 1;
      h.fn(job.payload)
        .then(() => {
          if (job.jobId) this.pendingIds.delete(job.jobId);
        })
        .catch((err) => {
          if (job.attempts < job.maxAttempts && !this.closed) {
            const backoff = Math.min(60_000, 1000 * 2 ** job.attempts);
            logger.warn({ err, job: job.name, attempt: job.attempts }, 'Job failed, retrying');
            this.schedule(job, backoff);
          } else {
            if (job.jobId) this.pendingIds.delete(job.jobId);
            logger.error({ err, job: job.name, payload: job.payload }, 'Job failed permanently');
          }
        })
        .finally(() => {
          h.running -= 1;
          this.drain(name);
        });
    }
  }

  process<N extends JobName>(name: N, handler: JobHandler<N>, concurrency = 5) {
    this.handlers.set(name, { fn: handler as (p: unknown) => Promise<void>, concurrency, running: 0, waiting: [] });
  }

  async close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

// ── BullMQ (Redis) implementation ─────────────────────────────────────

class BullMqQueue implements JobQueue {
  // Typed loosely so the module is only loaded when this driver is selected.
  private queues = new Map<string, any>();
  private workers: any[] = [];
  private connection = { url: env.REDIS_URL };

  private async getQueue(name: string) {
    if (!this.queues.has(name)) {
      const { Queue } = await import('bullmq');
      this.queues.set(name, new Queue(name.replace('.', '-'), { connection: this.connection }));
    }
    return this.queues.get(name);
  }

  async enqueue<N extends JobName>(name: N, payload: JobPayloads[N], opts: EnqueueOptions = {}) {
    const q = await this.getQueue(name);
    await q.add(name, payload, {
      delay: opts.delayMs,
      attempts: opts.attempts ?? 3,
      jobId: opts.jobId,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  process<N extends JobName>(name: N, handler: JobHandler<N>, concurrency = 5) {
    void import('bullmq').then(({ Worker }) => {
      const w = new Worker(name.replace('.', '-'), async (job: { data: JobPayloads[N] }) => handler(job.data), {
        connection: this.connection,
        concurrency,
      });
      w.on('failed', (job: unknown, err: Error) => logger.error({ err, job: name }, 'BullMQ job failed'));
      this.workers.push(w);
    });
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

export const queue: JobQueue = env.QUEUE_DRIVER === 'bullmq' ? new BullMqQueue() : new InMemoryQueue();
