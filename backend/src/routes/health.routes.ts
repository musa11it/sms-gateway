import fs from 'fs/promises';
import net from 'net';
import { Router } from 'express';
import { env, uploadRoot } from '../config/env';
import { prisma } from '../config/prisma';

/**
 * Public health endpoints for load balancers, uptime monitors and other systems.
 * They are deliberately unauthenticated and expose only up/down — never versions, hosts or errors.
 *
 *   GET /health        – readiness (same as /health/ready; kept for existing monitors)
 *   GET /health/live   – the process is running (200 always; use for restart decisions)
 *   GET /health/ready  – every dependency is reachable (503 when not; use for traffic routing)
 */
export const healthRouter = Router();

const CHECK_TIMEOUT_MS = 2000;
type CheckResult = 'up' | 'down';

async function check(fn: () => Promise<unknown>): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS)))]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

const database = () => prisma.$queryRaw`SELECT 1`;

const storage = async () => {
  await fs.mkdir(uploadRoot, { recursive: true });
  await fs.access(uploadRoot, fs.constants.W_OK);
};

/** Redis is only required when jobs run through BullMQ. */
const redis = () =>
  new Promise<void>((resolve, reject) => {
    const url = new URL(env.REDIS_URL);
    const socket = net.connect({ host: url.hostname, port: Number(url.port) || 6379 });
    socket.once('connect', () => (socket.destroy(), resolve()));
    socket.once('error', (e) => (socket.destroy(), reject(e)));
  });

async function readiness() {
  const checks: Record<string, CheckResult> = {
    database: await check(database),
    storage: await check(storage),
  };
  if (env.QUEUE_DRIVER === 'bullmq') checks.queue = await check(redis);
  const ready = Object.values(checks).every((c) => c === 'up');
  return { ready, body: { status: ready ? 'ok' : 'degraded', ...checks, time: new Date().toISOString() } };
}

healthRouter.get('/live', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ status: 'ok', time: new Date().toISOString() });
});

const ready = async (_req: unknown, res: import('express').Response) => {
  const { ready: ok, body } = await readiness();
  res.set('Cache-Control', 'no-store').status(ok ? 200 : 503).json(body);
};
healthRouter.get('/ready', ready);
healthRouter.get('/', ready);
