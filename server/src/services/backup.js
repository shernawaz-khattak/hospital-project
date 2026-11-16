// Database backups (SRS FR-31, NFR-08, UC-45). Uses pg_dump in PostgreSQL's compressed
// custom format (restorable with pg_restore). Automatic run: daily at midnight (scheduler).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { db } from '../db/knex.js';
import config from '../../knexfile.js';
import { env } from '../config/env.js';
import { audit, systemCtx } from './audit.js';
import { notify } from './notifications.js';
import { logger } from '../lib/logger.js';
import { backupStorage, createStorageForProvider } from './storage/index.js';
import { backupObjectKey } from './storage/objectKey.js';
import { cleanupOrphan, recordOrphan } from './storageReconciliation.js';
import { claimObjectDeletion, completeObjectDeletion, failObjectDeletion, registerObjectReference, retainObject } from './storageLifecycle.js';
import { randomUUID } from 'node:crypto';
import { deleteVerifiedBackupWithRetention } from './storageRetention.js';

const backupDir = () => path.resolve(env.BACKUP_DIR);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

function runPgDump(file) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.connection);
    const args = ['--format=custom', '--compress=6', '--no-owner', `--file=${file}`, `--host=${url.hostname}`, `--port=${url.port || 5432}`, `--username=${decodeURIComponent(url.username)}`, url.pathname.slice(1)];
    // Password passed via environment, never on the command line.
    const child = spawn(env.PG_DUMP_PATH, args, { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new Error(`pg_dump could not be started: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim().split('\n').slice(-2).join(' ') || `pg_dump exited with code ${code}`))));
  });
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function sha256Stream(stream) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

let running = false;
export async function runBackup(type, ctx = systemCtx) {
  if (running) throw Object.assign(new Error('A backup is already running.'), { status: 409 });
  running = true;
  const [row] = await db('backups').insert({ backup_type: type, status: 'running', triggered_by: ctx.user?.id ?? null }).returning('*');
  const fileName = `hms-${stamp()}-${type}.dump`;
  const tempDir = path.join(os.tmpdir(), `hms-backups-${process.pid}`);
  const full = path.join(tempDir, fileName);
  let uploadedKey;
  let storageForRollback;
  let metadataPersisted = false;
  let temporaryFileSafelyHandled = false;
  try {
    await fsp.mkdir(tempDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(tempDir, 0o700);
    await runPgDump(full);
    await fsp.chmod(full, 0o600);
    const { size } = await fsp.stat(full);
    if (size === 0) throw new Error('Backup file is empty.');
    const sha = await sha256File(full);
    const storageKey = env.STORAGE_PROVIDER === 'r2' ? backupObjectKey(fileName, type) : fileName;
    storageForRollback = backupStorage();
    await storageForRollback.put(storageKey, fs.createReadStream(full), { contentType: 'application/octet-stream', sha256: sha });
    uploadedKey = storageKey;
    const head = await storageForRollback.head(storageKey);
    if (!head.exists || head.size !== size) throw new Error('Remote backup size verification failed.');
    const remote = await storageForRollback.getStream(storageKey);
    const remoteSha = await sha256Stream(remote);
    if (remoteSha !== sha) throw new Error('Remote backup checksum verification failed.');
    await db.transaction(async (trx) => {
      await registerObjectReference(trx, {
        provider: env.STORAGE_PROVIDER,
        bucket: env.STORAGE_PROVIDER === 'r2' ? env.R2_BUCKET_BACKUPS : env.BACKUP_DIR,
        objectKey: storageKey,
      });
      await trx('backups').where({ id: row.id }).update({
        status: 'success', file_name: fileName, size_bytes: size, sha256: sha, completed_at: new Date(),
        storage_provider: env.STORAGE_PROVIDER,
        storage_key: storageKey,
        storage_bucket: env.STORAGE_PROVIDER === 'r2' ? env.R2_BUCKET_BACKUPS : null,
        storage_status: 'ready', storage_verified_at: new Date(),
      });
    });
    metadataPersisted = true;
    await audit(ctx, { action: 'system.backup', entityType: 'backup', entityId: row.id, details: { type, fileName, size } });
    await pruneOldBackups();
    return db('backups').where({ id: row.id }).first();
  } catch (err) {
    if (uploadedKey && storageForRollback && !metadataPersisted) {
      if (env.STORAGE_PROVIDER === 'r2') {
        temporaryFileSafelyHandled = await cleanupOrphan({
          provider: 'r2',
          bucket: env.R2_BUCKET_BACKUPS,
          objectKey: uploadedKey,
          operation: 'backup_upload',
          failureReason: err.message,
        });
      } else {
        try { await storageForRollback.delete(uploadedKey); temporaryFileSafelyHandled = true; } catch {}
      }
    }
    if (!metadataPersisted) {
      await db('backups').where({ id: row.id }).update({ status: 'failed', error: String(err.message).slice(0, 500), completed_at: new Date() });
      await audit(ctx, { action: 'system.backup', entityType: 'backup', entityId: row.id, status: 'failure', details: { type, error: String(err.message).slice(0, 200) } });
      // UC-45 2-A: alert the administrator and log the failure.
      await notify(db, { permission: 'system.backup', priority: 'high', email: true, eventType: 'system.backup_failed', title: 'Database backup failed', message: `The ${type} backup failed: ${String(err.message).slice(0, 200)}`, link: '/system/backups' });
      logger.error('Backup failed', err);
      throw Object.assign(new Error(`Backup failed: ${err.message}`), { status: 500, safe: true });
    }
    logger.error('Backup verification succeeded but a post-success operation failed', err);
    return db('backups').where({ id: row.id }).first();
  } finally {
    if (!uploadedKey || metadataPersisted || temporaryFileSafelyHandled) await fsp.rm(full, { force: true });
    running = false;
  }
}

/** Removes backup files older than the retention period (records are kept for history). */
export async function pruneOldBackups() {
  const cutoff = new Date(Date.now() - env.BACKUP_RETENTION_DAYS * 86400000);
  const old = await db('backups').where('status', 'success').where('started_at', '<', cutoff).whereNotNull('storage_key')
    .whereNotNull('storage_verified_at').where('storage_status', 'ready');
  const valid = await db('backups').where({ status: 'success' }).whereNotNull('storage_key').where((q) => q.where({ storage_status: 'ready' }).orWhereNull('storage_status')).orderBy('started_at', 'desc');
  for (const b of old) {
    if (!valid.some((candidate) => candidate.id === b.id)) continue;
    const remainingValidCount = valid.filter((candidate) => candidate.id !== b.id).length;
    if (remainingValidCount < 1) continue;
    const claimed = await db('backups').where({ id: b.id })
      .where((q) => q.where({ retention_state: 'ready' }).orWhereNull('retention_state'))
      .update({ retention_state: 'pending_deletion', retention_state_at: new Date() });
    if (claimed !== 1) continue;
    const provider = b.storage_provider || 'local';
    const storage = provider === env.STORAGE_PROVIDER && env.STORAGE_PROVIDER === 'r2'
      ? backupStorage()
      : provider === 'r2' ? createStorageForProvider('r2', b.storage_bucket, b.storage_bucket) : createStorageForProvider('local', env.BACKUP_DIR);
    try {
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await deleteVerifiedBackupWithRetention({
        storage,
        key: b.storage_key,
        persistPending: () => db.transaction(async (trx) => {
          const claim = await claimObjectDeletion(trx, {
            provider, bucket: b.storage_bucket, objectKey: b.storage_key, leaseToken, leaseExpiresAt,
          });
          if (!claim?.claimed && !claim?.alreadyDeleted) throw new Error('Object lifecycle deletion claim could not be acquired');
          await trx('backups').where({ id: b.id }).update({ retention_state: 'pending_deletion', retention_state_at: new Date(), storage_status: 'ready' });
        }),
        persistDeleted: () => db.transaction(async (trx) => {
          await completeObjectDeletion(trx, { provider, bucket: b.storage_bucket, objectKey: b.storage_key });
          await trx('backups').where({ id: b.id }).update({
            file_name: null, storage_status: 'deleted', retention_state: 'deleted', retention_state_at: new Date(),
            error: 'File removed by retention policy',
          });
        }),
        persistDeleteFailure: async (err) => {
          await db.transaction(async (trx) => {
            await failObjectDeletion(trx, { provider, bucket: b.storage_bucket, objectKey: b.storage_key });
            await trx('backups').where({ id: b.id }).update({ retention_state: 'deletion_failed', retention_state_at: new Date() });
          });
          await recordOrphan(b.storage_provider || 'r2', b.storage_bucket, b.storage_key, 'backup_retention_delete', err.message);
          logger.error('Backup retention object deletion failed; retry state preserved', err);
        },
        persistMetadataFailure: async (err) => {
          await db.transaction(async (trx) => {
            await trx('backups').where({ id: b.id }).update({ retention_state: 'pending_metadata_reconciliation', retention_state_at: new Date() }).catch(() => {});
          });
          await recordOrphan(b.storage_provider || 'r2', b.storage_bucket, b.storage_key, 'backup_retention_delete_verify', err.message);
          logger.error('Backup deleted but final retention metadata update failed', err);
        },
      });
    } catch (err) {
      logger.error('Backup retention transition failed safely', err);
    }
  }
}

export async function legacyBackupInventory() {
  return db('backups')
    .where({ status: 'success' })
    .whereNull('storage_key')
    .whereNotNull('file_name')
    .orderBy('started_at', 'desc');
}

export async function retryBackupRetention(id, ctx) {
  const b = await db('backups').where({ id, status: 'success' }).whereNotNull('storage_key')
    .whereNotNull('storage_verified_at').whereIn('retention_state', ['pending_deletion', 'deletion_failed', 'pending_metadata_reconciliation']).first();
  if (!b) return null;
  const usableCount = await db('backups').where({ status: 'success', storage_status: 'ready' })
    .whereNotNull('storage_verified_at').whereNotNull('storage_key')
    .where((q) => q.whereNull('retention_state').orWhereIn('retention_state', ['ready', 'pending_metadata_reconciliation', 'deletion_failed']))
    .count({ n: '*' }).first();
  if (Number(usableCount?.n ?? 0) <= 1) return { id, status: 'retained', reason: 'Last verified usable backup' };

  const claimed = await db('backups').where({ id }).whereIn('retention_state', ['pending_deletion', 'deletion_failed', 'pending_metadata_reconciliation'])
    .update({ retention_state: 'pending_deletion', retention_state_at: new Date() });
  if (claimed !== 1) return { id, status: 'claimed' };

  const provider = b.storage_provider || 'r2';
  const storage = provider === 'r2'
    ? createStorageForProvider('r2', b.storage_bucket, b.storage_bucket)
    : createStorageForProvider('local', env.BACKUP_DIR);
  try {
    await deleteVerifiedBackupWithRetention({
      storage,
      key: b.storage_key,
      persistPending: () => db.transaction(async (trx) => {
        const claim = await claimObjectDeletion(trx, {
          provider, bucket: b.storage_bucket, objectKey: b.storage_key,
          leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        });
        if (!claim?.claimed && !claim?.alreadyDeleted) throw new Error('Object lifecycle deletion claim could not be acquired');
        await trx('backups').where({ id }).where({ retention_state: 'pending_deletion' }).update({ retention_state_at: new Date() });
      }),
      persistDeleted: () => db.transaction(async (trx) => {
        await completeObjectDeletion(trx, { provider, bucket: b.storage_bucket, objectKey: b.storage_key });
        await trx('backups').where({ id }).update({
          storage_status: 'deleted', retention_state: 'deleted', retention_state_at: new Date(),
          error: 'File removed by retention policy',
        });
      }),
      persistDeleteFailure: async (err) => {
        await db.transaction(async (trx) => {
          await failObjectDeletion(trx, { provider, bucket: b.storage_bucket, objectKey: b.storage_key });
          await trx('backups').where({ id }).update({ retention_state: 'deletion_failed', retention_state_at: new Date() });
        });
        await recordOrphan(provider, b.storage_bucket, b.storage_key, 'backup_retention_retry', err.message);
      },
      persistMetadataFailure: async (err) => {
        await db('backups').where({ id }).update({ retention_state: 'pending_metadata_reconciliation', retention_state_at: new Date() }).catch(() => {});
        await recordOrphan(provider, b.storage_bucket, b.storage_key, 'backup_retention_retry_verify', err.message);
      },
    });
  } catch (error) {
    await audit(ctx, { action: 'backup.retention_retry', entityType: 'backup', entityId: id, status: 'failure', details: { error: String(error.message ?? error).slice(0, 200) } });
    throw error;
  }
  await audit(ctx, { action: 'backup.retention_retry', entityType: 'backup', entityId: id, details: { status: 'success' } });
  return { id, status: 'deleted' };
}

export async function backupFile(id) {
  const b = await db('backups').where({ id, status: 'success' }).first();
  if (b && (b.storage_status === 'deleted' || ['pending_deletion', 'deletion_failed', 'pending_metadata_reconciliation'].includes(b.retention_state))) return null;
  if (!b?.file_name) return null;
  if (b.storage_key && !b.storage_provider) return null;
  try {
    const provider = b.storage_provider || 'local';
    const storage = provider === env.STORAGE_PROVIDER && env.STORAGE_PROVIDER === 'r2'
      ? backupStorage()
      : provider === 'r2' ? createStorageForProvider('r2', b.storage_bucket, b.storage_bucket) : createStorageForProvider('local', env.BACKUP_DIR);
    const key = b.storage_key || b.file_name;
    const object = await storage.get(key);
    return { stream: object.stream, metadata: object.metadata, backup: b };
  } catch {
    return null;
  }
}

export const backupRunning = () => running;
