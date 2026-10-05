/**
 * Standalone worker process (use with QUEUE_DRIVER=bullmq and RUN_WORKERS=false on the API).
 *   npm run worker
 */
import { logger } from './config/logger';
import { prisma } from './config/prisma';
import { registerJobHandlers } from './workers/handlers';
import { queue } from './workers/queue';
import { startScheduler, stopScheduler } from './workers/scheduler';

async function main() {
  await prisma.$connect();
  registerJobHandlers();
  startScheduler();
  logger.info('Worker process started');
  const shutdown = async () => {
    stopScheduler();
    await queue.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
