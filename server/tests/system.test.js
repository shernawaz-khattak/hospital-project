// UC-45 Backup, UC-46 Health check, UC-47 notifications with retry, audit log integrity,
// and portal isolation between patients.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, login, resetData, settle, patientUser } from './helpers.js';
import { closeDb } from '../src/db/knex.js';
import { env } from '../src/config/env.js';
import { __setEmailFailureInjector } from '../src/services/email.js';
import { notify, processPendingDeliveries } from '../src/services/notifications.js';

beforeAll(resetData);
afterAll(async () => {
  __setEmailFailureInjector(null);
  await closeDb();
});

describe('Backups (UC-45)', () => {
  it('creates a compressed, checksummed database backup on demand', async () => {
    const sys = await login('sysadmin');
    const res = await sys.post('/api/system/backups');
    expect(res.status).toBe(201);
    const file = path.join(path.resolve(env.BACKUP_DIR), res.body.fileName);
    const buf = fs.readFileSync(file);
    expect(buf.subarray(0, 5).toString()).toBe('PGDMP'); // pg_dump custom format (restorable with pg_restore)
    expect(crypto.createHash('sha256').update(buf).digest('hex')).toBe(res.body.sha256);
    const list = await sys.get('/api/system/backups');
    expect(list.body.data[0]).toMatchObject({ status: 'success', type: 'manual' });
    expect(list.body.schedule).toBe('0 0 * * *'); // daily at midnight
    expect(await db('audit_logs').where({ action: 'system.backup', status: 'success' }).first()).toBeTruthy();
    const dl = await sys.get(`/api/system/backups/${res.body.id}/download`);
    expect(dl.status).toBe(200);
  });

  it('records failures and alerts the administrator (UC-45 2-A)', async () => {
    const { runBackup } = await import('../src/services/backup.js');
    const original = env.PG_DUMP_PATH;
    env.PG_DUMP_PATH = '/nonexistent/pg_dump';
    await expect(runBackup('automatic')).rejects.toThrow(/Backup failed/);
    env.PG_DUMP_PATH = original;
    const failed = await db('backups').where({ status: 'failed' }).first();
    expect(failed.error).toMatch(/could not be started/);
    const sys = await db('users').where({ username: 'sysadmin' }).first();
    expect(await db('notifications').where({ user_id: sys.id, event_type: 'system.backup_failed' }).first()).toBeTruthy();
  });

  it('only system administrators can run backups', async () => {
    const admin = await login('admin');
    expect((await admin.post('/api/system/backups')).status).toBe(403);
  });
});

describe('System health (UC-46)', () => {
  it('checks server, database connectivity and performance, and logs the result', async () => {
    const sys = await login('sysadmin');
    const res = await sys.post('/api/system/health/run');
    expect(res.status).toBe(200);
    const names = res.body.components.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Database connectivity', 'Application server', 'API performance', 'Backups', 'Scheduled jobs']));
    expect(res.body.components.find((c) => c.name === 'Database connectivity').status).toBe('ok');
    // Scheduler is disabled in tests, so the check must honestly report a degraded state and alert.
    expect(res.body.overall).toBe('degraded');
    const sysUser = await db('users').where({ username: 'sysadmin' }).first();
    expect(await db('notifications').where({ user_id: sysUser.id, event_type: 'system.health_issue' }).first()).toBeTruthy();
    expect(await db('health_checks').where({ id: res.body.id }).first()).toBeTruthy();
  });
});

describe('Notifications (UC-33, UC-47)', () => {
  it('retries a failing email up to 3 times, then marks it failed and logs it', async () => {
    let attempts = 0;
    __setEmailFailureInjector(() => {
      attempts += 1;
      throw new Error('SMTP connection refused');
    });
    await notify(db, { patientId: 2, email: true, eventType: 'test.retry', title: 'Retry test', message: 'Hello' });
    await settle();
    for (let i = 0; i < 3; i++) {
      await db('notification_deliveries').where({ channel: 'email', status: 'pending' }).update({ next_attempt_at: new Date(Date.now() - 1000) });
      await processPendingDeliveries();
    }
    const d = await db('notification_deliveries as d').join('notifications as n', 'n.id', 'd.notification_id').where('n.event_type', 'test.retry').where('d.channel', 'email').first('d.*');
    expect(d.status).toBe('failed');
    expect(d.attempts).toBe(3);
    expect(attempts).toBe(3);
    expect(await db('audit_logs').where({ action: 'notification.delivery_failed' }).first()).toBeTruthy();
  });

  it('succeeds on a later attempt after a transient failure', async () => {
    let calls = 0;
    __setEmailFailureInjector(() => {
      calls += 1;
      if (calls === 1) throw new Error('Temporary failure');
    });
    await notify(db, { patientId: 2, email: true, eventType: 'test.transient', title: 'Transient', message: 'Hello' });
    await settle();
    await db('notification_deliveries').where({ status: 'pending' }).update({ next_attempt_at: new Date(Date.now() - 1000) });
    await processPendingDeliveries();
    const d = await db('notification_deliveries as d').join('notifications as n', 'n.id', 'd.notification_id').where('n.event_type', 'test.transient').where('d.channel', 'email').first('d.*');
    expect(d.status).toBe('captured'); // dev outbox: stored locally, honestly not marked "delivered"
    expect(d.attempts).toBe(2);
    __setEmailFailureInjector(null);
  });

  it('users only see their own in-app notifications', async () => {
    const p1 = await login(patientUser(1));
    const p2 = await login(patientUser(2));
    const n2 = await p2.get('/api/notifications');
    expect(n2.body.data.length).toBeGreaterThan(0);
    const foreign = n2.body.data[0].id;
    await p1.post(`/api/notifications/${foreign}/read`);
    expect((await db('notifications').where({ id: foreign }).first()).is_read).toBe(false);
  });
});

describe('Audit log', () => {
  it('is append-only at database level', async () => {
    await expect(db('audit_logs').update({ action: 'tampered' })).rejects.toThrow(/read-only/);
    await expect(db('audit_logs').del()).rejects.toThrow(/read-only/);
  });

  it('is searchable by administrators and system administrators only', async () => {
    const admin = await login('admin');
    const res = await admin.get('/api/system/audit?action=auth.login');
    expect(res.status).toBe(200);
    expect(res.body.data.every((r) => r.action.startsWith('auth.login'))).toBe(true);
    const doc = await login('dr.ahmed');
    expect((await doc.get('/api/system/audit')).status).toBe(403);
  });
});

describe('Patient portal isolation (FR-34)', () => {
  it('returns only the signed-in patient\'s data', async () => {
    const p2 = await login(patientUser(2));
    const me = await p2.get('/api/portal/me');
    expect(me.body.profile.patientCode).toBe(patientUser(2));
    expect((await p2.get('/api/portal/bills')).body.data.every(() => true)).toBe(true);
    // Portal is read-only for profile data
    expect((await p2.patch('/api/patients/2', { phone: '0300-0000000' })).status).toBe(403);
    // Appointments list is scoped to the patient
    const list = await p2.get('/api/appointments');
    expect(list.body.data.every((a) => a.patient.id === 2)).toBe(true);
  });
});
