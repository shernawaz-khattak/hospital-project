const OBJECT_STATES = new Set(['active', 'pending_deletion', 'deleted', 'deletion_failed']);

export class ObjectLifecycleConflict extends Error {
  constructor(message = 'Object is pending deletion or unavailable') {
    super(message);
    this.code = 'OBJECT_LIFECYCLE_CONFLICT';
  }
}

export function validateReferenceState(state) {
  if (!state || state === 'active') return true;
  if (['pending_deletion', 'deleted', 'deletion_failed'].includes(state)) return false;
  throw new ObjectLifecycleConflict('Unknown object lifecycle state');
}

export function leaseExpired(leaseExpiresAt, now = Date.now()) {
  return !leaseExpiresAt || new Date(leaseExpiresAt).getTime() <= now;
}

export async function registerObjectReference(trx, { provider, bucket, objectKey }) {
  if (!provider || !objectKey) throw new ObjectLifecycleConflict('Invalid object identity');
  await trx('object_storage_lifecycle')
    .insert({ provider, bucket: bucket || '', object_key: objectKey, state: 'active' })
    .onConflict(['provider', 'bucket', 'object_key'])
    .merge({ updated_at: trx.fn.now() });
  const lifecycle = await trx('object_storage_lifecycle')
    .where({ provider, bucket: bucket || '', object_key: objectKey }).forUpdate().first();
  if (!lifecycle || lifecycle.state === 'pending_deletion' || lifecycle.state === 'deleted') {
    throw new ObjectLifecycleConflict();
  }
  return lifecycle;
}

export async function claimObjectDeletion(trx, { provider, bucket, objectKey, leaseToken, leaseExpiresAt }) {
  const lifecycle = await trx('object_storage_lifecycle')
    .where({ provider, bucket: bucket || '', object_key: objectKey }).forUpdate().first();
  if (!lifecycle) return null;
  if (lifecycle.state === 'deleted') return { lifecycle, alreadyDeleted: true };
  const leaseExpired = lifecycle.state === 'pending_deletion' &&
    (!lifecycle.lease_expires_at || new Date(lifecycle.lease_expires_at).getTime() <= Date.now());
  if (lifecycle.state === 'pending_deletion' && !leaseExpired) return { lifecycle, claimed: false };
  await trx('object_storage_lifecycle').where({ id: lifecycle.id }).update({
    state: 'pending_deletion', lease_token: leaseToken, lease_expires_at: leaseExpiresAt, updated_at: trx.fn.now(),
  });
  return { lifecycle: { ...lifecycle, state: 'pending_deletion' }, claimed: true };
}

export async function completeObjectDeletion(trx, { provider, bucket, objectKey }) {
  await trx('object_storage_lifecycle').where({
    provider, bucket: bucket || '', object_key: objectKey, state: 'pending_deletion',
  }).update({ state: 'deleted', lease_token: null, lease_expires_at: null, updated_at: trx.fn.now() });
}

export async function failObjectDeletion(trx, { provider, bucket, objectKey }) {
  await trx('object_storage_lifecycle').where({
    provider, bucket: bucket || '', object_key: objectKey, state: 'pending_deletion',
  }).update({ state: 'deletion_failed', lease_token: null, lease_expires_at: null, updated_at: trx.fn.now() });
}

export async function retainObject(trx, { provider, bucket, objectKey }) {
  await trx('object_storage_lifecycle').where({
    provider, bucket: bucket || '', object_key: objectKey,
  }).whereIn('state', ['pending_deletion', 'deletion_failed']).update({
    state: 'active', lease_token: null, lease_expires_at: null, updated_at: trx.fn.now(),
  });
}
