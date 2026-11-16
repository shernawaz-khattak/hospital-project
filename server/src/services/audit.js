// Audit logging (SRS UC-01 step 6, UC-13, UC-20, UC-38, UC-45, UC-46 ...).
// audit_logs is append-only at database level (trigger), so entries cannot be altered.
import { db } from '../db/knex.js';
import { logger } from '../lib/logger.js';
import { sanitizeAuditDetails } from './auditSanitize.js';

/**
 * @param {object} ctx  request (req) or { user, ip, userAgent }
 * @param {object} entry { action, entityType, entityId, status='success', details }
 * @param {object} [conn] knex transaction to write within (so the entry commits with the change)
 */
export async function audit(ctx, { action, entityType = null, entityId = null, status = 'success', details = null }, conn = db) {
  const user = ctx?.user ?? null;
  try {
    await conn('audit_logs').insert({
      user_id: user?.id ?? null,
      username: user?.username ?? ctx?.username ?? null,
      role_code: user?.role ?? null,
      action,
      entity_type: entityType,
      entity_id: entityId === null || entityId === undefined ? null : String(entityId),
      status,
      ip: ctx?.ip ?? null,
      user_agent: (ctx?.get?.('user-agent') ?? ctx?.userAgent ?? null)?.slice(0, 300) ?? null,
      details: details ? JSON.stringify(sanitizeAuditDetails(details)) : null,
    });
  } catch (err) {
    // Auditing must never break the user's action, but a failure here is serious.
    logger.error('Failed to write audit log', err);
    if (conn !== db) throw err;
  }
}

/** System-initiated events (scheduler, background jobs). */
export const systemCtx = { user: null, username: 'system', ip: null, userAgent: 'hms-scheduler' };
