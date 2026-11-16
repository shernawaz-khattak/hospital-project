// Clinical care (SRS FR-17..FR-20; UC-22 History, UC-23 Medical Record, UC-24 Diagnosis Logs,
// UC-25 Diagnose, UC-26 Observations, UC-27 Prescribe, UC-28 Lab Request, UC-29 Parameters).
import { db } from '../../db/knex.js';
import { transaction } from '../../db/tx.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { nextCode } from '../../lib/codes.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { ageFrom, todayStr } from '../../lib/dates.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notifications.js';
import { publishToPermission } from '../../services/realtime.js';
import { assertCareAccess, hasCareRelationship } from './access.js';
import { assertVisitMatchesPatientAndDoctor, validatePrescriptionItems } from './journeyIntegrity.js';
import { alternativesFor, stockMap } from '../pharmacy/stock.js';

// ----------------------------------------------------------------- emergency access
export async function grantEmergencyAccess(req, patientId, reason) {
  const patient = await db('patients').where({ id: patientId }).first();
  if (!patient) throw notFound('Patient not found.');
  const [g] = await db('emergency_access_grants').insert({ doctor_id: req.user.doctorId, patient_id: patientId, reason, expires_at: new Date(Date.now() + 24 * 3600_000) }).returning('*');
  await audit(req, { action: 'clinical.emergency_access', entityType: 'patient', entityId: patientId, details: { reason, expiresAt: g.expires_at } });
  await notify(db, { permission: 'audit.view', eventType: 'clinical.emergency_access', title: 'Emergency record access', message: `${req.user.fullName} used emergency access for patient ${patient.patient_code}. Reason: ${reason}`, link: '/system/audit', entityType: 'patient', entityId: patientId });
  return { expiresAt: g.expires_at };
}

// ----------------------------------------------------------------- doctor's patient list
export async function myPatients(req, { q }) {
  const d = req.user.doctorId;
  const query = db('patients as p')
    .whereExists(function care() {
      this.select(1).from('appointments as a').whereRaw('a.patient_id = p.id').where('a.doctor_id', d).whereNot('a.status', 'cancelled')
        .unionAll((u) => u.select(1).from('visits as v').whereRaw('v.patient_id = p.id').where('v.doctor_id', d))
        .unionAll((u) => u.select(1).from('admissions as ad').whereRaw('ad.patient_id = p.id').where('ad.attending_doctor_id', d))
        .unionAll((u) => u.select(1).from('emergency_access_grants as g').whereRaw('g.patient_id = p.id').where('g.doctor_id', d).where('g.expires_at', '>', db.fn.now()));
    })
    .select('p.*',
      db.raw('(SELECT max(started_at) FROM visits v WHERE v.patient_id = p.id AND v.doctor_id = ?) AS last_visit', [d]),
      db.raw("(SELECT min(appointment_date) FROM appointments a WHERE a.patient_id = p.id AND a.doctor_id = ? AND a.status = 'scheduled' AND a.appointment_date >= ?) AS next_appointment", [d, todayStr()]),
      db.raw("EXISTS (SELECT 1 FROM admissions ad WHERE ad.patient_id = p.id AND ad.status = 'active' AND ad.attending_doctor_id = ?) AS admitted_under_me", [d]))
    .orderByRaw('last_visit DESC NULLS LAST')
    .limit(200);
  if (q) query.where((w) => w.whereILike('p.patient_code', `%${q}%`).orWhereRaw("lower(p.first_name || ' ' || p.last_name) like lower(?)", [`%${q}%`]));
  return (await query).map((p) => ({ id: p.id, patientCode: p.patient_code, fullName: `${p.first_name} ${p.last_name}`, age: ageFrom(p.date_of_birth), gender: p.gender, status: p.status, lastVisit: p.last_visit, nextAppointment: p.next_appointment, admittedUnderMe: p.admitted_under_me }));
}

// ----------------------------------------------------------------- history (read-only)
async function visitBundle(visitIds) {
  if (!visitIds.length) return { diagnoses: [], observations: [], prescriptions: [], items: [], labs: [] };
  const [diagnoses, observations, prescriptions, labs] = await Promise.all([
    db('diagnoses as dg').join('doctors as d', 'd.id', 'dg.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id').whereIn('dg.visit_id', visitIds).orderBy('dg.diagnosed_at', 'desc').select('dg.*', 'u.full_name as doctor_name'),
    db('clinical_observations as o').join('doctors as d', 'd.id', 'o.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id').whereIn('o.visit_id', visitIds).orderBy('o.recorded_at', 'desc').select('o.*', 'u.full_name as doctor_name'),
    db('prescriptions as p').join('doctors as d', 'd.id', 'p.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id').whereIn('p.visit_id', visitIds).orderBy('p.created_at', 'desc').select('p.*', 'u.full_name as doctor_name'),
    db('lab_requests as l').join('lab_tests as t', 't.id', 'l.lab_test_id').leftJoin('lab_reports as r', 'r.lab_request_id', 'l.id').whereIn('l.visit_id', visitIds).orderBy('l.created_at', 'desc')
      .select('l.*', 't.name as test_name', 't.code as test_code', 'r.id as report_id', 'r.uploaded_at', 'r.result_values', 'r.remarks', 'r.mime_type'),
  ]);
  const items = prescriptions.length
    ? await db('prescription_items as i').join('medicines as m', 'm.id', 'i.medicine_id').whereIn('i.prescription_id', prescriptions.map((p) => p.id)).select('i.*', 'm.name', 'm.strength', 'm.form')
    : [];
  return { diagnoses, observations, prescriptions, items, labs };
}

const diagDto = (d) => ({ id: d.id, visitId: d.visit_id, conditionName: d.condition_name, icdCode: d.icd_code, severity: d.severity, notes: d.notes, diagnosedAt: d.diagnosed_at, doctorName: d.doctor_name });
const obsDto = (o) => ({
  id: o.id, visitId: o.visit_id, recordedAt: o.recorded_at, doctorName: o.doctor_name, temperatureC: o.temperature_c, pulseBpm: o.pulse_bpm, systolicBp: o.systolic_bp, diastolicBp: o.diastolic_bp,
  respiratoryRate: o.respiratory_rate, spo2: o.spo2, weightKg: o.weight_kg, heightCm: o.height_cm, bloodGlucose: o.blood_glucose, symptoms: o.symptoms, notes: o.notes,
});
const labDto = (l) => ({
  id: l.id, requestCode: l.request_code, testName: l.test_name, testCode: l.test_code, urgency: l.urgency, status: l.status, clinicalNotes: l.clinical_notes, parameters: l.parameters,
  specialInstructions: l.special_instructions, createdAt: l.created_at, completedAt: l.completed_at, delayReason: l.delay_reason,
  report: l.report_id ? { id: l.report_id, uploadedAt: l.uploaded_at, resultValues: l.result_values, remarks: l.remarks, mimeType: l.mime_type } : null,
});
const rxDto = (p, items) => ({
  id: p.id, prescriptionCode: p.prescription_code, visitId: p.visit_id, status: p.status, notes: p.notes, createdAt: p.created_at, doctorName: p.doctor_name, flagReason: p.flag_reason,
  items: items.filter((i) => i.prescription_id === p.id).map((i) => ({ id: i.id, medicineId: i.medicine_id, name: i.name, strength: i.strength, form: i.form, dosage: i.dosage, frequency: i.frequency, durationDays: i.duration_days, quantity: i.quantity, instructions: i.instructions })),
});

/** UC-22: complete history, most recent first, read-only. */
export async function patientHistory(req, patientId) {
  await assertCareAccess(req, patientId);
  const p = await db('patients').where({ id: patientId }).first();
  if (!p) throw notFound('Patient not found.');
  const visits = await db('visits as v').join('doctors as d', 'd.id', 'v.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id')
    .where('v.patient_id', patientId).orderBy('v.started_at', 'desc').select('v.*', 'u.full_name as doctor_name', 'd.specialization');
  const bundle = await visitBundle(visits.map((v) => v.id));
  const otherLabs = await db('lab_requests as l').join('lab_tests as t', 't.id', 'l.lab_test_id').leftJoin('lab_reports as r', 'r.lab_request_id', 'l.id')
    .where('l.patient_id', patientId).whereNull('l.visit_id').select('l.*', 't.name as test_name', 't.code as test_code', 'r.id as report_id', 'r.uploaded_at', 'r.result_values', 'r.remarks', 'r.mime_type');
  const admissions = await db('admissions as a').join('wards as w', 'w.id', 'a.ward_id').join('beds as b', 'b.id', 'a.bed_id').leftJoin('discharge_summaries as ds', 'ds.admission_id', 'a.id')
    .where('a.patient_id', patientId).orderBy('a.admitted_at', 'desc').select('a.id', 'a.admission_code', 'a.status', 'a.admitted_at', 'a.discharged_at', 'a.reason', 'a.discharge_approved_at', 'w.name as ward_name', 'b.bed_number', 'ds.id as summary_id');
  await audit(req, { action: 'clinical.history_view', entityType: 'patient', entityId: patientId });
  return {
    patient: {
      id: p.id, patientCode: p.patient_code, fullName: `${p.first_name} ${p.last_name}`, age: ageFrom(p.date_of_birth), dateOfBirth: p.date_of_birth, gender: p.gender, bloodGroup: p.blood_group, status: p.status, phone: p.phone,
      allergies: decrypt(p.allergies_enc), medicalHistory: decrypt(p.medical_history_enc), currentMedications: decrypt(p.current_medications_enc),
    },
    visits: visits.map((v) => ({
      id: v.id, visitCode: v.visit_code, visitType: v.visit_type, status: v.status, startedAt: v.started_at, closedAt: v.closed_at, chiefComplaint: v.chief_complaint, notes: decrypt(v.notes_enc),
      doctorName: v.doctor_name, specialization: v.specialization, appointmentId: v.appointment_id, admissionId: v.admission_id, isMine: v.doctor_id === req.user.doctorId,
      diagnoses: bundle.diagnoses.filter((d) => d.visit_id === v.id).map(diagDto),
      observations: bundle.observations.filter((o) => o.visit_id === v.id).map(obsDto),
      prescriptions: bundle.prescriptions.filter((x) => x.visit_id === v.id).map((x) => rxDto(x, bundle.items)),
      labRequests: bundle.labs.filter((l) => l.visit_id === v.id).map(labDto),
    })),
    otherLabRequests: otherLabs.map(labDto),
    admissions: admissions.map((a) => ({ id: a.id, admissionCode: a.admission_code, status: a.status, admittedAt: a.admitted_at, dischargedAt: a.discharged_at, reason: a.reason, wardName: a.ward_name, bedNumber: a.bed_number, dischargeApproved: Boolean(a.discharge_approved_at), hasSummary: Boolean(a.summary_id) })),
    hasHistory: visits.length > 0 || otherLabs.length > 0,
  };
}

/** UC-23: one visit's full record. */
export async function getVisit(req, visitId) {
  const v = await db('visits as v').join('doctors as d', 'd.id', 'v.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id').join('patients as p', 'p.id', 'v.patient_id')
    .where('v.id', visitId).first('v.*', 'u.full_name as doctor_name', 'd.specialization', 'p.patient_code', 'p.first_name', 'p.last_name', 'p.date_of_birth', 'p.gender', 'p.allergies_enc');
  if (!v) throw notFound('Record not found.');
  await assertCareAccess(req, v.patient_id);
  const bundle = await visitBundle([v.id]);
  await audit(req, { action: 'clinical.record_view', entityType: 'visit', entityId: v.id });
  return {
    id: v.id, visitCode: v.visit_code, visitType: v.visit_type, status: v.status, startedAt: v.started_at, closedAt: v.closed_at, chiefComplaint: v.chief_complaint, notes: decrypt(v.notes_enc),
    doctorName: v.doctor_name, specialization: v.specialization, appointmentId: v.appointment_id, admissionId: v.admission_id, isMine: v.doctor_id === req.user.doctorId,
    patient: { id: v.patient_id, patientCode: v.patient_code, fullName: `${v.first_name} ${v.last_name}`, age: ageFrom(v.date_of_birth), gender: v.gender, allergies: decrypt(v.allergies_enc) },
    diagnoses: bundle.diagnoses.map(diagDto), observations: bundle.observations.map(obsDto), prescriptions: bundle.prescriptions.map((x) => rxDto(x, bundle.items)), labRequests: bundle.labs.map(labDto),
  };
}

/** UC-24: all diagnoses (read-only, cannot be deleted — enforced by a DB trigger). */
export async function diagnosisLog(req, patientId) {
  await assertCareAccess(req, patientId);
  const rows = await db('diagnoses as dg').join('doctors as d', 'd.id', 'dg.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id').join('visits as v', 'v.id', 'dg.visit_id')
    .where('dg.patient_id', patientId).orderBy('dg.diagnosed_at', 'desc').select('dg.*', 'u.full_name as doctor_name', 'v.visit_code');
  return rows.map((r) => ({ ...diagDto(r), visitCode: r.visit_code }));
}

// ----------------------------------------------------------------- visits
export async function startVisit(req, { patientId, appointmentId, visitType, chiefComplaint, emergencyReason }) {
  if (!req.user.doctorId) throw forbidden('Only doctors can start a consultation.');
  if (!(await hasCareRelationship(req.user.doctorId, patientId))) {
    // A doctor with no care relationship may only start an emergency visit, and only through
    // the audited emergency-access procedure (reason, 24 h grant, administrators notified).
    if (visitType !== 'emergency' || appointmentId || !emergencyReason || emergencyReason.trim().length < 10) {
      throw forbidden('This patient is not under your care. Use emergency access (with a reason) if you must treat this patient.', { code: 'NO_CARE_RELATIONSHIP' });
    }
    await grantEmergencyAccess(req, patientId, emergencyReason.trim());
  }
  return transaction(async (trx) => {
    const patient = await trx('patients').where({ id: patientId }).first();
    if (!patient) throw new AppError(422, 'Invalid patient ID.', { fields: { patientId: 'Patient not found.' } });
    let admissionId = null;
    if (appointmentId) {
      const appt = await trx('appointments').where({ id: appointmentId }).forUpdate().first();
      if (!appt || appt.patient_id !== patientId) throw badRequest('Appointment does not belong to this patient.');
      if (appt.doctor_id !== req.user.doctorId) throw forbidden('This appointment is with another doctor.');
      if (!['scheduled', 'completed'].includes(appt.status)) throw conflict(`This appointment is ${appt.status}.`);
      if (appt.appointment_date > todayStr()) throw conflict('This appointment is in the future.');
      const existing = await trx('visits').where({ appointment_id: appointmentId }).first();
      if (existing) return existing;
    }
    if (visitType === 'ipd') {
      const adm = await trx('admissions').where({ patient_id: patientId, status: 'active' }).first();
      if (!adm) throw conflict('The patient is not admitted. Choose OPD or emergency.');
      admissionId = adm.id;
    }
    const [v] = await trx('visits').insert({
      visit_code: await nextCode(trx, 'visit_code_seq'), patient_id: patientId, doctor_id: req.user.doctorId, appointment_id: appointmentId ?? null, admission_id: admissionId, visit_type: visitType, chief_complaint: chiefComplaint,
    }).returning('*');
    await audit(req, { action: 'clinical.visit_start', entityType: 'visit', entityId: v.id, details: { patientId, appointmentId, visitType } }, trx);
    return v;
  });
}

async function openVisitForWrite(req, visitId, conn = db) {
  const v = await conn('visits').where({ id: visitId }).first();
  if (!v) throw notFound('Visit not found.');
  await assertCareAccess(req, v.patient_id, conn);
  if (v.status !== 'open') throw conflict('This visit is closed. Start a new visit to add records.');
  if (v.doctor_id !== req.user.doctorId) throw forbidden('This visit belongs to another doctor. Start your own consultation or ward-round note to add records.');
  return v;
}

export async function closeVisit(req, visitId, notes) {
  return transaction(async (trx) => {
    const v = await openVisitForWrite(req, visitId, trx);
    if (v.doctor_id !== req.user.doctorId) throw forbidden('Only the doctor who started this visit can close it.');
    await trx('visits').where({ id: visitId }).update({ status: 'closed', closed_at: new Date(), notes_enc: notes ? encrypt(notes) : v.notes_enc });
    if (v.appointment_id) await trx('appointments').where({ id: v.appointment_id, status: 'scheduled' }).update({ status: 'completed', completed_at: new Date(), updated_at: new Date() });
    await audit(req, { action: 'clinical.visit_close', entityType: 'visit', entityId: visitId }, trx);
  });
}

export async function updateVisitNotes(req, visitId, { chiefComplaint, notes }) {
  const v = await openVisitForWrite(req, visitId);
  if (v.doctor_id !== req.user.doctorId) throw forbidden('Only the doctor who started this visit can edit its notes.');
  await db('visits').where({ id: visitId }).update({ chief_complaint: chiefComplaint ?? v.chief_complaint, notes_enc: notes !== undefined ? encrypt(notes) : v.notes_enc });
  await audit(req, { action: 'clinical.visit_notes', entityType: 'visit', entityId: visitId });
}

export async function addDiagnosis(req, visitId, b) {
  const v = await openVisitForWrite(req, visitId);
  const [row] = await db('diagnoses').insert({ visit_id: v.id, patient_id: v.patient_id, doctor_id: req.user.doctorId, condition_name: b.conditionName, icd_code: b.icdCode, severity: b.severity, notes: b.notes }).returning('*');
  await audit(req, { action: 'clinical.diagnosis', entityType: 'visit', entityId: v.id, details: { diagnosisId: row.id, condition: b.conditionName, severity: b.severity } });
  return diagDto({ ...row, doctor_name: req.user.fullName });
}

export async function addObservation(req, visitId, b) {
  const v = await openVisitForWrite(req, visitId);
  const [row] = await db('clinical_observations').insert({
    visit_id: v.id, patient_id: v.patient_id, doctor_id: req.user.doctorId, temperature_c: b.temperatureC, pulse_bpm: b.pulseBpm, systolic_bp: b.systolicBp, diastolic_bp: b.diastolicBp,
    respiratory_rate: b.respiratoryRate, spo2: b.spo2, weight_kg: b.weightKg, height_cm: b.heightCm, blood_glucose: b.bloodGlucose, symptoms: b.symptoms, notes: b.notes,
  }).returning('*');
  await audit(req, { action: 'clinical.observation', entityType: 'visit', entityId: v.id, details: { observationId: row.id } });
  return obsDto({ ...row, doctor_name: req.user.fullName });
}

// ----------------------------------------------------------------- prescriptions
async function checkPrescriptionItems(trx, patientId, items) {
  const meds = await trx('medicines').whereIn('id', items.map((i) => i.medicineId));
  const byId = Object.fromEntries(meds.map((m) => [m.id, m]));
  for (const [idx, i] of items.entries()) {
    if (!byId[i.medicineId] || !byId[i.medicineId].is_active) throw new AppError(422, 'Select medicines from the hospital formulary.', { fields: { [`items.${idx}.medicineId`]: 'Not an available medicine.' } });
  }
  if (new Set(items.map((i) => i.medicineId)).size !== items.length) throw new AppError(422, 'Each medicine can appear only once in a prescription.', { fields: { items: 'Duplicate medicine.' } });
  const stock = await stockMap(items.map((i) => i.medicineId), trx);
  const warnings = [];
  for (const i of items) {
    const m = byId[i.medicineId];
    if (stock[m.id] < i.quantity) {
      warnings.push({ type: 'stock', medicineId: m.id, medicine: `${m.name} ${m.strength}`, available: stock[m.id], requested: i.quantity, alternatives: await alternativesFor(m, i.quantity, trx) });
    }
  }
  const patient = await trx('patients').where({ id: patientId }).first();
  const allergies = (decrypt(patient.allergies_enc) ?? '').toLowerCase();
  if (allergies) {
    for (const i of items) {
      const m = byId[i.medicineId];
      const hit = [m.name, m.generic_name, ...m.generic_name.split(/[\s+/,]+/)].map((s) => s.toLowerCase().trim()).filter((s) => s.length > 3).find((s) => allergies.includes(s));
      if (hit) warnings.push({ type: 'allergy', medicineId: m.id, medicine: `${m.name} ${m.strength}`, message: `Patient allergy record mentions "${hit}".` });
    }
  }
  return { byId, warnings };
}

export async function createPrescription(req, visitId, { items, notes, acknowledgeWarnings }) {
  validatePrescriptionItems(items);
  return transaction(async (trx) => {
    const v = await openVisitForWrite(req, visitId, trx);
    // UC-27 pre-condition: a diagnosis must be recorded for the current visit.
    const dx = await trx('diagnoses').where({ visit_id: v.id }).first();
    if (!dx) throw conflict('Record a diagnosis for this visit before prescribing.', { code: 'DIAGNOSIS_REQUIRED' });
    const { byId, warnings } = await checkPrescriptionItems(trx, v.patient_id, items);
    if (warnings.length && !acknowledgeWarnings) {
      throw conflict('Please review the warnings for this prescription.', { code: 'PRESCRIPTION_WARNINGS', details: { warnings } });
    }
    const [rx] = await trx('prescriptions').insert({
      prescription_code: await nextCode(trx, 'prescription_code_seq'), visit_id: v.id, patient_id: v.patient_id, doctor_id: req.user.doctorId, notes, stock_warning_acknowledged: warnings.length > 0,
    }).returning('*');
    await trx('prescription_items').insert(items.map((i) => ({ prescription_id: rx.id, medicine_id: i.medicineId, dosage: i.dosage, frequency: i.frequency, duration_days: i.durationDays, quantity: i.quantity, instructions: i.instructions })));
    await audit(req, { action: 'prescription.create', entityType: 'prescription', entityId: rx.id, details: { code: rx.prescription_code, items: items.map((i) => byId[i.medicineId].name), warningsAcknowledged: warnings.length } }, trx);
    const patient = await trx('patients').where({ id: v.patient_id }).first();
    // UC-27 step 6: saved and sent to the pharmacy.
    await notify(trx, { permission: 'pharmacy.verify', eventType: 'prescription.received', title: 'New prescription', message: `${rx.prescription_code} for ${patient.first_name} ${patient.last_name} (${patient.patient_code}) from ${req.user.fullName}. Please verify within 15 minutes.`, link: `/pharmacy/prescriptions/${rx.id}`, entityType: 'prescription', entityId: rx.id });
    trx.afterCommit(() => publishToPermission(['pharmacy.verify', 'pharmacy.dispense'], 'prescriptions.changed', {}));
    return { id: rx.id, prescriptionCode: rx.prescription_code, status: rx.status, warnings };
  });
}

/** Doctor revises a prescription the pharmacist flagged (UC-34 2-A) and resends it. */
export async function revisePrescription(req, rxId, { items, notes, acknowledgeWarnings }) {
  validatePrescriptionItems(items);
  return transaction(async (trx) => {
    const rx = await trx('prescriptions').where({ id: rxId }).forUpdate().first();
    if (!rx) throw notFound('Prescription not found.');
    if (rx.doctor_id !== req.user.doctorId) throw forbidden('Only the prescribing doctor can revise this prescription.');
    if (!['flagged', 'pending'].includes(rx.status)) throw conflict('Only pending or flagged prescriptions can be revised.');
    const { warnings } = await checkPrescriptionItems(trx, rx.patient_id, items);
    if (warnings.length && !acknowledgeWarnings) throw conflict('Please review the warnings for this prescription.', { code: 'PRESCRIPTION_WARNINGS', details: { warnings } });
    await trx('prescription_items').where({ prescription_id: rxId }).del();
    await trx('prescription_items').insert(items.map((i) => ({ prescription_id: rxId, medicine_id: i.medicineId, dosage: i.dosage, frequency: i.frequency, duration_days: i.durationDays, quantity: i.quantity, instructions: i.instructions })));
    await trx('prescriptions').where({ id: rxId }).update({ status: 'pending', notes, flag_reason: null, flagged_at: null, flagged_by: null, sent_to_pharmacy_at: new Date(), updated_at: new Date() });
    await audit(req, { action: 'prescription.revise', entityType: 'prescription', entityId: rxId, details: { previousStatus: rx.status } }, trx);
    await notify(trx, { permission: 'pharmacy.verify', eventType: 'prescription.received', title: 'Prescription revised', message: `${rx.prescription_code} was revised by ${req.user.fullName} and resent for verification.`, link: `/pharmacy/prescriptions/${rxId}`, entityType: 'prescription', entityId: rxId });
    trx.afterCommit(() => publishToPermission(['pharmacy.verify', 'pharmacy.dispense'], 'prescriptions.changed', {}));
  });
}

export async function cancelPrescription(req, rxId, reason) {
  await transaction(async (trx) => {
    const rx = await trx('prescriptions').where({ id: rxId }).forUpdate().first();
    if (!rx) throw notFound('Prescription not found.');
    if (rx.doctor_id !== req.user.doctorId) throw forbidden('Only the prescribing doctor can cancel this prescription.');
    if (!['pending', 'flagged', 'verified'].includes(rx.status)) throw conflict('This prescription can no longer be cancelled.');
    await trx('prescriptions').where({ id: rxId }).update({ status: 'cancelled', notes: [rx.notes, `Cancelled: ${reason}`].filter(Boolean).join(' | '), updated_at: new Date() });
    await audit(req, { action: 'prescription.cancel', entityType: 'prescription', entityId: rxId, details: { reason } }, trx);
    trx.afterCommit(() => publishToPermission(['pharmacy.verify', 'pharmacy.dispense'], 'prescriptions.changed', {}));
  });
}

export async function myFlaggedPrescriptions(req) {
  const rows = await db('prescriptions as p').join('patients as pt', 'pt.id', 'p.patient_id').leftJoin('users as u', 'u.id', 'p.flagged_by')
    .where({ 'p.doctor_id': req.user.doctorId, 'p.status': 'flagged' }).orderBy('p.flagged_at', 'desc')
    .select('p.id', 'p.prescription_code', 'p.flag_reason', 'p.flagged_at', 'p.visit_id', 'pt.id as patient_id', 'pt.patient_code', 'pt.first_name', 'pt.last_name', 'u.full_name as flagged_by_name');
  return rows.map((r) => ({ id: r.id, prescriptionCode: r.prescription_code, flagReason: r.flag_reason, flaggedAt: r.flagged_at, flaggedByName: r.flagged_by_name, visitId: r.visit_id, patient: { id: r.patient_id, patientCode: r.patient_code, fullName: `${r.first_name} ${r.last_name}` } }));
}

// ----------------------------------------------------------------- lab requests
export async function requestLabTest(req, b) {
  await assertCareAccess(req, b.patientId);
  const test = await db('lab_tests').where({ id: b.labTestId }).first();
  if (!test) throw new AppError(422, 'Select a lab test.', { fields: { labTestId: 'Select a lab test.' } });
  if (!test.is_available) {
    // UC-28 2-A: test not available -> suggest alternatives.
    const alternatives = await db('lab_tests').where({ category: test.category, is_available: true }).whereNot({ id: test.id }).select('id', 'code', 'name');
    throw conflict(`${test.name} is not available at the moment.`, { code: 'TEST_UNAVAILABLE', details: { alternatives } });
  }
  const parameters = validateParameters(test, b.parameters);
  if (b.visitId) {
    const v = await db('visits').where({ id: b.visitId, patient_id: b.patientId }).first();
    assertVisitMatchesPatientAndDoctor(v, b.patientId, req.user.doctorId);
  }
  return transaction(async (trx) => {
    const [row] = await trx('lab_requests').insert({
      request_code: await nextCode(trx, 'lab_request_code_seq'), patient_id: b.patientId, doctor_id: req.user.doctorId, visit_id: b.visitId ?? null, lab_test_id: test.id,
      urgency: b.urgency, clinical_notes: b.clinicalNotes, parameters: JSON.stringify(parameters), special_instructions: b.specialInstructions,
    }).returning('*');
    await audit(req, { action: 'lab.request', entityType: 'lab_request', entityId: row.id, details: { code: row.request_code, test: test.code, urgency: b.urgency } }, trx);
    const patient = await trx('patients').where({ id: b.patientId }).first();
    // UC-28 step 6: lab technician notified.
    await notify(trx, { permission: 'lab.process', priority: b.urgency === 'routine' ? 'normal' : 'high', eventType: 'lab.requested', title: `New ${b.urgency.toUpperCase()} lab request`, message: `${test.name} for ${patient.first_name} ${patient.last_name} (${patient.patient_code}) requested by ${req.user.fullName}.`, link: `/lab/requests/${row.id}`, entityType: 'lab_request', entityId: row.id });
    trx.afterCommit(() => publishToPermission('lab.process', 'lab.changed', {}));
    return { id: row.id, requestCode: row.request_code, status: row.status, parameters };
  });
}

/** UC-29: parameters must come from the test's standard definition. */
function validateParameters(test, requested) {
  const allowed = (test.parameters ?? []).map((p) => p.name);
  if (!requested?.length) return allowed;
  const invalid = requested.filter((p) => !allowed.includes(p));
  if (invalid.length) throw new AppError(422, `Invalid parameter(s) for ${test.name}: ${invalid.join(', ')}.`, { fields: { parameters: `Allowed: ${allowed.join(', ')}` } });
  return [...new Set(requested)];
}

export async function updateLabParameters(req, requestId, { parameters, specialInstructions }) {
  const params = await transaction(async (trx) => {
    const lr = await trx('lab_requests').where({ id: requestId }).forUpdate().first();
    if (!lr) throw notFound('Lab request not found.');
    if (lr.doctor_id !== req.user.doctorId) throw forbidden('Only the requesting doctor can change parameters.');
    if (lr.status !== 'requested') throw conflict('Parameters can only be changed before the lab starts processing.');
    const test = await trx('lab_tests').where({ id: lr.lab_test_id }).first();
    const params = validateParameters(test, parameters);
    await trx('lab_requests').where({ id: requestId }).update({ parameters: JSON.stringify(params), special_instructions: specialInstructions ?? lr.special_instructions });
    await audit(req, { action: 'lab.parameters_update', entityType: 'lab_request', entityId: requestId, details: { parameters: params } }, trx);
    return params;
  });
  return { parameters: params };
}

export async function cancelLabRequest(req, requestId, reason) {
  const lr = await db('lab_requests').where({ id: requestId }).first();
  if (!lr) throw notFound('Lab request not found.');
  if (lr.doctor_id !== req.user.doctorId) throw forbidden('Only the requesting doctor can cancel this request.');
  if (!['requested', 'delayed'].includes(lr.status)) throw conflict('This lab request can no longer be cancelled.');
  await db('lab_requests').where({ id: requestId }).update({ status: 'cancelled', delay_reason: reason });
  await audit(req, { action: 'lab.request_cancel', entityType: 'lab_request', entityId: requestId, details: { reason } });
  publishToPermission('lab.process', 'lab.changed', {});
}
