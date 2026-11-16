import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z, v, validate } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { SESSION_COOKIE, sessionCookieOptions } from '../../auth/sessions.js';
import { isTest, env } from '../../config/env.js';
import * as auth from './service.js';
import { roleHome } from './roleHome.js';

const router = Router();

// Only failed attempts count: every workstation in a hospital may share one NAT'd IP, so
// successful sign-ins must never exhaust the budget. Per-account lockout (3 attempts) is the
// main brute-force control; this limiter caps password spraying from one address.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: isTest ? 10_000 : env.LOGIN_RATE_LIMIT,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many sign-in attempts from this network. Please wait a few minutes.', code: 'RATE_LIMITED' } },
});

router.post(
  '/login',
  loginLimiter,
  validate({ body: z.object({ username: v.text(60, 'Username'), password: z.string().min(1, 'Password is required.').max(200) }) }),
  async (req, res) => {
    const token = await auth.login(req, req.body);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    res.json({ ok: true });
  },
);

router.post('/logout', requireAuth, async (req, res) => {
  await auth.logout(req);
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: { ...req.user, home: roleHome(req.user.role) },
    session: req.session,
    config: { hospitalName: env.HOSPITAL_NAME, currency: env.CURRENCY, timezone: env.HOSPITAL_TZ },
  });
});

// The client calls this while the user is actively working (typing, clicking) so that
// long form entry does not count as inactivity. Background polling does not call it.
router.post('/heartbeat', requireAuth, (req, res) => res.json({ ok: true, idleTimeoutSeconds: req.session.idleTimeoutSeconds }));

router.post('/forgot-password', loginLimiter, validate({ body: z.object({ email: v.email() }) }), async (req, res) => {
  const { emailMode } = await auth.requestPasswordReset(req, req.body.email);
  res.json({ ok: true, emailMode, message: 'A password reset link has been sent to your registered email address.' });
});

router.get('/reset-password/:token', async (req, res) => {
  await auth.validateResetToken(req.params.token);
  res.json({ valid: true });
});

router.post(
  '/reset-password',
  loginLimiter,
  validate({ body: z.object({ token: z.string().min(10), password: v.password() }) }),
  async (req, res) => {
    await auth.resetPassword(req, req.body);
    res.json({ ok: true, message: 'Your password has been changed. You can now sign in.' });
  },
);

router.post(
  '/change-password',
  requireAuth,
  validate({ body: z.object({ currentPassword: z.string().min(1, 'Current password is required.'), newPassword: v.password() }) }),
  async (req, res) => {
    await auth.changePassword(req, req.body);
    res.json({ ok: true, message: 'Password changed.' });
  },
);

export default router;
