// Regression tests for the findings of the independent security & correctness review.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { anon, db, login, resetData, settle, patientUser, todayStr, nextWeekday } from './helpers.js';
import { closeDb } from '../src/db/knex.js';
import { localDateTime, minutesToTime, nowTimeStr, timeToMinutes } from '../src/lib/dates.js';

beforeAll(resetData);
afterAll(closeDb);

describe('Review fixes', () => {
  it('the development mailbox (which holds reset links) requires a signed-in system administrator', async () => {
    expect((await anon().get('/api/dev/outbox')).status).toBe(401);
    // In the test environment the mailbox is not mounted at all; in development it is mounted
    // behind requirePermission('system.health') (see app.js). Either way a doctor gets no data.
    const doctor = await login('dr.ahmed');
    expect([403, 404]).toContain((await doctor.get('/api/dev/outbox')).status);
  });

  it('reset tokens are not stored in readable form in notifications', async () => {
    await anon().post('/api/auth/forgot-password', { email: 'labtech@hms.example' });
    await settle();
    const n = await db('notifications').where({ event_type: 'auth.password_reset' }).orderBy('id', 'desc').first();
    expect(n.link.startsWith('enc:')).toBe(true);
    expect(n.link).not.toContain('reset-password');
  });

  it('parallel wrong passwords cannot exceed the 3-attempt limit', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => anon().post('/api/auth/login', { username: 'pharmacist', password: 'wrong' })));
    expect(results.filter((r) => r.status === 401)).toHaveLength(2);
    expect(results.filter((r) => r.status === 423)).toHaveLength(8);
    await db('users').where({ username: 'pharmacist' }).update({ locked_until: null, failed_login_count: 0 });
  });

  it('a dispense request cannot list the same item twice (no over-dispensing)', async () => {
    const d = await login('dr.ahmed');
    const appt = await db('appointments').insert({ appointment_code: 'APT-TEST-RV1', patient_id: 5, doctor_id: 1, appointment_date: todayStr(), start_time: '00:05', end_time: '00:20', token_number: 77, status: 'completed', booked_by: 1 }).returning('*');
    const visit = await d.post('/api/clinical/visits', { patientId: 5, appointmentId: appt[0].id, visitType: 'opd' });
    await d.post(`/api/clinical/visits/${visit.body.id}/diagnoses`, { conditionName: 'Tonsillitis', severity: 'mild', notes: 'Red tonsils' });
    const losec = await db('medicines').where({ name: 'Losec' }).first();
    const rx = await d.post(`/api/clinical/visits/${visit.body.id}/prescriptions`, { items: [{ medicineId: losec.id, dosage: '20 mg', frequency: 'Daily', durationDays: 5, quantity: 5 }] });
    const ph = await login('pharmacist');
    await ph.post(`/api/pharmacy/prescriptions/${rx.body.id}/verify`);
    const item = (await ph.get(`/api/pharmacy/prescriptions/${rx.body.id}`)).body.items[0];
    const before = item.stock;
    const dup = await ph.post(`/api/pharmacy/prescriptions/${rx.body.id}/dispense`, { items: [{ prescriptionItemId: item.id, quantity: 3 }, { prescriptionItemId: item.id, quantity: 3 }] });
    expect(dup.status).toBe(422);
    const ok = await ph.post(`/api/pharmacy/prescriptions/${rx.body.id}/dispense`, { items: [{ prescriptionItemId: item.id, quantity: 5 }] });
    expect(ok.body.prescription.items[0].stock).toBe(before - 5);
  });

  it('an emergency visit without a care relationship requires the audited emergency-access reason', async () => {
    const d = await login('dr.usman');
    const denied = await d.post('/api/clinical/visits', { patientId: 12, visitType: 'emergency' });
    expect(denied.status).toBe(403);
    expect((await d.get('/api/clinical/patients/12/history')).status).toBe(403);
    const ok = await d.post('/api/clinical/visits', { patientId: 12, visitType: 'emergency', emergencyReason: 'Collapsed in the waiting area' });
    expect(ok.status).toBe(201);
    expect(await db('emergency_access_grants').where({ patient_id: 12 }).first()).toBeTruthy();
    expect(await db('audit_logs').where({ action: 'clinical.emergency_access', entity_id: '12' }).first()).toBeTruthy();
  });

  it('doctors cannot write into another doctor\'s visit', async () => {
    const v = await db('visits').where({ patient_id: 5 }).first();
    const other = await login('dr.sara');
    await other.post('/api/clinical/patients/5/emergency-access', { reason: 'Second opinion requested urgently' });
    const res = await other.post(`/api/clinical/visits/${v.id}/diagnoses`, { conditionName: 'X', severity: 'mild', notes: 'y' });
    expect(res.status).toBe(403);
  });

  it('receptionists see the administrative part of a discharge summary only', async () => {
    const r = await login('reception');
    const ward = await db('wards').where({ name: 'General Ward A (Male)' }).first();
    const bed = await db('beds').where({ ward_id: ward.id, status: 'available' }).first();
    const adm = await r.post('/api/admissions', { patientId: 13, wardId: ward.id, bedId: bed.id, attendingDoctorId: 1, reason: 'Observation' });
    const d = await login('dr.ahmed');
    const visit = await db('visits').where({ admission_id: adm.body.id }).first();
    await d.post(`/api/clinical/visits/${visit.id}/diagnoses`, { conditionName: 'Viral fever', severity: 'mild', notes: 'Settled' });
    await d.post(`/api/admissions/${adm.body.id}/approve-discharge`, { notes: 'Private clinical note' });
    const acc = await login('accountant');
    const bill = await acc.post('/api/billing/bills', { patientId: 13, acknowledgeWarnings: true });
    await acc.post(`/api/billing/bills/${bill.body.id}/payments`, { amount: bill.body.balance, method: 'cash' });
    const done = await r.post(`/api/admissions/${adm.body.id}/discharge`, { conditionAtDischarge: 'Well' });
    expect(done.status).toBe(200);
    expect(done.body.dischargeSummary.content.diagnoses).toBeUndefined();
    expect(done.body.dischargeSummary.content.conditionAtDischarge).toBe('Well');
    expect(done.body.dischargeNotes).toBeNull();
    const asDoctor = await d.get(`/api/admissions/${adm.body.id}`);
    expect(asDoctor.body.dischargeSummary.content.diagnoses[0].condition).toBe('Viral fever');
  });

  it('room charges cannot be left off a bill', async () => {
    const r = await login('reception');
    const ward = await db('wards').where({ name: 'General Ward B (Female)' }).first();
    const bed = await db('beds').where({ ward_id: ward.id, status: 'available' }).first();
    const adm = await r.post('/api/admissions', { patientId: 14, wardId: ward.id, bedId: bed.id, attendingDoctorId: 1, reason: 'Observation' });
    const acc = await login('accountant');
    const preview = await acc.get('/api/billing/patients/14/unbilled');
    const room = preview.body.items.find((i) => i.category === 'room');
    const res = await acc.post('/api/billing/bills', { patientId: 14, excludeKeys: [room.key], acknowledgeWarnings: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ROOM_NOT_EXCLUDABLE');
    expect(adm.status).toBe(201);
  });

  it('doctor contact details and usernames are hidden from non-managers', async () => {
    const p = await login(patientUser(1));
    const res = await p.get('/api/doctors/1');
    expect(res.body.fullName).toBeTruthy();
    expect(res.body.username).toBeUndefined();
    expect(res.body.email).toBeUndefined();
    expect(res.body.licenseNumber).toBeUndefined();
  });

  it('appointments within 1 hour cannot be rescheduled directly', async () => {
    const now = timeToMinutes(nowTimeStr());
    if (now + 40 >= 24 * 60) return;
    const start = minutesToTime(Math.ceil((now + 30) / 5) * 5);
    const [appt] = await db('appointments').insert({ appointment_code: 'APT-TEST-RS1', patient_id: 15, doctor_id: 6, appointment_date: todayStr(), start_time: start, end_time: minutesToTime(timeToMinutes(start) + 15), token_number: 98, booked_by: 1 }).returning('*');
    const r = await login('reception');
    const res = await r.post(`/api/appointments/${appt.id}/reschedule`, { date: nextWeekday(1), startTime: '09:00', reason: 'Late' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WITHIN_ONE_HOUR');
    expect(localDateTime(todayStr(), start) > new Date()).toBe(true);
  });

  it('concurrent reschedules of one appointment create only one new booking', async () => {
    const r = await login('reception');
    const day = nextWeekday(2);
    const a = await r.post('/api/appointments', { patientId: 16, doctorId: 1, date: day, startTime: '09:00' });
    const [x, y] = await Promise.all([
      r.post(`/api/appointments/${a.body.id}/reschedule`, { date: day, startTime: '10:00', reason: 'A' }),
      r.post(`/api/appointments/${a.body.id}/reschedule`, { date: day, startTime: '11:00', reason: 'B' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const live = await db('appointments').where({ patient_id: 16, appointment_date: day }).whereIn('status', ['scheduled']);
    expect(live).toHaveLength(1);
  });
});
