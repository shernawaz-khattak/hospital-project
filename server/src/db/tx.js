import { db } from './knex.js';
import { logger } from '../lib/logger.js';

/**
 * Runs `fn` inside a database transaction. `trx.afterCommit(cb)` queues side effects
 * (real-time pushes, email dispatch) that must only happen once the data is committed.
 */
export async function transaction(fn) {
  const callbacks = [];
  const result = await db.transaction(async (trx) => {
    trx.afterCommit = (cb) => callbacks.push(cb);
    return fn(trx);
  });
  for (const cb of callbacks) {
    try {
      await cb();
    } catch (err) {
      logger.error('afterCommit callback failed', err);
    }
  }
  return result;
}

/** Queue a callback after commit when inside a transaction, or run it now otherwise. */
export function afterCommit(trxOrDb, cb) {
  if (typeof trxOrDb?.afterCommit === 'function') trxOrDb.afterCommit(cb);
  else Promise.resolve().then(cb).catch((err) => logger.error('deferred callback failed', err));
}
