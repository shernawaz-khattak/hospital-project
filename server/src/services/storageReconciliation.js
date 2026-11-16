import { db } from '../db/knex.js';
import { audit } from './audit.js';
import { logger } from '../lib/logger.js';
import { createStorageForProvider } from './storage/index.js';
import { randomUUID } from 'node:crypto';
import { claimObjectDeletion, completeObjectDeletion, failObjectDeletion, retainObject } from './storageLifecycle.js';

const sanitizedReason = (value) => String(value ?? 'Unknown storage failure').replace(/[\r\n]/g, ' ').slice(0, 500);

export async function recordOrphan(provider, bucket, objectKey, operation, failureReason) {
  const record = {
    provider,
    bucket: bucket || '',
    object_key: objectKey,
    operation,
    failure_reason: sanitizedReason(failureReason),
  };
  try {
    await db('storage_reconciliations').insert(record).onConflict(['provider', 'bucket', 'object_key', 'operation']).merge({
      status: 'pending',
      failure_reason: record.failure_reason,
      resolved_at: null,
      updated_at: db.fn.now(),
    });
    await db('object_storage_lifecycle')
      .insert({ provider, bucket: bucket || '', object_key: objectKey, state: 'active' })
      .onConflict(['provider', 'bucket', 'object_key']).ignore();
    return true;
  } catch (error) {
    logger.error('Could not persist storage reconciliation record', {
      provider, operation, bucketConfigured: Boolean(bucket), objectKey, databaseAvailable: false,
    });
    return false;
  }
}

export async function cleanupOrphan({ provider, bucket, objectKey, operation, failureReason }) {
  try {
    const storage = createStorageForProvider(provider, bucket || '', bucket || undefined);
    await storage.delete(objectKey);
    logger.warn('Unreferenced storage object removed', { provider, operation, objectKey });
    return true;
  } catch (cleanupError) {
    await recordOrphan(provider, bucket, objectKey, operation, `${failureReason}; cleanup failed`);
    logger.error('Unreferenced storage object cleanup failed; reconciliation required', {
      provider, operation, bucketConfigured: Boolean(bucket), objectKey,
    });
    return false;
  }
}

export async function reconcileOrphan(id, ctx = {}) {
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const claim = await db.transaction(async (trx) => {
    const row = await trx('storage_reconciliations').where({ id }).forUpdate().first();
    if (!row) return null;
    const staleRetry = row.status === 'retrying' && row.last_attempt_at &&
      new Date(row.last_attempt_at).getTime() < Date.now() - (10 * 60 * 1000);
    if (!['pending', 'retry_failed'].includes(row.status) && !staleRetry) {
      return { conflict: true, status: row.status };
    }
    await trx('storage_reconciliations').where({ id }).update({
      status: 'retrying', attempt_count: row.attempt_count + 1,
      last_attempt_at: trx.fn.now(), updated_at: trx.fn.now(),
    });
    const deletionClaim = await claimObjectDeletion(trx, {
      provider: row.provider, bucket: row.bucket, objectKey: row.object_key,
      leaseToken, leaseExpiresAt,
    });
    if (deletionClaim?.alreadyDeleted) return { conflict: true, status: 'resolved' };
    if (deletionClaim && !deletionClaim.claimed) return { conflict: true, status: 'retrying' };
    return row;
  });
  if (!claim) return null;
  if (claim.conflict) return claim;
  const row = claim;

  const labReference = await db('lab_reports').where({
    storage_provider: row.provider, storage_key: row.object_key, storage_bucket: row.bucket,
  }).first('id');
  const backupReference = await db('backups').where({
    storage_provider: row.provider, storage_key: row.object_key, storage_bucket: row.bucket,
  }).whereNotIn('retention_state', ['deleted']).first('id');
  if (labReference || backupReference) {
    await db.transaction(async (trx) => {
      await retainObject(trx, { provider: row.provider, bucket: row.bucket, objectKey: row.object_key });
      await trx('storage_reconciliations').where({ id }).update({ status: 'safely_retained', failure_reason: 'Object is still referenced by a valid database record', updated_at: trx.fn.now() });
    });
    await audit(ctx, { action: 'storage.reconcile', entityType: 'storage_reconciliation', entityId: id, status: 'failure', details: { operation: row.operation, retained: true } });
    return { id, status: 'safely_retained' };
  }

  try {
    const storage = createStorageForProvider(row.provider, row.bucket, row.bucket);
    await storage.delete(row.object_key);
    await db.transaction(async (trx) => {
      await completeObjectDeletion(trx, { provider: row.provider, bucket: row.bucket, objectKey: row.object_key });
      await trx('storage_reconciliations').where({ id, status: 'retrying' }).update({ status: 'resolved', resolved_at: trx.fn.now(), updated_at: trx.fn.now() });
    });
    await audit(ctx, { action: 'storage.reconcile', entityType: 'storage_reconciliation', entityId: id, details: { operation: row.operation } });
    return { id, status: 'resolved' };
  } catch (error) {
    await db.transaction(async (trx) => {
      await failObjectDeletion(trx, { provider: row.provider, bucket: row.bucket, objectKey: row.object_key });
      await trx('storage_reconciliations').where({ id }).update({ status: 'retry_failed', failure_reason: sanitizedReason(error.message), updated_at: trx.fn.now() });
    });
    await audit(ctx, { action: 'storage.reconcile', entityType: 'storage_reconciliation', entityId: id, status: 'failure', details: { operation: row.operation } });
    throw error;
  }
}
