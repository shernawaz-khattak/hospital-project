// Server-side sessions. The browser holds only an opaque random token in an httpOnly,
// SameSite=Strict cookie; the database stores its SHA-256 hash.
// Inactivity limit: SESSION_IDLE_MINUTES (SRS UC-01 / UC-02: 10 minutes).
import { db } from '../db/knex.js';
import { env, isProd, isTest } from '../config/env.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export const SESSION_COOKIE = 'hms_session';

// Short-lived in-process cache of session rows (2 s) to halve database round trips under load.
// Any revocation in this process clears the entry immediately; the idle timeout is still
// evaluated on every request against the current time.
const CACHE_MS = isTest ? 0 : 2000; // tests edit session rows directly, so they bypass the cache
const cache = new Map(); // token hash -> { row, at }
const cacheGet = (h) => {
  if (!CACHE_MS) return null;
  const e = cache.get(h);
  if (!e || Date.now() - e.at > CACHE_MS) return null;
  return e.row;
};
const cacheSet = (h, row) => {
  if (cache.size > 5000) cache.clear();
  cache.set(h, { row, at: Date.now() });
};
const cacheDropSession = (sessionId) => { for (const [h, e] of cache) if (e.row.session_id === sessionId) cache.delete(h); };
const cacheDropUser = (userId) => { for (const [h, e] of cache) if (e.row.id === userId) cache.delete(h); };
/** Call after changing anything about a user that sessions carry (password flag, status). */
export const invalidateUserSessionCache = (userId) => cacheDropUser(Number(userId));
const IDLE_MS = () => env.SESSION_IDLE_MINUTES * 60_000;

export async function loadPermissionsForRole(roleId, conn = db) {
  const rows = await conn('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').where('rp.role_id', roleId).select('p.code');
  return rows.map((r) => r.code).sort();
}

export async function createSession(user, roleCode, { ip, userAgent }, conn = db) {
  const token = randomToken(32);
  const permissions = await loadPermissionsForRole(user.role_id, conn);
  await conn('sessions').insert({
    token_hash: sha256(token),
    user_id: user.id,
    role_code: roleCode,
    permissions,
    expires_at: new Date(Date.now() + env.SESSION_ABSOLUTE_HOURS * 3600_000),
    ip,
    user_agent: userAgent?.slice(0, 300),
  });
  return token;
}

/**
 * Resolve a session token. Returns { session, user } or { expired: reason } or null.
 * `touch` refreshes the inactivity timer (background polling must not count as activity).
 */
export async function resolveSession(token, { touch = true } = {}) {
  if (!token) return null;
  const hash = sha256(token);
  let row = cacheGet(hash);
  if (!row) row = await db('sessions as s')
    .join('users as u', 'u.id', 's.user_id')
    .leftJoin('staff as st', 'st.user_id', 'u.id')
    .leftJoin('doctors as d', 'd.staff_id', 'st.id')
    .leftJoin('patients as p', 'p.user_id', 'u.id')
    .where('s.token_hash', hash)
    .first(
      's.id as session_id', 's.role_code', 's.permissions', 's.last_activity_at', 's.expires_at', 's.revoked_at',
      'u.id', 'u.username', 'u.full_name', 'u.email', 'u.status', 'u.must_change_password',
      'st.id as staff_id', 'st.department_id', 'd.id as doctor_id', 'p.id as patient_id',
    );
  if (!row || row.revoked_at) return null;
  cacheSet(hash, row);
  const now = Date.now();
  if (row.status !== 'active') {
    await revokeSession(row.session_id, 'account_disabled');
    return { expired: 'ACCOUNT_DISABLED' };
  }
  if (new Date(row.expires_at).getTime() <= now) {
    await revokeSession(row.session_id, 'absolute_timeout');
    return { expired: 'SESSION_EXPIRED' };
  }
  const idleFor = now - new Date(row.last_activity_at).getTime();
  if (idleFor >= IDLE_MS()) {
    await revokeSession(row.session_id, 'idle_timeout');
    return { expired: 'SESSION_EXPIRED', idle: true, userId: row.id, username: row.username, role: row.role_code };
  }
  // Throttle writes: refresh at most every 15 seconds.
  if (touch && idleFor > 15_000) {
    await db('sessions').where({ id: row.session_id }).update({ last_activity_at: new Date() });
    row.last_activity_at = new Date();
    cacheSet(hash, row);
  }
  return {
    session: { id: row.session_id, lastActivityAt: row.last_activity_at, idleTimeoutSeconds: env.SESSION_IDLE_MINUTES * 60 },
    user: {
      id: row.id,
      username: row.username,
      fullName: row.full_name,
      email: row.email,
      role: row.role_code,
      permissions: row.permissions,
      mustChangePassword: row.must_change_password,
      staffId: row.staff_id,
      departmentId: row.department_id,
      doctorId: row.doctor_id,
      patientId: row.patient_id,
    },
  };
}

export async function revokeSession(sessionId, reason) {
  cacheDropSession(sessionId);
  await db('sessions').where({ id: sessionId }).whereNull('revoked_at').update({ revoked_at: new Date(), revoke_reason: reason });
}

export async function revokeUserSessions(userId, reason, conn = db) {
  cacheDropUser(Number(userId));
  await conn('sessions').where({ user_id: userId }).whereNull('revoked_at').update({ revoked_at: new Date(), revoke_reason: reason });
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'strict',
    secure: isProd ? true : env.COOKIE_SECURE,
    path: '/',
    maxAge: env.SESSION_ABSOLUTE_HOURS * 3600_000,
  };
}
