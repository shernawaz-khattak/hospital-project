// Authentication (SRS UC-01 Login, UC-02 Logout, UC-03 Verify Credentials, UC-04 Reset Password).
import bcrypt from 'bcryptjs';
import { db } from '../../db/knex.js';
import { transaction } from '../../db/tx.js';
import { env } from '../../config/env.js';
import { AppError, badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notifications.js';
import { emailMode } from '../../services/email.js';
import { createSession, invalidateUserSessionCache, revokeSession, revokeUserSessions } from '../../auth/sessions.js';
import { closeUserStreams } from '../../services/realtime.js';

export const BCRYPT_ROUNDS = 12;
// Pre-computed hash used to keep response time constant when the username is unknown.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', BCRYPT_ROUNDS);

export const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);

const normalizeUsername = (value = '') => String(value ?? '').trim();
const normalizeEmail = (value = '') => String(value ?? '').trim().toLowerCase();

const GENERIC_FAIL = `Invalid username or password. After ${env.LOGIN_MAX_ATTEMPTS} failed attempts the account is temporarily locked.`;

// UC-03 Verify Credentials: performed inside login() against the stored bcrypt hash,
// under a per-account row lock.
export async function login(req, { username, password }) {
  const normalizedUsername = normalizeUsername(username);
  const ctx = { ip: req.ip, get: req.get.bind(req), username: normalizedUsername };
  const row = await db('users').whereRaw('LOWER(username) = LOWER(?)', [normalizedUsername]).whereNull('deleted_at').first('id');
  if (!row) {
    await bcrypt.compare(password, DUMMY_HASH); // constant-time-ish response for unknown usernames
    await audit(ctx, { action: 'auth.login_failed', status: 'failure', details: { reason: 'unknown_username' } });
    throw unauthorized(GENERIC_FAIL, { code: 'INVALID_CREDENTIALS' });
  }

  // Attempts on one account are serialised with a row lock, so parallel guesses cannot get
  // past the 3-attempt limit (each attempt sees the counter left by the previous one).
  const outcome = await transaction(async (trx) => {
    const user = await trx('users as u').join('roles as r', 'r.id', 'u.role_id').where('u.id', row.id).forUpdate('u').first('u.*', 'r.code as role_code');
    const userCtx = { ...ctx, user: { id: user.id, username: user.username, role: user.role_code } };
    if (user.status !== 'active') {
      await audit(userCtx, { action: 'auth.login_failed', entityType: 'user', entityId: user.id, status: 'failure', details: { reason: 'inactive' } }, trx);
      return { error: new AppError(403, 'This account is disabled. Please contact the administrator.', { code: 'ACCOUNT_DISABLED' }) };
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      await audit(userCtx, { action: 'auth.login_blocked', entityType: 'user', entityId: user.id, status: 'failure', details: { reason: 'locked' } }, trx);
      return { error: new AppError(423, `This account is temporarily locked after repeated failed attempts. Try again in ${mins} minute(s) or contact the administrator.`, { code: 'ACCOUNT_LOCKED' }) };
    }
    const ok = Boolean(user.password_hash) && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      const attempts = user.failed_login_count + 1;
      const lock = attempts >= env.LOGIN_MAX_ATTEMPTS;
      await trx('users').where({ id: user.id }).update({
        failed_login_count: lock ? 0 : attempts,
        locked_until: lock ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000) : user.locked_until,
      });
      await audit(userCtx, { action: lock ? 'auth.account_locked' : 'auth.login_failed', entityType: 'user', entityId: user.id, status: 'failure', details: { attempts } }, trx);
      return {
        error: lock
          ? new AppError(423, `Too many failed attempts. This account is locked for ${env.LOGIN_LOCK_MINUTES} minutes.`, { code: 'ACCOUNT_LOCKED' })
          : unauthorized(GENERIC_FAIL, { code: 'INVALID_CREDENTIALS' }),
      };
    }
    await trx('users').where({ id: user.id }).update({ failed_login_count: 0, locked_until: null, last_login_at: new Date() });
    const token = await createSession(user, user.role_code, { ip: req.ip, userAgent: req.get('user-agent') }, trx);
    await audit(userCtx, { action: 'auth.login', entityType: 'user', entityId: user.id }, trx);
    return { token };
  });
  if (outcome.error) throw outcome.error;
  return outcome.token;
}

export async function logout(req) {
  await revokeSession(req.session.id, 'logout');
  closeUserStreams(req.user.id);
  await audit(req, { action: 'auth.logout', entityType: 'user', entityId: req.user.id });
}

/** UC-04 steps 3-4: email a reset link that expires within 24 hours. */
export async function requestPasswordReset(req, email) {
  const normalizedEmail = normalizeEmail(email);
  const user = await db('users').whereRaw('LOWER(email) = LOWER(?)', [normalizedEmail]).whereNull('deleted_at').where('status', 'active').first();
  if (!user) {
    await audit({ ip: req.ip, get: req.get.bind(req) }, { action: 'auth.password_reset_requested', status: 'failure', details: { reason: 'email_not_found' } });
    // SRS UC-04 alternative flow 2-A requires telling the user the email was not found.
    throw notFound('No account is registered with this email address.', { code: 'EMAIL_NOT_FOUND', fields: { email: 'No account is registered with this email address.' } });
  }
  const token = randomToken(32);
  await transaction(async (trx) => {
    await trx('password_reset_tokens').where({ user_id: user.id }).whereNull('used_at').update({ used_at: new Date() });
    await trx('password_reset_tokens').insert({
      user_id: user.id,
      token_hash: sha256(token),
      expires_at: new Date(Date.now() + env.RESET_TOKEN_HOURS * 3600_000),
    });
    await notify(trx, {
      userIds: [user.id],
      inApp: false,
      email: true,
      secretLink: true,
      eventType: 'auth.password_reset',
      title: 'Password reset request',
      message: `A password reset was requested for your account (${user.username}). The link below expires in ${env.RESET_TOKEN_HOURS} hours. If you did not request this, ignore this message.`,
      link: `/reset-password/${token}`,
      priority: 'high',
    });
    await audit({ ip: req.ip, get: req.get.bind(req), user: { id: user.id, username: user.username } }, { action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id }, trx);
  });
  return { emailMode: emailMode() };
}

async function findValidResetToken(token) {
  const row = await db('password_reset_tokens').where({ token_hash: sha256(token) }).first();
  if (!row || row.used_at) throw badRequest('This reset link is invalid or has already been used.', { code: 'RESET_INVALID' });
  if (new Date(row.expires_at) <= new Date()) throw badRequest('This reset link has expired. Please request a new one.', { code: 'RESET_EXPIRED' });
  return row;
}

export const validateResetToken = (token) => findValidResetToken(token).then(() => true);

export async function resetPassword(req, { token, password }) {
  const row = await findValidResetToken(token);
  const hash = await hashPassword(password);
  await transaction(async (trx) => {
    await trx('users').where({ id: row.user_id }).update({
      password_hash: hash, must_change_password: false, failed_login_count: 0, locked_until: null, password_changed_at: new Date(), updated_at: new Date(),
    });
    await trx('password_reset_tokens').where({ id: row.id }).update({ used_at: new Date() });
    await revokeUserSessions(row.user_id, 'password_reset', trx);
    await audit({ ip: req.ip, get: req.get.bind(req), user: { id: row.user_id } }, { action: 'auth.password_reset', entityType: 'user', entityId: row.user_id }, trx);
  });
}

export async function changePassword(req, { currentPassword, newPassword }) {
  const user = await db('users').where({ id: req.user.id }).first();
  if (!(await bcrypt.compare(currentPassword, user.password_hash || DUMMY_HASH))) {
    await audit(req, { action: 'auth.password_change', entityType: 'user', entityId: user.id, status: 'failure' });
    throw new AppError(422, 'Current password is incorrect.', { fields: { currentPassword: 'Current password is incorrect.' } });
  }
  if (await bcrypt.compare(newPassword, user.password_hash)) {
    throw new AppError(422, 'The new password must be different from the current one.', { fields: { newPassword: 'Choose a password you have not used just now.' } });
  }
  const hash = await hashPassword(newPassword);
  await transaction(async (trx) => {
    await trx('users').where({ id: user.id }).update({ password_hash: hash, must_change_password: false, password_changed_at: new Date(), updated_at: new Date() });
    await trx('sessions').where({ user_id: user.id }).whereNot({ id: req.session.id }).whereNull('revoked_at').update({ revoked_at: new Date(), revoke_reason: 'password_changed' });
    await audit(req, { action: 'auth.password_change', entityType: 'user', entityId: user.id }, trx);
  });
  invalidateUserSessionCache(user.id);
}
