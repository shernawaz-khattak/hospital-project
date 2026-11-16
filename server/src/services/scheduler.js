// Background jobs performed by the "System" actor (SRS actor 9). Jobs are registered by
// their modules; see registerJob() callers. Times use the hospital timezone.
import cron from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const jobs = [];
const tasks = [];

/** @param {string} name @param {string} expression cron expression @param {() => Promise<void>} fn */
export function registerJob(name, expression, fn) {
  jobs.push({ name, expression, fn, lastRunAt: null, lastStatus: null, lastError: null, running: false });
}

export async function runJob(job) {
  if (job.running) return;
  job.running = true;
  try {
    await job.fn();
    job.lastStatus = 'ok';
    job.lastError = null;
  } catch (err) {
    job.lastStatus = 'error';
    job.lastError = err.message;
    logger.error(`Scheduled job "${job.name}" failed`, err);
  } finally {
    job.lastRunAt = new Date();
    job.running = false;
  }
}

export function startScheduler() {
  for (const job of jobs) {
    tasks.push(cron.schedule(job.expression, () => runJob(job), { timezone: env.HOSPITAL_TZ }));
  }
  logger.info(`Scheduler started with ${jobs.length} jobs`, jobs.map((j) => `${j.name} (${j.expression})`));
}

export function stopScheduler() {
  for (const t of tasks) t.stop();
  tasks.length = 0;
}

export const jobStatus = () => jobs.map(({ name, expression, lastRunAt, lastStatus, lastError }) => ({ name, expression, lastRunAt, lastStatus, lastError, enabled: env.ENABLE_SCHEDULER }));
