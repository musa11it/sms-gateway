import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/prisma';
import { SmsProviderFactory } from './integrations/sms/SmsProviderFactory';
import { PaymentProviderFactory } from './integrations/payments/PaymentProviderFactory';
import { createApp } from './app';
import { registerJobHandlers } from './workers/handlers';
import { queue } from './workers/queue';
import { startScheduler, stopScheduler } from './workers/scheduler';

async function main() {
  await prisma.$connect();
  const pay = PaymentProviderFactory.getActive();

  await SmsProviderFactory.refresh();
  SmsProviderFactory.startAutoRefresh();
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
    logger.info(`SMS providers: mode=${env.SMS_PROVIDER_MODE}${env.SMS_PROVIDER_MODE === 'simulation' ? ' (SIMULATION — no real SMS are sent)' : ''}; adapters: ${SmsProviderFactory.available().join(', ')}`);
    logger.info(`Payment provider: ${pay.name}${pay.isSimulation ? ' (SIMULATION — no real money moves)' : ''}`);
  });

  if (env.RUN_WORKERS) {
    registerJobHandlers();
    startScheduler();
    logger.info(`Workers running in-process (queue driver: ${env.QUEUE_DRIVER})`);
  }

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    stopScheduler();
    server.close();
    await queue.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
