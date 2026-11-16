// System health check (SRS FR-32, UC-46). Runs on demand and hourly; when any component is
// not healthy the administrator is alerted and the result is logged.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { db } from '../db/knex.js';
import { env } from '../config/env.js';
import { metricsSnapshot } from '../middleware/metrics.js';
import { jobStatus } from './scheduler.js';
import { emailMode } from './email.js';
import { audit, systemCtx } from './audit.js';
import { notify } from './notifications.js';
import { connectedClientCount } from './realtime.js';
import { uploadStorage } from './storage/index.js';

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const component = (name, status, detail, metrics = {}) => ({ name, status, detail, metrics });

async function checkDatabase() {
  const t = Date.now();
  try {
    await db.raw('select 1');
    const ms = Date.now() - t;
    const { rows } = await db.raw("SELECT pg_database_size(current_database())::bigint AS size, (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS connections");
    const status = ms > 1000 ? 'warning' : 'ok';
    return component('Database connectivity', status, status === 'ok' ? `Connected (${ms} ms)` : `Slow response (${ms} ms)`, { latencyMs: ms, sizeBytes: Number(rows[0].size), connections: rows[0].connections, poolMax: env.DB_POOL_MAX });
  } catch (err) {
    return component('Database connectivity', 'error', `Cannot reach the database: ${err.message}`);
  }
}

async function checkDisk(dir, label) {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.health-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe);
    const s = await fs.statfs(dir);
    const free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    const pct = total ? (free / total) * 100 : 100;
    const status = pct < 2 ? 'error' : pct < 10 ? 'warning' : 'ok';
    return component(label, status, `${(free / 1e9).toFixed(1)} GB free (${pct.toFixed(0)}%)`, { freeBytes: free, totalBytes: total });
  } catch (err) {
    return component(label, 'error', `Storage not writable: ${err.message}`);
  }

}

async function checkObjectStorage() {
  if (env.STORAGE_PROVIDER === 'local') return component('Object storage', 'ok', 'Local storage selected; remote readiness is not applicable.');
  if (!env.R2_BUCKET_UPLOADS || !env.R2_BUCKET_BACKUPS || !env.R2_ENDPOINT) {
    return component('Object storage', 'error', 'Object-storage configuration is incomplete.');
  }
  try {
    // Configuration-only readiness: ordinary liveness and health checks never
    // create, inspect, or delete customer objects.
    await uploadStorage();
    return component('Object storage', 'ok', 'Object-storage configuration is initialized.');
  } catch {
    return component('Object storage', 'warning', 'Object-storage configuration could not be initialized.');
  }
}

function checkServer() {
  const mem = process.memoryUsage();
  const lag = loopDelay.percentile(99) / 1e6;
  loopDelay.reset();
  const status = lag > 500 ? 'warning' : 'ok';
  return component('Application server', status, `Up ${Math.round(process.uptime() / 60)} min, event-loop p99 ${lag.toFixed(1)} ms`, {
    uptimeSeconds: Math.round(process.uptime()), rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, eventLoopP99Ms: Math.round(lag * 10) / 10, loadAverage: os.loadavg().map((x) => Math.round(x * 100) / 100), cpus: os.cpus().length, liveConnections: connectedClientCount(), node: process.version,
  });
}

function checkPerformance() {
  const m = metricsSnapshot();
  // NFR-04 target: common actions under 3 s. Measured over the recent request window.
  const status = m.sampleSize === 0 ? 'ok' : m.p95Ms > 3000 ? 'error' : m.p95Ms > 1500 ? 'warning' : 'ok';
  return component('API performance', status, m.sampleSize ? `p95 ${m.p95Ms} ms over the last ${m.sampleSize} requests` : 'No requests measured yet', m);
}

async function checkBackups() {
  const last = await db('backups').where({ status: 'success' }).orderBy('completed_at', 'desc').first();
  const lastFailed = await db('backups').where({ status: 'failed' }).orderBy('started_at', 'desc').first();
  if (!last) return component('Backups', 'warning', 'No successful backup yet.');
  const hours = (Date.now() - new Date(last.completed_at)) / 3600000;
  const failedSince = lastFailed && new Date(lastFailed.started_at) > new Date(last.completed_at);
  const status = hours > 26 || failedSince ? 'warning' : 'ok';
  return component('Backups', status, `Last successful backup ${hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`} ago${failedSince ? '; a later backup failed' : ''}`, { lastBackupAt: last.completed_at, sizeBytes: last.size_bytes });
}

async function checkNotifications() {
  const since = new Date(Date.now() - 86400000);
  const [failed, pending] = await Promise.all([
    db('notification_deliveries').where({ status: 'failed' }).where('created_at', '>', since).count({ n: '*' }).first(),
    db('notification_deliveries').where({ status: 'pending' }).where('created_at', '<', new Date(Date.now() - 120000)).count({ n: '*' }).first(),
  ]);
  const status = Number(failed.n) > 0 || Number(pending.n) > 0 ? 'warning' : 'ok';
  return component('Notifications', status, `Email mode: ${emailMode()}. Failed in 24 h: ${failed.n}. Stuck pending: ${pending.n}.`, { failed24h: Number(failed.n), stuckPending: Number(pending.n), emailMode: emailMode() });
}

function checkScheduler() {
  const jobs = jobStatus();
  const failing = jobs.filter((j) => j.lastStatus === 'error');
  const status = !env.ENABLE_SCHEDULER ? 'warning' : failing.length ? 'warning' : 'ok';
  const detail = !env.ENABLE_SCHEDULER ? 'Scheduler disabled (ENABLE_SCHEDULER=false): automatic backups and checks will not run.' : failing.length ? `Failing jobs: ${failing.map((j) => j.name).join(', ')}` : `${jobs.length} jobs scheduled`;
  return component('Scheduled jobs', status, detail, { jobs });
}

export async function runHealthCheck(type = 'automatic', ctx = systemCtx) {
  const started = Date.now();
  const components = [await checkDatabase(), checkServer(), checkPerformance()];
  const objectStorage = await checkObjectStorage();
  if (objectStorage) components.push(objectStorage);
  else components.push(await checkDisk(path.resolve(env.BACKUP_DIR), 'Backup storage'), await checkDisk(path.resolve(env.UPLOAD_DIR), 'Report storage'));
  if (components[0].status !== 'error') components.push(await checkBackups(), await checkNotifications());
  components.push(checkScheduler());
  const livenessComponents = components.filter((c) => c.name !== 'Object storage');
  const overall = components[0].status === 'error' ? 'down' : livenessComponents.some((c) => c.status !== 'ok') ? 'degraded' : 'healthy';
  const duration = Date.now() - started;
  let id = null;
  try {
    const [row] = await db('health_checks').insert({ overall_status: overall, components: JSON.stringify(components), check_type: type, duration_ms: duration, triggered_by: ctx.user?.id ?? null }).returning('id');
    id = row.id;
    await audit(ctx, { action: 'system.health_check', entityType: 'health_check', entityId: id, status: overall === 'healthy' ? 'success' : 'failure', details: { overall, issues: components.filter((c) => c.status !== 'ok').map((c) => c.name) } });
    if (overall !== 'healthy') {
      await notify(db, { permission: 'system.health', priority: 'high', email: overall === 'down', eventType: 'system.health_issue', title: `System health: ${overall}`, message: components.filter((c) => c.status !== 'ok').map((c) => `${c.name}: ${c.detail}`).join(' | '), link: '/system/health' });
    }
  } catch {
    // Database down: the result is still returned to the caller.
  }
  return { id, overall, components, durationMs: duration, checkedAt: new Date(), checkType: type };
}
