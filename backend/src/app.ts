import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { generalLimiter } from './middlewares/rateLimit';
import { httpLogger, requestId } from './middlewares/requestContext';
import { callbacksRouter } from './routes/callbacks.routes';
import { apiRouter } from './routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Trust the first proxy hop (load balancer) so req.ip is the client address.
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(httpLogger);
  app.use(helmet());
  app.use(
    cors({
      origin: env.FRONTEND_URL,
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'X-Unread-Count', 'RateLimit', 'RateLimit-Policy'],
    }),
  );

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', database: 'up', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  // Provider callbacks need the raw body for signature verification — mount before JSON parsing.
  app.use('/api/v1/callbacks', callbacksRouter);

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());
  app.use('/api', generalLimiter);
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
