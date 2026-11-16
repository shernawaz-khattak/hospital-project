// End-to-end hospital workflow across modules:
// UC-18..UC-21 wards, UC-22..UC-29 clinical, UC-30..UC-33 lab, UC-34..UC-38 pharmacy,
// UC-39..UC-42 billing, UC-48..UC-50 portal.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, login, resetData, settle, patientUser, todayStr, addDays } from './helpers.js';
import { closeDb } from '../src/db/knex.js';

beforeAll(resetData);
afterAll(closeDb);

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const ctx = {};

describe('Ward management (UC-18..UC-20)', () => {
  it('a doctor without a care relationship cannot open the record or request admission', async () => {
    const d = await login('dr.sara');
    const res = await d.get('/api/clinical/patients/1/history');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_CARE_RELATIONSHIP');
    expect((await d.post('/api/admissions/requests', { patientId: 1, requestType: 'admission', reason: 'x' })).status).toBe(403);
  });

  it('emergency access requires a reason, is audited and grants access', async () => {
    const d = await login('dr.sara');
    expect((await d.post('/api/clinical/patients/1/emergency-access', { reason: 'short' })).status).toBe(422);
    const ok = await d.post('/api/clinical/patients/1/emergency-access', { reason: 'Brought in unconscious to ER, need history' });
    expect(ok.status).toBe(201);
    expect((await d.get('/api/clinical/patients/1/history')).status).toBe(200);
    expect(await db('audit_logs').where({ action: 'clinical.emergency_access' }).first()).toBeTruthy();
  });

  it('doctor recommends admission; receptionist admits, assigns a bed; patient becomes In-Patient', async () => {
    const d = await login('dr.sara');
    const reqRes = await d.post('/api/admissions/requests', { patientId: 1, requestType: 'admission', reason: 'Chest pain for observation', priority: 'urgent' });
    expect(reqRes.status).toBe(201);
    const r = await login('reception');
    const pending = await r.get('/api/admissions/requests');
    expect(pending.body.data[0].patient.id).toBe(1);
    const ward = await db('wards').where({ name: 'General Ward A (Male)' }).first();
    const bed = await db('beds').where({ ward_id: ward.id, status: 'available' }).orderBy('bed_number').first();
    const doc = await db('doctors').where({ doctor_code: 'DOC-002' }).first();
    const adm = await r.post('/api/admissions', { patientId: 1, wardId: ward.id, bedId: bed.id, attendingDoctorId: doc.id, reason: 'Chest pain for observation', requestId: reqRes.body.id });
    expect(adm.status).toBe(201);
    ctx.admissionId = adm.body.id;
    ctx.bedId = bed.id;
    expect((await db('beds').where({ id: bed.id }).first()).status).toBe('occupied');
    expect((await db('patients').where({ id: 1 }).first()).status).toBe('in_patient');
    expect((await db('admission_requests').where({ id: reqRes.body.id }).first()).status).toBe('fulfilled');
    const ipdVisit = await db('visits').where({ admission_id: adm.body.id }).first();
    expect(ipdVisit.visit_type).toBe('ipd'); // linked to the medical record
    ctx.visitId = ipdVisit.id;
  });

  it('cannot assign an occupied bed; concurrent admissions to one bed allow only one', async () => {
    const r = await login('reception');
    const ward = await db('wards').where({ name: 'General Ward A (Male)' }).first();
    const doc = await db('doctors').first();
    const occupied = await r.post('/api/admissions', { patientId: 3, wardId: ward.id, bedId: ctx.bedId, attendingDoctorId: doc.id, reason: 'x' });
    expect(occupied.status).toBe(409);
    const free = await db('beds').where({ ward_id: ward.id, status: 'available' }).first();
    const results = await Promise.all([3, 7, 9].map((pid) => r.post('/api/admissions', { patientId: pid, wardId: ward.id, bedId: free.id, attendingDoctorId: doc.id, reason: 'Observation' })));
    expect(results.filter((x) => x.status === 201)).toHaveLength(1);
    const bedAdmissions = await db('admissions').where({ bed_id: free.id, status: 'active' });
    expect(bedAdmissions).toHaveLength(1);
  });

  it('suggests another ward when the selected ward has no free beds (UC-18 2-A)', async () => {
    const r = await login('reception');
    const ccu = await db('wards').where({ name: 'Cardiac Care Unit' }).first();
    await db('beds').where({ ward_id: ccu.id }).update({ status: 'maintenance' });
    const anyBed = await db('beds').where({ ward_id: ccu.id }).first();
    const res = await r.post('/api/admissions', { patientId: 11, wardId: ccu.id, bedId: anyBed.id, attendingDoctorId: 2, reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('No beds are currently available in this ward.');
    expect(res.body.error.details.suggestions.length).toBeGreaterThan(0);
    await db('beds').where({ ward_id: ccu.id }).update({ status: 'available' });
  });

  it('transfers: old bed freed, new bed occupied, logged with reason (UC-20)', async () => {
    const r = await login('reception');
    const ccu = await db('wards').where({ name: 'Cardiac Care Unit' }).first();
    const newBed = await db('beds').where({ ward_id: ccu.id, status: 'available' }).first();
    ctx.previousBedId = ctx.bedId;
    const noReason = await r.post(`/api/admissions/${ctx.admissionId}/transfer`, { toWardId: ccu.id, toBedId: newBed.id });
    expect(noReason.status).toBe(422);
    const res = await r.post(`/api/admissions/${ctx.admissionId}/transfer`, { toWardId: ccu.id, toBedId: newBed.id, reason: 'Needs cardiac monitoring' });
    expect(res.status).toBe(200);
    expect(res.body.transfers[0].reason).toBe('Needs cardiac monitoring');
    expect((await db('beds').where({ id: ctx.bedId }).first()).status).toBe('available');
    expect((await db('beds').where({ id: newBed.id }).first()).status).toBe('occupied');
    ctx.bedId = newBed.id;
  });

  it('only permanently deletes unused beds; admissions and transfer history are protected', async () => {
    const admin = await login('admin');
    const occupied = await admin.delete(`/api/wards/beds/${ctx.bedId}`);
    expect(occupied.status).toBe(409);
    expect(occupied.body.error.message).toMatch(/occupied/i);

    const historical = await admin.delete(`/api/wards/beds/${ctx.previousBedId}`);
    expect(historical.status).toBe(409);
    expect(historical.body.error.message).toMatch(/history/i);

    const ccu = await db('wards').where({ name: 'Cardiac Care Unit' }).first();
    const [unusedBed] = await db('beds').insert({ ward_id: ccu.id, bed_number: 'CCU-DELETE-TEST' }).returning('*');
    const removed = await admin.delete(`/api/wards/beds/${unusedBed.id}`);
    expect(removed.status).toBe(200);
    expect(await db('beds').where({ id: unusedBed.id }).first()).toBeUndefined();
    expect(await db('audit_logs').where({ action: 'bed.delete', entity_id: String(unusedBed.id) }).first()).toBeTruthy();
  });
});

describe('Clinical care (UC-22..UC-29)', () => {
  it('requires a diagnosis in the visit before prescribing (UC-27 pre-condition)', async () => {
    const d = await login('dr.sara');
    const med = await db('medicines').where({ name: 'Norvasc' }).first();
    const res = await d.post(`/api/clinical/visits/${ctx.visitId}/prescriptions`, { items: [{ medicineId: med.id, dosage: '5 mg', frequency: 'Once daily', durationDays: 30, quantity: 30 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DIAGNOSIS_REQUIRED');
  });

  it('records a diagnosis with condition, severity and notes (UC-25)', async () => {
    const d = await login('dr.sara');
    const incomplete = await d.post(`/api/clinical/visits/${ctx.visitId}/diagnoses`, { conditionName: 'Angina' });
    expect(incomplete.status).toBe(422);
    expect(Object.keys(incomplete.body.error.fields)).toEqual(expect.arrayContaining(['severity', 'notes']));
    const ok = await d.post(`/api/clinical/visits/${ctx.visitId}/diagnoses`, { conditionName: 'Stable angina', icdCode: 'I20.8', severity: 'moderate', notes: 'Exertional chest pain, ECG non-specific' });
    expect(ok.status).toBe(201);
    expect(ok.body.doctorName).toBe('Dr. Sara Khan');
  });

  it('diagnosis logs are read-only at database level (UC-24)', async () => {
    await expect(db('diagnoses').update({ notes: 'tampered' })).rejects.toThrow(/read-only/);
    await expect(db('diagnoses').del()).rejects.toThrow(/read-only/);
  });

  it('validates vital signs per field (UC-26 2-A)', async () => {
    const d = await login('dr.sara');
    const bad = await d.post(`/api/clinical/visits/${ctx.visitId}/observations`, { temperatureC: 52, pulseBpm: 80, systolicBp: 70, diastolicBp: 90 });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields.temperatureC).toMatch(/between 30 and 45/);
    expect(bad.body.error.fields.diastolicBp).toBeTruthy();
    const ok = await d.post(`/api/clinical/visits/${ctx.visitId}/observations`, { temperatureC: 37.2, pulseBpm: 92, systolicBp: 145, diastolicBp: 92, spo2: 97, symptoms: 'Chest tightness on exertion' });
    expect(ok.status).toBe(201);
    expect(ok.body.recordedAt).toBeTruthy();
    expect(ok.body.doctorName).toBe('Dr. Sara Khan');
  });

  it('warns about allergies and out-of-stock medicines and suggests alternatives (UC-27 2-A)', async () => {
    const d = await login('dr.sara');
    const risek = await db('medicines').where({ name: 'Risek' }).first(); // zero stock in seed
    const res = await d.post(`/api/clinical/visits/${ctx.visitId}/prescriptions`, { items: [{ medicineId: risek.id, dosage: '40 mg', frequency: 'Once daily', durationDays: 14, quantity: 14 }] });
    expect(res.status).toBe(409);
    const w = res.body.error.details.warnings[0];
    expect(w.type).toBe('stock');
    expect(w.alternatives[0].genericName).toBe('Omeprazole'); // same generic first
  });

  it('creates a prescription and sends it to the pharmacy', async () => {
    const d = await login('dr.sara');
    const norvasc = await db('medicines').where({ name: 'Norvasc' }).first();
    const disprin = await db('medicines').where({ name: 'Disprin CV' }).first(); // patient 1 is allergic to penicillin only
    const res = await d.post(`/api/clinical/visits/${ctx.visitId}/prescriptions`, {
      items: [
        { medicineId: norvasc.id, dosage: '5 mg', frequency: 'Once daily', durationDays: 30, quantity: 30 },
        { medicineId: disprin.id, dosage: '75 mg', frequency: 'Once daily after lunch', durationDays: 30, quantity: 30, instructions: 'Take with food' },
      ],
    });
    expect(res.status).toBe(201);
    ctx.rxId = res.body.id;
    await settle();
    const pharm = await db('users').where({ username: 'pharmacist' }).first();
    expect(await db('notifications').where({ user_id: pharm.id, event_type: 'prescription.received' }).first()).toBeTruthy();
  });

  it('allergy warning for a penicillin-allergic patient', async () => {
    const d = await login('dr.sara');
    const aug = await db('medicines').where({ name: 'Augmentin' }).first();
    // Patient 1's allergy record says "Penicillin"; Augmentin's generic is amoxicillin (a penicillin) — name match is on "Penicillin" text only,
    // so use Amoxil whose name differs; the check matches the allergy text against medicine names/generics.
    await db('patients').where({ id: 1 }).update({ allergies_enc: (await import('../src/lib/crypto.js')).encrypt('Penicillin, Amoxicillin') });
    const res = await d.post(`/api/clinical/visits/${ctx.visitId}/prescriptions`, { items: [{ medicineId: aug.id, dosage: '625 mg', frequency: 'Twice daily', durationDays: 5, quantity: 10 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.details.warnings.some((w) => w.type === 'allergy')).toBe(true);
  });

  it('requests a lab test with urgency, notes and validated parameters (UC-28, UC-29)', async () => {
    const d = await login('dr.sara');
    const dengue = await db('lab_tests').where({ code: 'DENGUE' }).first(); // unavailable in seed
    const unavailable = await d.post('/api/clinical/lab-requests', { patientId: 1, visitId: ctx.visitId, labTestId: dengue.id, urgency: 'urgent', clinicalNotes: 'Fever' });
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.error.code).toBe('TEST_UNAVAILABLE');
    const lipid = await db('lab_tests').where({ code: 'LIPID' }).first();
    const badParam = await d.post('/api/clinical/lab-requests', { patientId: 1, visitId: ctx.visitId, labTestId: lipid.id, urgency: 'routine', clinicalNotes: 'Risk assessment', parameters: ['Hemoglobin'] });
    expect(badParam.status).toBe(422);
    const ok = await d.post('/api/clinical/lab-requests', { patientId: 1, visitId: ctx.visitId, labTestId: lipid.id, urgency: 'urgent', clinicalNotes: 'Cardiac risk assessment', parameters: ['LDL', 'HDL'], specialInstructions: 'Fasting sample' });
    expect(ok.status).toBe(201);
    ctx.labId = ok.body.id;
    const upd = await d.patch(`/api/clinical/lab-requests/${ctx.labId}/parameters`, { parameters: ['LDL', 'HDL', 'Triglycerides'] });
    expect(upd.body.parameters).toEqual(['LDL', 'HDL', 'Triglycerides']);
  });

  it('shows the complete history, most recent first (UC-22, UC-23)', async () => {
    const d = await login('dr.sara');
    const h = await d.get('/api/clinical/patients/1/history');
    expect(h.body.visits[0].diagnoses[0].conditionName).toBe('Stable angina');
    expect(h.body.visits[0].prescriptions[0].items).toHaveLength(2);
    expect(h.body.patient.allergies).toMatch(/Penicillin/);
    const v = await d.get(`/api/clinical/visits/${ctx.visitId}`);
    expect(v.body.labRequests[0].testName).toBe('Lipid Profile');
  });
});

describe('Laboratory (UC-30..UC-33)', () => {
  it('lists pending requests by urgency and processes them with timing recorded', async () => {
    const lab = await login('labtech');
    const list = await lab.get('/api/lab/requests?status=pending');
    expect(list.body.data[0].id).toBe(ctx.labId);
    expect((await lab.post(`/api/lab/requests/${ctx.labId}/complete`)).status).toBe(409); // must start first
    expect((await lab.post(`/api/lab/requests/${ctx.labId}/start`)).body.status).toBe('in_progress');
    expect((await lab.post(`/api/lab/requests/${ctx.labId}/complete`)).body.processingMinutes).toBeGreaterThanOrEqual(0);
  });

  it('notifies the doctor when materials are unavailable (UC-30 2-A)', async () => {
    const d = await login('dr.sara');
    const cbc = await db('lab_tests').where({ code: 'CBC' }).first();
    const r2 = await d.post('/api/clinical/lab-requests', { patientId: 1, labTestId: cbc.id, urgency: 'routine', clinicalNotes: 'Baseline' });
    const lab = await login('labtech');
    const res = await lab.post(`/api/lab/requests/${r2.body.id}/delay`, { reason: 'EDTA tubes out of stock until tomorrow' });
    expect(res.body.status).toBe('delayed');
    await settle();
    const doctorUser = await db('users').where({ username: 'dr.sara' }).first();
    expect(await db('notifications').where({ user_id: doctorUser.id, event_type: 'lab.delayed' }).first()).toBeTruthy();
    ctx.delayedLabId = r2.body.id;
  });

  it('rejects unsupported file formats, even when renamed (UC-31 2-A)', async () => {
    const lab = await login('labtech');
    const res = await lab.raw.post(`/api/lab/requests/${ctx.labId}/report`).set('X-Requested-With', 'hms').attach('file', Buffer.from('MZ fake executable content here'), { filename: 'report.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_FILE');
  });

  it('uploads a PDF report, links it to the patient and notifies doctor and patient (UC-31, UC-33)', async () => {
    const lab = await login('labtech');
    const res = await lab.raw.post(`/api/lab/requests/${ctx.labId}/report`).set('X-Requested-With', 'hms')
      .field('resultValues', JSON.stringify([{ name: 'LDL', value: '162', unit: 'mg/dL', referenceRange: '<100', flag: 'high' }]))
      .field('remarks', 'Raised LDL')
      .attach('file', PDF, { filename: 'lipid.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('reported');
    ctx.reportId = res.body.report.id;
    await settle();
    const doctorUser = await db('users').where({ username: 'dr.sara' }).first();
    const docNote = await db('notifications').where({ user_id: doctorUser.id, event_type: 'lab.report_ready' }).first();
    const patNote = await db('notifications').where({ patient_id: 1, event_type: 'lab.report_ready' }).first();
    expect(docNote).toBeTruthy();
    expect(patNote).toBeTruthy();
    // Delivered well within 1 minute of the upload.
    const report = await db('lab_reports').where({ id: ctx.reportId }).first();
    expect(new Date(patNote.created_at) - new Date(report.uploaded_at)).toBeLessThan(60_000);
  });

  it('report access: lab, treating doctor and the patient only (UC-32, UC-49)', async () => {
    const own = await login(patientUser(1));
    const file = await own.get(`/api/lab/reports/${ctx.reportId}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    const other = await login(patientUser(2));
    expect((await other.get(`/api/lab/reports/${ctx.reportId}/file`)).status).toBe(403);
    const unrelatedDoctor = await login('dr.bilal');
    expect((await unrelatedDoctor.get(`/api/lab/reports/${ctx.reportId}/file`)).status).toBe(403);
    const portal = await own.get('/api/portal/lab-reports');
    expect(portal.body.data.find((r) => r.id === ctx.labId).available).toBe(true);
    expect(portal.body.data.find((r) => r.id === ctx.delayedLabId).status).toBe('not_yet_available');
  });
});

describe('Pharmacy (UC-34..UC-38)', () => {
  it('cannot dispense before verification; verification is recorded', async () => {
    const ph = await login('pharmacist');
    const detail = await ph.get(`/api/pharmacy/prescriptions/${ctx.rxId}`);
    expect(detail.body.patient.allergies).toMatch(/Penicillin/);
    const early = await ph.post(`/api/pharmacy/prescriptions/${ctx.rxId}/dispense`, { items: detail.body.items.map((i) => ({ prescriptionItemId: i.id, quantity: i.quantity })) });
    expect(early.status).toBe(409);
    expect((await ph.post(`/api/pharmacy/prescriptions/${ctx.rxId}/verify`)).body.status).toBe('verified');
  });

  it('dispenses, updates inventory automatically and records the transaction (UC-35)', async () => {
    const ph = await login('pharmacist');
    const detail = (await ph.get(`/api/pharmacy/prescriptions/${ctx.rxId}`)).body;
    const norvasc = detail.items.find((i) => i.name === 'Norvasc');
    const before = norvasc.stock;
    const over = await ph.post(`/api/pharmacy/prescriptions/${ctx.rxId}/dispense`, { items: [{ prescriptionItemId: norvasc.id, quantity: 31 }] });
    expect(over.status).toBe(422);
    const res = await ph.post(`/api/pharmacy/prescriptions/${ctx.rxId}/dispense`, { items: detail.items.map((i) => ({ prescriptionItemId: i.id, quantity: i.quantity })) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('dispensed');
    const after = res.body.prescription.items.find((i) => i.name === 'Norvasc').stock;
    expect(after).toBe(before - 30);
    const txn = await db('inventory_transactions').where({ txn_type: 'dispense', reference_id: ctx.rxId }).first();
    expect(txn.quantity_change).toBeLessThan(0);
    const again = await ph.post(`/api/pharmacy/prescriptions/${ctx.rxId}/dispense`, { items: [{ prescriptionItemId: norvasc.id, quantity: 1 }] });
    expect(again.status).toBe(409);
  });

  it('never sells expired stock and reports shortages (UC-35 2-A)', async () => {
    const d = await login('dr.sara');
    const ond = await db('medicines').where({ name: 'Ondansetron' }).first(); // 150 units, all expired in seed
    const rx = await d.post(`/api/clinical/visits/${ctx.visitId}/prescriptions`, { items: [{ medicineId: ond.id, dosage: '4 mg', frequency: 'Every 8 hours', durationDays: 2, quantity: 6 }], acknowledgeWarnings: true });
    expect(rx.status).toBe(201);
    const ph = await login('pharmacist');
    await ph.post(`/api/pharmacy/prescriptions/${rx.body.id}/verify`);
    const item = (await ph.get(`/api/pharmacy/prescriptions/${rx.body.id}`)).body.items[0];
    expect(item.stock).toBe(0);
    const res = await ph.post(`/api/pharmacy/prescriptions/${rx.body.id}/dispense`, { items: [{ prescriptionItemId: item.id, quantity: 6 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OUT_OF_STOCK');
  });

  it('flags a prescription and notifies the doctor (UC-34 2-A)', async () => {
    const d = await login('dr.sara');
    const brufen = await db('medicines').where({ name: 'Brufen' }).first();
    const rx = await d.post(`/api/clinical/visits/${ctx.visitId}/prescriptions`, { items: [{ medicineId: brufen.id, dosage: '?', frequency: 'unclear', durationDays: 3, quantity: 9 }] });
    const ph = await login('pharmacist');
    expect((await ph.post(`/api/pharmacy/prescriptions/${rx.body.id}/flag`, { reason: 'Dosage unclear' })).body.status).toBe('flagged');
    await settle();
    const flagged = await d.get('/api/clinical/prescriptions/flagged');
    expect(flagged.body.data[0].flagReason).toBe('Dosage unclear');
    const revised = await d.put(`/api/clinical/prescriptions/${rx.body.id}`, { items: [{ medicineId: brufen.id, dosage: '400 mg', frequency: 'Three times daily', durationDays: 3, quantity: 9 }] });
    expect(revised.status).toBe(200);
    expect((await db('prescriptions').where({ id: rx.body.id }).first()).status).toBe('pending');
    await d.post(`/api/clinical/prescriptions/${rx.body.id}/cancel`, { reason: 'Not needed after review' });
  });

  it('raises a restock alert when stock reaches the threshold (UC-37)', async () => {
    const ph = await login('pharmacist');
    const lipitor = await db('medicines').where({ name: 'Lipitor' }).first(); // 90 in stock, reorder 100 -> already low
    const bad = await ph.put(`/api/pharmacy/medicines/${lipitor.id}/reorder-level`, { reorderLevel: -5 });
    expect(bad.status).toBe(422);
    expect((await ph.put(`/api/pharmacy/medicines/${lipitor.id}/reorder-level`, { reorderLevel: 95 })).status).toBe(200);
    const alerts = await ph.get('/api/pharmacy/alerts');
    expect(alerts.body.data.some((a) => a.medicineId === lipitor.id && a.type === 'low_stock')).toBe(true);
    const batch = await db('medicine_batches').where({ medicine_id: lipitor.id }).first();
    const neg = await ph.post(`/api/pharmacy/batches/${batch.id}/adjust`, { quantityChange: -1000, reason: 'Count' });
    expect(neg.status).toBe(422); // UC-36 2-A: negative stock rejected
    await ph.post(`/api/pharmacy/medicines/${lipitor.id}/batches`, { batchNumber: 'LIP-NEW', quantity: 200, expiryDate: addDays(todayStr(), 400) });
    const after = await ph.get('/api/pharmacy/alerts');
    expect(after.body.data.some((a) => a.medicineId === lipitor.id && a.type === 'low_stock')).toBe(false); // resolved by restock
  });

  it('tracks expiry: <=30 days expiring, past date expired; removal is logged (UC-38)', async () => {
    const ph = await login('pharmacist');
    const res = await ph.get('/api/pharmacy/expiry');
    const states = new Set(res.body.data.map((b) => b.state));
    expect(states.has('expired')).toBe(true);
    expect(states.has('expiring')).toBe(true);
    const expired = res.body.data.find((b) => b.state === 'expired');
    expect((await ph.post(`/api/pharmacy/batches/${expired.batchId}/remove-expired`, { reason: 'Disposal' })).status).toBe(200);
    const notExpired = res.body.data.find((b) => b.state === 'expiring');
    expect((await ph.post(`/api/pharmacy/batches/${notExpired.batchId}/remove-expired`, {})).status).toBe(409);
    expect(await db('inventory_transactions').where({ txn_type: 'expired_removal', batch_id: expired.batchId }).first()).toBeTruthy();
    expect((await ph.post('/api/pharmacy/expiry/scan')).status).toBe(200);
  });
});

describe('Billing and discharge (UC-21, UC-39..UC-42, UC-50)', () => {
  it('blocks discharge before the doctor approves and while bills are pending (UC-21 2-A)', async () => {
    const r = await login('reception');
    const notApproved = await r.post(`/api/admissions/${ctx.admissionId}/discharge`, { conditionAtDischarge: 'Stable' });
    expect(notApproved.body.error.code).toBe('NOT_APPROVED');
    const d = await login('dr.sara');
    expect((await d.post(`/api/admissions/${ctx.admissionId}/approve-discharge`, { notes: 'Pain settled; continue medication' })).status).toBe(200);
    const blocked = await r.post(`/api/admissions/${ctx.admissionId}/discharge`, { conditionAtDischarge: 'Stable' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PENDING_BILLS');
  });

  it('generates an itemized bill with separate lab, medicine and room charges (UC-39)', async () => {
    const acc = await login('accountant');
    const preview = await acc.get('/api/billing/patients/1/unbilled');
    const cats = preview.body.byCategory.map((c) => c.category);
    expect(cats).toEqual(expect.arrayContaining(['lab', 'medicine', 'room']));
    expect(preview.body.warnings.length).toBeGreaterThan(0); // pending lab / undispensed Rx
    const needsAck = await acc.post('/api/billing/bills', { patientId: 1 });
    expect(needsAck.body.error.code).toBe('BILLING_WARNINGS');
    const bill = await acc.post('/api/billing/bills', { patientId: 1, acknowledgeWarnings: true, otherCharges: [{ description: 'Nursing care kit', quantity: 1, unitPrice: 500 }] });
    expect(bill.status).toBe(201);
    expect(bill.body.subtotal).toBe(preview.body.subtotal + 500);
    ctx.billId = bill.body.id;
    const again = await acc.post('/api/billing/bills', { patientId: 1, acknowledgeWarnings: true });
    expect(again.status).toBe(409); // services cannot be billed twice
  });

  it('rejects expired insurance and applies valid insurance (UC-40)', async () => {
    const acc = await login('accountant');
    const policy = await db('patient_insurance').where({ patient_id: 1 }).first();
    await db('patient_insurance').where({ id: policy.id }).update({ valid_until: addDays(todayStr(), -1) });
    const expired = await acc.post(`/api/billing/bills/${ctx.billId}/insurance`, { patientInsuranceId: policy.id });
    expect(expired.status).toBe(422);
    expect(expired.body.error.message).toMatch(/full amount remains payable/);
    await db('patient_insurance').where({ id: policy.id }).update({ valid_until: addDays(todayStr(), 100) });
    const ok = await acc.post(`/api/billing/bills/${ctx.billId}/insurance`, { patientInsuranceId: policy.id });
    expect(ok.status).toBe(200);
    expect(ok.body.insuranceAmount).toBeCloseTo(ok.body.subtotal * 0.8, 1);
    expect(ok.body.totalPayable).toBeCloseTo(ok.body.subtotal - ok.body.insuranceAmount, 2);
  });

  it('records partial payments, rejects overpayment and issues receipts (UC-41, UC-42)', async () => {
    const acc = await login('accountant');
    const bill = (await acc.get(`/api/billing/bills/${ctx.billId}`)).body;
    const over = await acc.post(`/api/billing/bills/${ctx.billId}/payments`, { amount: bill.balance + 1, method: 'cash' });
    expect(over.status).toBe(422);
    expect(over.body.error.message).toMatch(/exceeds the due amount/);
    expect((await acc.post(`/api/billing/bills/${ctx.billId}/payments`, { amount: 0, method: 'cash' })).status).toBe(422);
    expect((await acc.post(`/api/billing/bills/${ctx.billId}/payments`, { amount: 10, method: 'card' })).status).toBe(422); // reference required
    const half = Math.round(bill.balance * 50) / 100;
    const p1 = await acc.post(`/api/billing/bills/${ctx.billId}/payments`, { amount: half, method: 'cash' });
    expect(p1.body.bill.status).toBe('partially_paid');
    const r1 = await acc.post(`/api/billing/payments/${p1.body.paymentId}/receipt`);
    expect(r1.status).toBe(201);
    expect(r1.body.remainingBalance).toBeCloseTo(bill.balance - half, 2);
    const rest = p1.body.bill.balance;
    const p2 = await acc.post(`/api/billing/bills/${ctx.billId}/payments`, { amount: rest, method: 'bank_transfer', referenceNo: 'TRX-778899' });
    expect(p2.body.bill.status).toBe('paid');
    const r2 = await acc.post(`/api/billing/payments/${p2.body.paymentId}/receipt`);
    expect(r2.body.remainingBalance).toBe(0);
    expect((await acc.post('/api/billing/payments/999999/receipt')).status).toBe(404);
  });

  it('patients can view their own bills only and cannot modify them (UC-50)', async () => {
    const own = await login(patientUser(1));
    expect((await own.get(`/api/portal/bills/${ctx.billId}`)).status).toBe(200);
    expect((await own.post(`/api/billing/bills/${ctx.billId}/payments`, { amount: 1, method: 'cash' })).status).toBe(403);
    const other = await login(patientUser(2));
    expect((await other.get(`/api/portal/bills/${ctx.billId}`)).status).toBe(403);
    expect((await other.get(`/api/billing/bills/${ctx.billId}`)).status).toBe(403);
  });

  it('discharges after bills are cleared: summary generated, bed freed, status Discharged (UC-21)', async () => {
    const r = await login('reception');
    const check = await r.get(`/api/admissions/${ctx.admissionId}/discharge-check`);
    // Pending lab (delayed CBC) and the cancelled/undispensed Rx are not billable yet; only billed services count.
    expect(check.body.outstandingAmount).toBe(0);
    if (check.body.unbilledServices > 0) {
      const acc = await login('accountant');
      const b = await acc.post('/api/billing/bills', { patientId: 1, acknowledgeWarnings: true });
      await acc.post(`/api/billing/bills/${b.body.id}/payments`, { amount: b.body.balance, method: 'cash' });
    }
    const res = await r.post(`/api/admissions/${ctx.admissionId}/discharge`, { conditionAtDischarge: 'Stable, pain free', followUpInstructions: 'Cardiology clinic in 2 weeks' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('discharged');
    expect(res.body.dischargeSummary.content.diagnoses).toBeUndefined(); // receptionist: administrative part only
    const doc = await (await login('dr.sara')).get(`/api/admissions/${ctx.admissionId}`);
    expect(doc.body.dischargeSummary.content.diagnoses[0].condition).toBe('Stable angina');
    expect((await db('beds').where({ id: ctx.bedId }).first()).status).toBe('available');
    expect((await db('patients').where({ id: 1 }).first()).status).toBe('discharged');
    const portal = await (await login(patientUser(1))).get('/api/portal/medical');
    expect(portal.body.dischargeSummaries).toHaveLength(1);
  });

  it('produces financial reports as JSON and PDF; empty periods say so (UC-43, UC-44)', async () => {
    const acc = await login('accountant');
    const summary = await acc.get('/api/reports/financial/summary');
    expect(summary.body.totalRevenue).toBeGreaterThan(0);
    const json = await acc.get(`/api/reports/financial?period=daily&from=${addDays(todayStr(), -7)}&to=${todayStr()}`);
    expect(json.body.hasData).toBe(true);
    expect(json.body.totals.collected).toBeCloseTo(summary.body.totalRevenue, 2);
    const pdf = await acc.raw.get(`/api/reports/financial.pdf?period=monthly&from=${addDays(todayStr(), -30)}&to=${todayStr()}`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    const empty = await acc.get('/api/reports/financial?period=daily&from=2020-01-01&to=2020-01-31');
    expect(empty.body.hasData).toBe(false);
    expect(empty.body.message).toMatch(/No financial data/);
    const admin = await login('admin');
    expect((await admin.get('/api/reports/financial/summary')).status).toBe(200);
  });
});
