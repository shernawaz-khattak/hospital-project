// RBAC (NFR-02) and administration (UC-05..UC-11).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { anon, db, login, resetData } from './helpers.js';
import { closeDb } from '../src/db/knex.js';

beforeAll(resetData);
afterAll(closeDb);

describe('Role-based access control', () => {
  it('requires authentication for protected APIs', async () => {
    expect((await anon().get('/api/patients')).status).toBe(401);
    expect((await anon().get('/api/billing/bills')).status).toBe(401);
  });

  it.each([
    ['reception', '/api/users'],
    ['reception', '/api/system/backups'],
    ['labtech', '/api/billing/bills'],
    ['labtech', '/api/patients'],
    ['pharmacist', '/api/billing/bills'],
    ['accountant', '/api/lab/requests'],
    ['dr.ahmed', '/api/users'],
    ['dr.ahmed', '/api/reports/financial/summary'],
    ['sysadmin', '/api/patients'],
    ['admin', '/api/clinical/patients'],
  ])('%s is denied %s', async (user, url) => {
    const c = await login(user);
    const res = await c.get(url);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('You do not have permission to perform this action.');
  });

  it('logs denied access attempts', async () => {
    const row = await db('audit_logs').where({ action: 'access.denied', username: 'reception' }).first();
    expect(row.status).toBe('denied');
  });

  it('a patient cannot use staff APIs', async () => {
    const p = await login(`P-${new Date().getFullYear()}-000001`);
    for (const url of ['/api/patients', '/api/patients/2', '/api/billing/bills', '/api/lab/requests', '/api/users']) {
      expect((await p.get(url)).status).toBe(403);
    }
  });

  it('role permission changes take effect at the next login (UC-06)', async () => {
    const admin = await login('admin');
    const before = await login('labtech');
    const roles = (await admin.get('/api/users/roles')).body.roles;
    const lab = roles.find((r) => r.code === 'lab_technician');
    const res = await admin.put('/api/users/roles/lab_technician/permissions', { permissions: [...lab.permissions, 'inventory.view'] });
    expect(res.status).toBe(200);
    expect((await before.get('/api/pharmacy/medicines')).status).toBe(403); // existing session unchanged
    const after = await login('labtech');
    expect((await after.get('/api/pharmacy/medicines')).status).toBe(200);
  });

  it('protects the admin role from losing user management', async () => {
    const admin = await login('admin');
    const res = await admin.put('/api/users/roles/admin/permissions', { permissions: ['staff.view'] });
    expect(res.status).toBe(400);
  });
});

describe('User management (UC-05..UC-07)', () => {
  it('creates a user with a role and returns a one-time temporary password', async () => {
    const admin = await login('admin');
    const dep = await db('departments').where({ code: 'FD' }).first();
    const res = await admin.post('/api/users', { username: 'new.reception', fullName: 'New Receptionist', email: 'newrec@hms.example', role: 'receptionist', departmentId: dep.id });
    expect(res.status).toBe(201);
    expect(res.body.tempPassword).toMatch(/.{10,}/);
    const c = await login('new.reception', res.body.tempPassword);
    const blocked = await c.get('/api/patients');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await c.post('/api/auth/change-password', { currentPassword: res.body.tempPassword, newPassword: 'Welcome123' })).status).toBe(200);
    expect((await c.get('/api/patients')).status).toBe(200);
  });

  it('rejects a duplicate username (UC-05 2-A)', async () => {
    const admin = await login('admin');
    const res = await admin.post('/api/users', { username: 'RECEPTION', fullName: 'Dup', email: 'dup@hms.example', role: 'receptionist' });
    expect(res.status).toBe(409);
    expect(res.body.error.fields.username).toBeTruthy();
  });

  it('highlights invalid fields (UC-06 2-A)', async () => {
    const admin = await login('admin');
    const res = await admin.post('/api/users', { username: 'x', fullName: '', email: 'not-an-email', role: '' });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fields)).toEqual(expect.arrayContaining(['username', 'fullName', 'email', 'role']));
  });

  it('prevents an admin from deleting their own account (UC-07 2-A)', async () => {
    const admin = await login('admin');
    const me = (await admin.get('/api/auth/me')).body.user;
    const res = await admin.delete(`/api/users/${me.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SELF_DELETE');
  });

  it('archives a user before deleting; the user can no longer log in', async () => {
    const admin = await login('admin');
    const u = await db('users').where({ username: 'reception2' }).first();
    expect((await admin.delete(`/api/users/${u.id}`, { reason: 'Left the hospital' })).status).toBe(200);
    const archived = await db('archived_users').where({ original_user_id: u.id }).first();
    expect(archived.snapshot.user.username).toBe('reception2');
    expect(archived.snapshot.user.password_hash).toBeUndefined();
    expect((await anon().post('/api/auth/login', { username: 'reception2', password: 'Demo@1234' })).status).toBe(401);
    expect(await db('audit_logs').where({ action: 'user.delete', entity_id: String(u.id) }).first()).toBeTruthy();
  });
});

describe('Doctors, departments, staffing (UC-08..UC-11)', () => {
  it('requires a unique doctor ID and specialization', async () => {
    const admin = await login('admin');
    const dep = await db('departments').where({ code: 'GEN' }).first();
    const base = { fullName: 'Dr. Test', username: 'dr.test', email: 'drtest@hms.example', specialization: 'Dermatologist', licenseNumber: 'PMC-99999-P', departmentId: dep.id, consultationFee: 2000, slotMinutes: 15, schedules: [{ weekday: 1, startTime: '09:00', endTime: '12:00' }] };
    const dup = await admin.post('/api/doctors', { ...base, doctorCode: 'DOC-001' });
    expect(dup.status).toBe(409);
    const missing = await admin.post('/api/doctors', { ...base, doctorCode: 'DOC-099', specialization: '' });
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields.specialization).toBeTruthy();
    const ok = await admin.post('/api/doctors', { ...base, doctorCode: 'DOC-099' });
    expect(ok.status).toBe(201);
  });

  it('rejects overlapping schedule blocks', async () => {
    const admin = await login('admin');
    const res = await admin.put('/api/doctors/1/schedules', { schedules: [{ weekday: 1, startTime: '09:00', endTime: '12:00' }, { weekday: 1, startTime: '11:00', endTime: '13:00' }] });
    expect(res.status).toBe(422);
  });

  it('enforces unique department names (UC-09 2-A)', async () => {
    const admin = await login('admin');
    const res = await admin.post('/api/departments', { name: 'cardiology', code: 'CAR2' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already exists/);
  });

  it('rejects zero or negative staffing levels (UC-10 2-A)', async () => {
    const admin = await login('admin');
    const dep = await db('departments').first();
    const role = await db('roles').where({ code: 'receptionist' }).first();
    for (const n of [0, -2]) {
      const res = await admin.put('/api/staff/staffing-levels', { departmentId: dep.id, roleId: role.id, requiredCount: n });
      expect(res.status).toBe(422);
    }
    expect((await admin.put('/api/staff/staffing-levels', { departmentId: dep.id, roleId: role.id, requiredCount: 4 })).status).toBe(200);
  });

  it('lists staff, searchable and sortable by name, role and department (UC-11)', async () => {
    const admin = await login('admin');
    const res = await admin.get('/api/staff?sort=role&dir=asc&pageSize=100');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(10);
    const roles = res.body.data.map((s) => s.roleName);
    expect([...roles].sort()).toEqual(roles);
    const search = await admin.get('/api/staff?search=zainab');
    expect(search.body.data[0].fullName).toBe('Zainab Akhtar');
    const none = await admin.get('/api/staff?search=nobody-here');
    expect(none.body.data).toHaveLength(0);
  });
});
