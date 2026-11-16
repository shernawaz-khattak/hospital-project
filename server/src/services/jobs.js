// Automated jobs performed by the "System" actor.
import { env } from '../config/env.js';
import { registerJob } from './scheduler.js';
import { runBackup } from './backup.js';
import { runHealthCheck } from './health.js';
import { processPendingDeliveries } from './notifications.js';
import { sendDueReminders } from '../modules/appointments/service.js';
import { scanExpiry } from '../modules/pharmacy/service.js';

let retryTimer = null;

export function registerJobs() {
  registerJob('Daily database backup', env.BACKUP_CRON, () => runBackup('automatic')); // UC-45: midnight
  registerJob('Hourly system health check', env.HEALTH_CRON, () => runHealthCheck('automatic')); // UC-46
  registerJob('Appointment reminders', '*/15 * * * *', () => sendDueReminders());
  registerJob('Medicine expiry scan', '0 6 * * *', () => scanExpiry()); // UC-38
  // Notification retries (UC-33 / UC-47): attempts are 15 s apart, 3 attempts max.
  retryTimer = setInterval(() => processPendingDeliveries().catch(() => {}), 15_000);
  retryTimer.unref();
}

export function stopJobs() {
  if (retryTimer) clearInterval(retryTimer);
}

export { scanExpiry };
