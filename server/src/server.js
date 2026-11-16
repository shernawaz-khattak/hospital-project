import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { db, closeDb } from './db/knex.js';
import { logger } from './lib/logger.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { registerJobs, stopJobs, scanExpiry } from './services/jobs.js';

const app = createApp();

// HTTPS (SRS §4.2.3): either terminate TLS here by providing a key/cert, or run behind a
// TLS reverse proxy (see docs/DEPLOYMENT.md) with COOKIE_SECURE=true and TRUST_PROXY=true.
const server =
  env.HTTPS_KEY_PATH && env.HTTPS_CERT_PATH
    ? https.createServer({ key: fs.readFileSync(env.HTTPS_KEY_PATH), cert: fs.readFileSync(env.HTTPS_CERT_PATH) }, app)
    : http.createServer(app);

async function main() {
  await db.raw('select 1');
  for (const dir of [env.UPLOAD_DIR, env.BACKUP_DIR]) fs.mkdirSync(dir, { recursive: true });
  server.listen(env.PORT, () => logger.info(`HMS API listening on ${env.HTTPS_KEY_PATH ? 'https' : 'http'}://localhost:${env.PORT} (${env.NODE_ENV})`));
  registerJobs();
  if (env.ENABLE_SCHEDULER) {
    startScheduler();
    scanExpiry().catch((err) => logger.error('Startup expiry scan failed', err));
  }
}

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  stopScheduler();
  stopJobs();
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  logger.error('Failed to start server', err);
  process.exit(1);
});
