// UC-01..UC-04: login, lockout, logout, session timeout, password reset.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { anon, db, login, resetData, lastOutboxTo, settle, DEMO_PASSWORD } from './helpers.js';
import { closeDb } from '../src/db/knex.js';

beforeAll(resetData);
afterAll(closeDb);

describe('Login (UC-01, UC-03)', () => {
  it('logs in with valid credentials and returns the role dashboard', async () => {
    const c = await login('reception');
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('receptionist');
    expect(me.body.user.home).toBe('/dashboard');
    expect(me.body.session.idleTimeoutSeconds).toBe(600);
    const log = await db('audit_logs').where({ action: 'auth.login', username: 'reception' }).first();
    expect(log).toBeTruthy();
  });

  it('rejects a wrong password with a clear message', async () => {
    const res = await anon().post('/api/auth/login', { username: 'pharmacist', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.error.message).toMatch(/Invalid username or password/);
  });

  it('rejects an unknown username with the same message (no user enumeration)', async () => {
    const res = await anon().post('/api/auth/login', { username: 'ghost', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after 3 failed attempts, even for the correct password', async () => {
    const a = anon();
    await a.post('/api/auth/login', { username: 'accountant', password: 'bad1' });
    await a.post('/api/auth/login', { username: 'accountant', password: 'bad2' });
    const third = await a.post('/api/auth/login', { username: 'accountant', password: 'bad3' });
    expect(third.status).toBe(423);
    expect(third.body.error.code).toBe('ACCOUNT_LOCKED');
    const correct = await a.post('/api/auth/login', { username: 'accountant', password: DEMO_PASSWORD });
    expect(correct.status).toBe(423);
    const user = await db('users').where({ username: 'accountant' }).first();
    expect(new Date(user.locked_until) > new Date()).toBe(true);
    expect(await db('audit_logs').where({ action: 'auth.account_locked', username: 'accountant' }).first()).toBeTruthy();
  });

  it('lets an admin unlock a locked account', async () => {
    const admin = await login('admin');
    const user = await db('users').where({ username: 'accountant' }).first();
    expect((await admin.post(`/api/users/${user.id}/unlock`)).status).toBe(200);
    await login('accountant');
  });

  it('stores passwords as bcrypt hashes, never plaintext', async () => {
    const user = await db('users').where({ username: 'admin' }).first();
    expect(user.password_hash).toMatch(/^\$2[aby]\$/);
    expect(user.password_hash).not.toContain(DEMO_PASSWORD);
  });
});

describe('Sessions (UC-02)', () => {
  it('logout ends the session', async () => {
    const c = await login('labtech');
    expect((await c.post('/api/auth/logout')).status).toBe(200);
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('expires the session after 10 minutes of inactivity', async () => {
    const c = await login('pharmacist');
    const user = await db('users').where({ username: 'pharmacist' }).first();
    await db('sessions').where({ user_id: user.id }).whereNull('revoked_at').update({ last_activity_at: new Date(Date.now() - 10 * 60_000 - 1000) });
    const res = await c.get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
    expect(await db('audit_logs').where({ action: 'auth.session_timeout', user_id: user.id }).first()).toBeTruthy();
  });

  it('keeps the session alive while the user is active (9 minutes idle is fine)', async () => {
    const c = await login('pharmacist');
    const user = await db('users').where({ username: 'pharmacist' }).first();
    await db('sessions').where({ user_id: user.id }).whereNull('revoked_at').update({ last_activity_at: new Date(Date.now() - 9 * 60_000) });
    expect((await c.post('/api/auth/heartbeat')).status).toBe(200);
  });

  it('background polling does not reset the inactivity timer', async () => {
    const c = await login('dr.bilal');
    const user = await db('users').where({ username: 'dr.bilal' }).first();
    const old = new Date(Date.now() - 5 * 60_000);
    await db('sessions').where({ user_id: user.id }).whereNull('revoked_at').update({ last_activity_at: old });
    await c.get('/api/notifications').set('X-HMS-Background', '1');
    const s = await db('sessions').where({ user_id: user.id }).whereNull('revoked_at').first();
    expect(new Date(s.last_activity_at).getTime()).toBe(old.getTime());
  });

  it('rejects state-changing requests without the CSRF header', async () => {
    const c = await login('reception');
    const res = await c.raw.post('/api/auth/logout');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF');
  });
});

describe('Password reset (UC-04)', () => {
  it('tells the user when the email is not registered', async () => {
    const res = await anon().post('/api/auth/forgot-password', { email: 'nobody@example.com' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EMAIL_NOT_FOUND');
  });

  it('sends a link that resets the password and expires after use', async () => {
    const res = await anon().post('/api/auth/forgot-password', { email: 'labtech@hms.example' });
    expect(res.status).toBe(200);
    await settle();
    const mail = await lastOutboxTo('labtech@hms.example');
    const token = mail.body_text.match(/reset-password\/([\w-]+)/)[1];
    const tokenRow = await db('password_reset_tokens').orderBy('id', 'desc').first();
    const hours = (new Date(tokenRow.expires_at) - new Date(tokenRow.created_at)) / 3600000;
    expect(hours).toBeLessThanOrEqual(24.01); // DB clock vs app clock differ by milliseconds

    const weak = await anon().post('/api/auth/reset-password', { token, password: 'short' });
    expect(weak.status).toBe(422);
    const ok = await anon().post('/api/auth/reset-password', { token, password: 'NewPassw0rd' });
    expect(ok.status).toBe(200);
    await login('labtech', 'NewPassw0rd');
    const reuse = await anon().post('/api/auth/reset-password', { token, password: 'Another1Pass' });
    expect(reuse.status).toBe(400);
  });

  it('rejects an expired reset link', async () => {
    await anon().post('/api/auth/forgot-password', { email: 'pharmacist@hms.example' });
    await settle();
    const mail = await lastOutboxTo('pharmacist@hms.example');
    const token = mail.body_text.match(/reset-password\/([\w-]+)/)[1];
    await db('password_reset_tokens').orderBy('id', 'desc').limit(1).update({ expires_at: new Date(Date.now() - 1000) });
    const res = await anon().post('/api/auth/reset-password', { token, password: 'NewPassw0rd' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RESET_EXPIRED');
  });
});
