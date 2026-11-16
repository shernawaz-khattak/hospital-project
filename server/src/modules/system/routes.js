// System & admin services (SRS FR-31, FR-32; UC-45 Backup, UC-46 Health Check) and audit log.
import { Router } from 'express';
import { db } from '../../db/knex.js';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { runBackup, backupFile, backupRunning, legacyBackupInventory, retryBackupRetention } from '../../services/backup.js';
import { runHealthCheck } from '../../services/health.js';
import { jobStatus } from '../../services/scheduler.js';
import { audit } from '../../services/audit.js';
import { env } from '../../config/env.js';
import { reconcileOrphan } from '../../services/storageReconciliation.js';

const router = Router();

// ----------------------------------------------------------------- backups
router.get('/backups', requirePermission('system.backup'), async (_req, res) => {
  const rows = await db('backups as b').leftJoin('users as u', 'u.id', 'b.triggered_by').orderBy('b.started_at', 'desc').limit(100).select('b.*', 'u.full_name as triggered_by_name');
  res.json({
    running: backupRunning(), schedule: env.BACKUP_CRON, schedulerEnabled: env.ENABLE_SCHEDULER, retentionDays: env.BACKUP_RETENTION_DAYS,
    data: rows.map((b) => ({ id: b.id, fileName: b.file_name, sizeBytes: b.size_bytes, sha256: b.sha256, type: b.backup_type, status: b.status, error: b.error, startedAt: b.started_at, completedAt: b.completed_at, triggeredByName: b.triggered_by_name ?? 'System (scheduled)', downloadable: Boolean(b.file_name && b.status === 'success' && !['pending_deletion', 'deletion_failed', 'pending_metadata_reconciliation'].includes(b.retention_state)) })),
  });
});

router.get('/backups/legacy-inventory', requirePermission('system.backup'), async (_req, res) => {
  const rows = await legacyBackupInventory();
  res.json({ data: rows.map((b) => ({
    id: b.id, fileName: b.file_name, sizeBytes: b.size_bytes, startedAt: b.started_at,
    status: b.status, storageProvider: b.storage_provider || null,
    retentionAction: 'manual_review_required', objectExists: 'unknown',
  })) });
});

router.get('/storage-reconciliations', requirePermission('storage.reconcile'), async (_req, res) => {
  const rows = await db('storage_reconciliations').orderBy('created_at', 'desc').limit(200);
  res.json({ data: rows.map((r) => ({ id: r.id, provider: r.provider, operation: r.operation, status: r.status, failureReason: r.failure_reason, attemptCount: r.attempt_count, createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at })) });
});

router.post('/storage-reconciliations/:id/retry', requirePermission('storage.reconcile'), validate({ params: idParam }), async (req, res) => {
  const row = await db('storage_reconciliations').where({ id: req.validParams.id }).first();
  if (!row) throw notFound('Storage reconciliation record was not found.');
  const requiredPermission = String(row.operation).startsWith('backup_') ? 'system.backup' : 'lab.process';
  if (!req.user.permissions.includes(requiredPermission)) {
    throw new AppError(403, 'The required permission for this object type was not granted.');
  }
  const result = await reconcileOrphan(req.validParams.id, req);
  res.json(result);
});

router.post('/backups', requirePermission('system.backup'), async (req, res) => {
  if (backupRunning()) throw conflict('A backup is already running.');
  try {
    const b = await runBackup('manual', req);
    res.status(201).json({ id: b.id, fileName: b.file_name, sizeBytes: b.size_bytes, sha256: b.sha256, completedAt: b.completed_at, message: `Backup completed at ${new Date(b.completed_at).toLocaleString()}.` });
  } catch (err) {
    throw new AppError(500, err.message.startsWith('Backup failed') ? err.message : 'Backup failed.', { code: 'BACKUP_FAILED' });
  }
});

router.post('/backups/:id/retention-retry', requirePermission('system.backup'), validate({ params: idParam }), async (req, res) => {
  const result = await retryBackupRetention(req.validParams.id, req);
  if (!result) throw notFound('Backup retention record was not found or is not retryable.');
  res.json(result);
});

router.get('/backups/:id/download', requirePermission('system.backup'), validate({ params: idParam }), async (req, res) => {
  const f = await backupFile(req.validParams.id);
  if (!f) throw notFound('Backup file is not available.');
  await audit(req, { action: 'system.backup_download', entityType: 'backup', entityId: req.validParams.id });
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${f.backup.file_name}"`,
    'Cache-Control': 'private, no-store',
  });
  if (f.metadata?.size) res.set('Content-Length', String(f.metadata.size));
  f.stream.on('error', () => {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  f.stream.pipe(res);
});

// ----------------------------------------------------------------- health
router.get('/health', requirePermission('system.health'), async (_req, res) => {
  const rows = await db('health_checks').orderBy('checked_at', 'desc').limit(48);
  res.json({ latest: rows[0] ? { id: rows[0].id, overall: rows[0].overall_status, components: rows[0].components, checkedAt: rows[0].checked_at, durationMs: rows[0].duration_ms, checkType: rows[0].check_type } : null, history: rows.map((r) => ({ id: r.id, overall: r.overall_status, checkedAt: r.checked_at, checkType: r.check_type, durationMs: r.duration_ms })) });
});
router.post('/health/run', requirePermission('system.health'), async (req, res) => res.json(await runHealthCheck('manual', req)));
router.get('/jobs', requirePermission('system.health', 'system.backup'), (_req, res) => res.json({ data: jobStatus() }));

router.get('/notification-log', requirePermission('system.health'), validate({ query: z.object({ status: z.enum(['pending', 'delivered', 'captured', 'failed', 'skipped']).optional(), channel: z.enum(['in_app', 'email']).optional() }) }), async (req, res) => {
  const q = db('notification_deliveries as d').join('notifications as n', 'n.id', 'd.notification_id').orderBy('d.created_at', 'desc').limit(200)
    .select('d.id', 'd.channel', 'd.recipient', 'd.status', 'd.attempts', 'd.last_error', 'd.created_at', 'd.delivered_at', 'n.event_type', 'n.title');
  if (req.validQuery.status) q.where('d.status', req.validQuery.status);
  if (req.validQuery.channel) q.where('d.channel', req.validQuery.channel);
  // Recipients are partially masked: the log shows delivery health, not who received what.
  res.json({ data: (await q).map((d) => ({ ...d, recipient: d.channel === 'email' ? String(d.recipient).replace(/^(.).*(@.*)$/, '$1***$2') : d.recipient })) });
});

// ----------------------------------------------------------------- audit log
router.get(
  '/audit',
  requirePermission('audit.view'),
  validate({ query: z.object({ q: z.string().trim().max(80).optional(), action: z.string().max(80).optional(), status: z.enum(['success', 'failure', 'denied']).optional(), entityType: z.string().max(40).optional(), entityId: z.string().max(40).optional(), from: v.optionalDate(), to: v.optionalDate(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }) }),
  async (req, res) => {
    const f = req.validQuery;
    const q = db('audit_logs');
    if (f.q) q.where((w) => w.whereILike('username', `%${f.q}%`).orWhereILike('action', `%${f.q}%`));
    if (f.action) q.where('action', 'like', `${f.action}%`);
    if (f.status) q.where('status', f.status);
    if (f.entityType) q.where('entity_type', f.entityType);
    if (f.entityId) q.where('entity_id', f.entityId);
    if (f.from) q.where('created_at', '>=', `${f.from}T00:00:00`);
    if (f.to) q.where('created_at', '<', db.raw("(?::date + interval '1 day')", [f.to]));
    const total = await q.clone().count({ n: '*' }).first();
    const rows = await q.orderBy('id', 'desc').offset((f.page - 1) * f.pageSize).limit(f.pageSize);
    const actions = await db('audit_logs').distinct('action').orderBy('action');
    res.json({ total: Number(total.n), page: f.page, pageSize: f.pageSize, actions: actions.map((a) => a.action), data: rows.map((r) => ({ id: r.id, at: r.created_at, username: r.username, role: r.role_code, action: r.action, entityType: r.entity_type, entityId: r.entity_id, status: r.status, ip: r.ip, details: r.details })) });
  },
);

export default router;
