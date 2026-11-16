// UC-12..UC-17: patient registration, duplicates, verification, appointments, waitlist.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, login, nextWeekday, resetData, settle, patientUser, todayStr, addDays } from './helpers.js';
import { closeDb } from '../src/db/knex.js';
import { decrypt } from '../src/lib/crypto.js';
import { minutesToTime, nowTimeStr, timeToMinutes, weekdayOf } from '../src/lib/dates.js';

beforeAll(resetData);
afterAll(closeDb);

const newPatient = { firstName: 'Kiran', lastName: 'Aslam', dateOfBirth: '1991-04-04', gender: 'female', phone: '0345-1112233', nationalId: '37405-1234567-8', allergies: 'Latex', medicalHistory: 'None significant' };

describe('Patient registration (UC-12, UC-13, UC-14)', () => {
  it('registers a patient with a unique patient ID', async () => {
    const r = await login('reception');
    const res = await r.post('/api/patients', newPatient);
    expect(res.status).toBe(201);
    expect(res.body.patient.patientCode).toMatch(/^P-\d{4}-\d{6}$/);
    expect(await db('audit_logs').where({ action: 'patient.create' }).first()).toBeTruthy();
  });

  it('encrypts sensitive fields at rest (NFR-03)', async () => {
    const row = await db('patients').where({ first_name: 'Kiran' }).first();
    expect(row.national_id_enc).not.toContain('1234567');
    expect(row.allergies_enc).not.toContain('Latex');
    expect(decrypt(row.allergies_enc)).toBe('Latex');
  });

  it('blocks a second patient with the same national ID', async () => {
    const r = await login('reception');
    const res = await r.post('/api/patients', { ...newPatient, firstName: 'Other', dateOfBirth: '1980-01-01' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_PATIENT');
  });

  it('warns about a same name + date of birth duplicate and requires confirmation', async () => {
    const r = await login('reception');
    const body = { ...newPatient, nationalId: '', phone: '0345-0000001', firstName: 'KIRAN' };
    const warn = await r.post('/api/patients', body);
    expect(warn.status).toBe(409);
    expect(warn.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(warn.body.error.details.matches[0].reason).toBe('name_dob');
    const noReason = await r.post('/api/patients', { ...body, confirmDuplicate: true });
    expect(noReason.status).toBe(422);
    const ok = await r.post('/api/patients', { ...body, confirmDuplicate: true, duplicateReason: 'Different mother name; verified CNIC card' });
    expect(ok.status).toBe(201);
  });

  it('validates required fields with per-field messages', async () => {
    const r = await login('reception');
    const res = await r.post('/api/patients', { firstName: '', gender: 'x', phone: 'abc', dateOfBirth: addDays(todayStr(), 3) });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toMatchObject({ firstName: 'First name is required.', lastName: 'Last name is required.', gender: 'Select a gender.', dateOfBirth: 'Date of birth cannot be in the future.' });
  });

  it('logs every update with changed fields and time (UC-13)', async () => {
    const r = await login('reception');
    const p = await db('patients').where({ first_name: 'Kiran', last_name: 'Aslam' }).orderBy('id').first();
    const res = await r.patch(`/api/patients/${p.id}`, { phone: '0345-9998887', allergies: 'Latex, iodine' });
    expect(res.status).toBe(200);
    const changes = await r.get(`/api/patients/${p.id}/changes`);
    const update = changes.body.data.find((c) => c.action === 'patient.update');
    expect(update.details.changes.map((c) => c.field)).toEqual(['phone', 'allergies']);
    expect(update.details.changes.find((c) => c.field === 'allergies').to).toBeUndefined(); // sensitive values not logged
    expect(update.at).toBeTruthy();
  });

  it('verifies patient IDs (UC-14)', async () => {
    const r = await login('reception');
    const ok = await r.get(`/api/patients/verify/${patientUser(1)}`);
    expect(ok.body.valid).toBe(true);
    expect(ok.body.lookupMs).toBeLessThan(2000);
    const bad = await r.get('/api/patients/verify/P-1999-000000');
    expect(bad.body.valid).toBe(false);
    expect(bad.body.message).toMatch(/Invalid patient ID/);
  });

  it('searches by ID, name, phone and national ID', async () => {
    const r = await login('reception');
    for (const q of [patientUser(2), 'mariam', '0301-2234502']) {
      const res = await r.get(`/api/patients?q=${encodeURIComponent(q)}`);
      expect(res.body.data.some((p) => p.patientCode === patientUser(2))).toBe(true);
    }
    const cnic = await r.get('/api/patients?q=37405-1234567-8');
    expect(cnic.body.data[0].firstName).toBe('Kiran');
  });
});

describe('Appointments (UC-15, UC-16)', () => {
  const monday = nextWeekday(1);

  it('books an appointment and assigns sequential token numbers', async () => {
    const r = await login('reception');
    const a = await r.post('/api/appointments', { patientId: 1, doctorId: 1, date: monday, startTime: '09:00', reason: 'Follow-up' });
    expect(a.status).toBe(201);
    expect(a.body.tokenNumber).toBe(1);
    const b = await r.post('/api/appointments', { patientId: 2, doctorId: 1, date: monday, startTime: '09:15' });
    expect(b.body.tokenNumber).toBe(2);
    await settle();
    const note = await db('notifications').where({ event_type: 'appointment.confirmed', patient_id: 1 }).first();
    expect(note.message).toMatch(/Token number: 1/);
  });

  it('prevents double booking and suggests the next available slot', async () => {
    const r = await login('reception');
    const res = await r.post('/api/appointments', { patientId: 3, doctorId: 1, date: monday, startTime: '09:00' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('This appointment slot is already booked.');
    expect(res.body.error.details.suggestions[0]).toMatchObject({ date: monday, startTime: '09:30' });
  });

  it('prevents double booking under concurrent requests', async () => {
    const r = await login('reception');
    const results = await Promise.all([4, 5, 6].map((pid) => r.post('/api/appointments', { patientId: pid, doctorId: 1, date: monday, startTime: '10:00' })));
    expect(results.filter((x) => x.status === 201)).toHaveLength(1);
    expect(results.filter((x) => x.status === 409)).toHaveLength(2);
  });

  it('rejects slots outside the doctor schedule and days the doctor does not work', async () => {
    const r = await login('reception');
    expect((await r.post('/api/appointments', { patientId: 3, doctorId: 1, date: monday, startTime: '09:07' })).status).toBe(422);
    const sunday = nextWeekday(0);
    const res = await r.post('/api/appointments', { patientId: 3, doctorId: 1, date: sunday, startTime: '09:00' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DOCTOR_UNAVAILABLE');
  });

  it('lets a patient book for themselves but not for others (FR-11)', async () => {
    const p = await login(patientUser(1));
    const own = await p.post('/api/appointments', { patientId: 1, doctorId: 2, date: monday, startTime: '10:00' });
    expect(own.status).toBe(201);
    expect(own.body.bookingChannel).toBe('portal');
    const other = await p.post('/api/appointments', { patientId: 2, doctorId: 2, date: monday, startTime: '10:20' });
    expect(other.status).toBe(403);
  });

  it('cancels with a reason, notifies the doctor and frees the slot', async () => {
    const r = await login('reception');
    const appt = await db('appointments').where({ patient_id: 2, appointment_date: monday }).first();
    const noReason = await r.post(`/api/appointments/${appt.id}/cancel`, {});
    expect(noReason.status).toBe(422);
    const res = await r.post(`/api/appointments/${appt.id}/cancel`, { reason: 'Patient travelling' });
    expect(res.body.pendingApproval).toBe(false);
    await settle();
    const doctorUser = await db('users').where({ username: 'dr.ahmed' }).first();
    expect(await db('notifications').where({ user_id: doctorUser.id, event_type: 'appointment.cancelled' }).first()).toBeTruthy();
    const slots = await r.get(`/api/appointments/slots?doctorId=1&date=${monday}`);
    expect(slots.body.slots.find((s) => s.startTime === '09:15').available).toBe(true);
  });

  it('a patient cannot cancel someone else\'s appointment', async () => {
    const p = await login(patientUser(2));
    const appt = await db('appointments').where({ patient_id: 1, appointment_date: monday, doctor_id: 1 }).first();
    expect((await p.post(`/api/appointments/${appt.id}/cancel`, { reason: 'x' })).status).toBe(403);
  });

  it('reschedules to a new slot and records the link', async () => {
    const r = await login('reception');
    const appt = await db('appointments').where({ patient_id: 1, appointment_date: monday, doctor_id: 1 }).first();
    const res = await r.post(`/api/appointments/${appt.id}/reschedule`, { date: monday, startTime: '11:00', reason: 'Clash with work' });
    expect(res.status).toBe(200);
    expect(res.body.rescheduledFromId).toBe(appt.id);
    expect((await db('appointments').where({ id: appt.id }).first()).status).toBe('rescheduled');
  });

  it('requires admin approval to cancel within 1 hour of the appointment (UC-16 2-A)', async () => {
    // Build a same-day appointment ~30 minutes from now directly (a schedule covering now).
    const now = timeToMinutes(nowTimeStr());
    if (now + 40 >= 24 * 60) return; // too close to midnight to construct the scenario
    const start = minutesToTime(Math.ceil((now + 30) / 5) * 5);
    const today = todayStr();
    const doc = await db('doctors').where({ doctor_code: 'DOC-006' }).first();
    const [appt] = await db('appointments').insert({ appointment_code: 'APT-TEST-1H', patient_id: 7, doctor_id: doc.id, appointment_date: today, start_time: start, end_time: minutesToTime(timeToMinutes(start) + 15), token_number: 99, booked_by: 1 }).returning('*');
    const r = await login('reception');
    const res = await r.post(`/api/appointments/${appt.id}/cancel`, { reason: 'Emergency at home' });
    expect(res.status).toBe(200);
    expect(res.body.pendingApproval).toBe(true);
    expect((await db('appointments').where({ id: appt.id }).first()).status).toBe('cancellation_requested');

    const admin = await login('admin');
    const list = await admin.get('/api/appointments/cancellation-requests');
    const reqRow = list.body.data.find((x) => x.appointmentId === appt.id);
    expect(reqRow).toBeTruthy();
    expect((await r.get('/api/appointments/cancellation-requests')).status).toBe(403);
    expect((await admin.post(`/api/appointments/cancellation-requests/${reqRow.id}/approve`, { note: 'OK' })).status).toBe(200);
    expect((await db('appointments').where({ id: appt.id }).first()).status).toBe('cancelled');
    expect(weekdayOf(today)).toBeGreaterThanOrEqual(0);
  });
});

describe('Waitlist (UC-17)', () => {
  it('only allows waitlisting when all slots are full, and notifies first-come-first-served', async () => {
    const r = await login('reception');
    const day = nextWeekday(5, addDays(todayStr(), 8)); // a Friday: Dr. Usman 11:00-15:00, 20-min slots
    const doc = await db('doctors').where({ doctor_code: 'DOC-005' }).first();
    const early = await r.post('/api/waitlist', { patientId: 9, doctorId: doc.id, preferredDate: day });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('SLOTS_AVAILABLE');

    const slots = (await r.get(`/api/appointments/slots?doctorId=${doc.id}&date=${day}`)).body.slots;
    let pid = 1;
    for (const s of slots) {
      const res = await r.post('/api/appointments', { patientId: pid++, doctorId: doc.id, date: day, startTime: s.startTime });
      expect(res.status).toBe(201);
    }
    const w1 = await r.post('/api/waitlist', { patientId: 15, doctorId: doc.id, preferredDate: day, notes: 'Knee pain' });
    expect(w1.status).toBe(201);
    expect(w1.body.position).toBe(1);
    const w2 = await r.post('/api/waitlist', { patientId: 16, doctorId: doc.id, preferredDate: day });
    expect(w2.body.position).toBe(2);

    const first = await db('appointments').where({ doctor_id: doc.id, appointment_date: day }).orderBy('start_time').first();
    await r.post(`/api/appointments/${first.id}/cancel`, { reason: 'Not needed' });
    await settle();
    const entries = await db('waitlist_entries').where({ doctor_id: doc.id, preferred_date: day }).orderBy('created_at');
    expect(entries[0].status).toBe('notified');
    expect(entries[1].status).toBe('waiting');
    expect(await db('notifications').where({ event_type: 'waitlist.slot_available', patient_id: 15 }).first()).toBeTruthy();

    const booked = await r.post(`/api/waitlist/${entries[0].id}/book`, { startTime: first.start_time.slice(0, 5) });
    expect(booked.status).toBe(201);
    expect(booked.body.bookingChannel).toBe('waitlist');
    expect((await db('waitlist_entries').where({ id: entries[0].id }).first()).status).toBe('booked');
  });
});
