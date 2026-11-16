// Express application (Application Layer of the SRS three-tier architecture, §4.1).
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env, isProd } from './config/env.js';
import { requestMetrics } from './middleware/metrics.js';
import { requireAuth, requireCsrfHeader, requirePermission } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { emailMode } from './services/email.js';
import { db } from './db/knex.js';

import authRoutes from './modules/auth/routes.js';
import userRoutes from './modules/users/routes.js';
import departmentRoutes from './modules/departments/routes.js';
import doctorRoutes from './modules/doctors/routes.js';
import staffRoutes from './modules/staff/routes.js';
import nurseRoutes from './modules/staff/nurseRoutes.js';
import patientRoutes from './modules/patients/routes.js';
import notificationRoutes, { eventStream } from './modules/notifications/routes.js';
import draftRoutes from './modules/drafts/routes.js';
import devRoutes from './modules/dev/routes.js';
import { moduleRoutes } from './modules/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1); // behind nginx / a TLS-terminating proxy

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
          upgradeInsecureRequests: env.COOKIE_SECURE ? [] : null,
        },
      },
      hsts: env.COOKIE_SECURE ? { maxAge: 15552000, includeSubDomains: true } : false,
    }),
  );
  if (env.CORS_ORIGIN) {
    const allowedOrigins = env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
    app.use(cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
    }));
  }
  app.use(requestMetrics);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store'); // never cache patient data in browsers/proxies
    next();
  });
  app.use('/api', requireCsrfHeader);

  // Public endpoints
  app.get('/api/health/live', async (_req, res) => {
    try {
      await db.raw('select 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database_unavailable' });
    }
  });
  app.get('/api/meta', (_req, res) => res.json({ hospitalName: env.HOSPITAL_NAME, emailMode: emailMode(), devOutbox: env.NODE_ENV === 'development' && emailMode() === 'dev-outbox' }));
  app.use('/api/auth', authRoutes);

  // Everything below requires a valid session
  app.use('/api', requireAuth);
  app.get('/api/events', eventStream);
  app.use('/api/users', userRoutes);
  app.use('/api/departments', departmentRoutes);
  app.use('/api/doctors', doctorRoutes);
  app.use('/api/staff', staffRoutes);
  app.use('/api/nurses', nurseRoutes);
  app.use('/api/patients', patientRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/drafts', draftRoutes);
  // Development mailbox: only in development without SMTP, and only for system administrators,
  // because captured messages contain password-reset links.
  if (env.NODE_ENV === 'development' && emailMode() === 'dev-outbox') app.use('/api/dev', requirePermission('system.health'), devRoutes);
  for (const [prefix, router] of moduleRoutes) app.use(`/api/${prefix}`, router);
  app.use('/api', notFoundHandler);

  // Serve the built frontend (single deployable unit) when it exists.
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, maxAge: isProd ? '1h' : 0 }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
