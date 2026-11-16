// Notification service (SRS FR-22, FR-33, UC-33, UC-47).
//
// Every notification is persisted (logged with timestamp). Channels:
//   in_app — stored per user and pushed live over SSE; delivered on commit.
//   email  — sent through the email transport; failures are retried up to 3 attempts
//            15 s apart (all attempts complete well within the 1-minute target), and a
//            final failure is written to the audit log.
import { db } from '../db/knex.js';
import { afterCommit } from '../db/tx.js';
import { sendEmail } from './email.js';
import { publishToUser } from './realtime.js';
import { audit, systemCtx } from './audit.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { decrypt, encrypt } from '../lib/crypto.js';

// Links that carry a secret (password-reset / set-password tokens) are stored encrypted so the
// token is not readable from the database or backups; only the email transport decrypts it.
const storeLink = (link, secret) => (link && secret ? `enc:${encrypt(link)}` : link ?? null);
const readLink = (link) => (link?.startsWith('enc:') ? decrypt(link.slice(4)) : link);

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 15_000;

/** Active users holding any of the given permissions (via their role). */
export async function usersWithPermission(perms, conn = db) {
  const list = Array.isArray(perms) ? perms : [perms];
  return conn('users as u')
    .join('role_permissions as rp', 'rp.role_id', 'u.role_id')
    .join('permissions as p', 'p.id', 'rp.permission_id')
    .whereIn('p.code', list)
    .where('u.status', 'active')
    .distinct('u.id', 'u.email', 'u.full_name');
}

/**
 * Create notifications.
 * @param conn knex or transaction
 * @param {object} n
 *   userIds?: number[]       explicit staff/patient-user recipients
 *   permission?: string|[]   all active users with this permission
 *   patientId?: number       the patient concerned (reaches their portal account and/or email)
 *   eventType, title, message, link?, priority?, entityType?, entityId?
 *   email?: boolean          also send by email when an address exists
 *   secretLink?: boolean     link contains a secret token: stored encrypted, email only
 *   inApp?: boolean          default true
 */
export async function notify(conn, n) {
  const recipients = new Map(); // key -> { userId, patientId, email }
  for (const id of n.userIds ?? []) {
    const u = await conn('users').where({ id }).whereNot('status', 'deleted').first('id', 'email');
    if (u) recipients.set(`u${u.id}`, { userId: u.id, patientId: null, email: u.email });
  }
  if (n.permission) {
    for (const u of await usersWithPermission(n.permission, conn)) {
      recipients.set(`u${u.id}`, { userId: u.id, patientId: null, email: u.email });
    }
  }
  if (n.patientId) {
    const p = await conn('patients as p')
      .leftJoin('users as u', function joinUser() {
        this.on('u.id', 'p.user_id').andOnVal('u.status', '=', 'active');
      })
      .where('p.id', n.patientId)
      .first('p.id', 'p.email', 'u.id as user_id', 'u.email as user_email');
    if (p) {
      const key = p.user_id ? `u${p.user_id}` : `p${p.id}`;
      recipients.set(key, { userId: p.user_id ?? null, patientId: p.id, email: p.user_email || p.email });
    }
  }

  const inApp = n.inApp !== false;
  const created = [];
  for (const r of recipients.values()) {
    if (!r.userId && !(n.email && r.email)) continue; // nothing can reach this recipient
    if (n.entityType && n.entityId != null) {
      let duplicateQuery = conn('notifications')
        .where({ event_type: n.eventType, entity_type: n.entityType, entity_id: n.entityId });
      duplicateQuery = r.userId ? duplicateQuery.where({ user_id: r.userId }) : duplicateQuery.where({ patient_id: r.patientId });
      if (await duplicateQuery.first('id')) continue;
    }
    const [row] = await conn('notifications').insert({
        user_id: r.userId,
        patient_id: r.patientId,
        event_type: n.eventType,
        title: n.title,
        message: n.message,
        link: storeLink(n.link, n.secretLink),
        priority: n.priority ?? 'normal',
        entity_type: n.entityType ?? null,
        entity_id: n.entityId ?? null,
        // email-only messages are not shown in any in-app inbox
        is_read: !(inApp && r.userId),
      })
        .returning('*');
    if (inApp && r.userId) {
      await conn('notification_deliveries').insert({
        notification_id: row.id, channel: 'in_app', recipient: `user:${r.userId}`, status: 'delivered', attempts: 1, delivered_at: conn.fn.now(),
      });
    }
    if (n.email && r.email) {
      await conn('notification_deliveries').insert({
        notification_id: row.id, channel: 'email', recipient: r.email, status: 'pending', attempts: 0, next_attempt_at: conn.fn.now(),
      });
    }
    created.push(row);
  }

  afterCommit(conn, async () => {
    for (const row of created) {
      if (row.user_id && inApp) publishToUser(row.user_id, 'notification', { id: row.id, title: row.title, message: row.message, link: row.link, priority: row.priority, eventType: row.event_type });
    }
    if (n.email) await processPendingDeliveries();
  });
  return created;
}

let processing = false;
/** Attempts every due email delivery. Called after commit and by the retry worker. */
export async function processPendingDeliveries() {
  if (processing) return;
  processing = true;
  try {
    const due = await db('notification_deliveries as d')
      .join('notifications as n', 'n.id', 'd.notification_id')
      .where('d.status', 'pending')
      .where('d.next_attempt_at', '<=', db.fn.now())
      .orderBy('d.id')
      .limit(50)
      .select('d.*', 'n.title', 'n.message', 'n.link', 'n.event_type');
    for (const d of due) await attemptDelivery(d);
  } finally {
    processing = false;
  }
}

async function attemptDelivery(d) {
  const attempts = d.attempts + 1;
  try {
    const plainLink = readLink(d.link);
    const link = plainLink ? `\n\nOpen: ${env.APP_BASE_URL}${plainLink}` : '';
    const result = await sendEmail({
      to: d.recipient,
      subject: `[${env.HOSPITAL_NAME}] ${d.title}`,
      text: `${d.message}${link}\n\n— ${env.HOSPITAL_NAME}`,
    });
    await db('notification_deliveries').where({ id: d.id }).update({
      status: result, attempts, delivered_at: result === 'delivered' || result === 'captured' ? db.fn.now() : null,
      last_error: result === 'skipped' ? 'Email transport is not configured' : null, next_attempt_at: null,
    });
  } catch (err) {
    const final = attempts >= MAX_ATTEMPTS;
    await db('notification_deliveries').where({ id: d.id }).update({
      attempts,
      status: final ? 'failed' : 'pending',
      last_error: String(err.message).slice(0, 500),
      next_attempt_at: final ? null : new Date(Date.now() + RETRY_DELAY_MS),
    });
    logger.warn(`Email delivery attempt ${attempts} failed for delivery ${d.id}`, err.message);
    if (final) {
      await audit(systemCtx, {
        action: 'notification.delivery_failed', entityType: 'notification', entityId: d.notification_id, status: 'failure',
        details: { channel: 'email', attempts, error: String(err.message).slice(0, 200) },
      });
    }
  }
}
