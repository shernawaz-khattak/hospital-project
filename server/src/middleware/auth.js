import { SESSION_COOKIE, resolveSession, sessionCookieOptions } from '../auth/sessions.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { audit } from '../services/audit.js';

const BACKGROUND_HEADER = 'x-hms-background';

/** Requires a valid session; populates req.user and req.session. */
export async function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const touch = req.get(BACKGROUND_HEADER) !== '1';
  const result = await resolveSession(token, { touch });
  if (!result) {
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
    throw unauthorized('Please sign in to continue.', { code: 'NOT_AUTHENTICATED' });
  }
  if (result.expired) {
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
    if (result.idle) {
      await audit({ user: { id: result.userId, username: result.username, role: result.role }, ip: req.ip, get: req.get.bind(req) }, { action: 'auth.session_timeout', entityType: 'user', entityId: result.userId });
    }
    throw unauthorized('Your session has expired. Please sign in again.', { code: result.expired });
  }
  req.user = result.user;
  req.session = result.session;

  // A temporary password must be changed before anything else (first portal login, admin reset).
  if (req.user.mustChangePassword && !req.originalUrl.startsWith('/api/auth/')) {
    throw forbidden('You must change your temporary password before continuing.', { code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  next();
}

/** Allows the request when the user holds ANY of the listed permissions. */
export const requirePermission = (...perms) => async (req, _res, next) => {
  const has = perms.some((p) => req.user?.permissions?.includes(p));
  if (!has) {
    await audit(req, { action: 'access.denied', status: 'denied', details: { method: req.method, path: req.originalUrl, required: perms } });
    throw forbidden();
  }
  next();
};

export const hasPermission = (req, perm) => Boolean(req.user?.permissions?.includes(perm));

/**
 * CSRF defence in depth: state-changing requests must carry a custom header, which a
 * cross-site form or image cannot add. Cross-site production cookies additionally
 * use an origin allowlist and require HTTPS; this custom header remains required.
 */
export function requireCsrfHeader(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'hms') throw forbidden('Request blocked: missing security header.', { code: 'CSRF' });
  next();
}
