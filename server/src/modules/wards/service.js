// Ward & bed management (SRS FR-14/15/16, UC-18 Admit, UC-19 Assign Bed, UC-20 Transfer,
// UC-21 Discharge, Figure 13 activity diagram).
import { db } from '../../db/knex.js';
import { transaction } from '../../db/tx.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { nextCode } from '../../lib/codes.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notifications.js';
import { publishToPermission } from '../../services/realtime.js';
import { getUnbilledServices, outstandingBalance } from '../billing/charges.js';
import { assertCareAccess, hasCareRelationship } from '../clinical/access.js';
import { ageFrom } from '../../lib/dates.js';
import { env } from '../../config/env.js';

const bedsChanged = (trx) => trx.afterCommit(() => publishToPermission(['wards.view', 'admissions.manage'], 'beds.changed', {}));

// ----------------------------------------------------------------- wards & beds
export async function listWards({ includeInactive = false } = {}) {
  const q = db('wards as w').leftJoin('departments as d', 'd.id', 'w.department_id').orderBy('w.name').select(
    'w.*', 'd.name as department_name',
    db.raw("(SELECT count(*) FROM beds b WHERE b.ward_id = w.id)::int AS total_beds"),
    db.raw("(SELECT count(*) FROM beds b WHERE b.ward_id = w.id AND b.status = 'available')::int AS available_beds"),
    db.raw("(SELECT count(*) FROM beds b WHERE b.ward_id = w.id AND b.status = 'occupied')::int AS occupied_beds"),
    db.raw("(SELECT count(*) FROM beds b WHERE b.ward_id = w.id AND b.status = 'maintenance')::int AS maintenance_beds"),
  );
  if (!includeInactive) q.where('w.is_active', true);
  return (await q).map((w) => ({
    id: w.id, name: w.name, wardType: w.ward_type, departmentId: w.department_id, departmentName: w.department_name, floor: w.floor, genderPolicy: w.gender_policy,
    dailyRate: w.daily_rate, isActive: w.is_active, totalBeds: w.total_beds, availableBeds: w.available_beds, occupiedBeds: w.occupied_beds, maintenanceBeds: w.maintenance_beds,
  }));
}

/** Live bed board: every bed with its current occupant. */
export async function bedBoard({ wardId } = {}) {
  const q = db('beds as b')
    .join('wards as w', 'w.id', 'b.ward_id')
    .leftJoin('admissions as a', function j() { this.on('a.bed_id', 'b.id').andOnVal('a.status', '=', 'active'); })
    .leftJoin('patients as p', 'p.id', 'a.patient_id')
    .leftJoin('doctors as d', 'd.id', 'a.attending_doctor_id').leftJoin('staff as s', 's.id', 'd.staff_id').leftJoin('users as u', 'u.id', 's.user_id')
    .where('w.is_active', true)
    .orderBy(['w.name', 'b.bed_number'])
    .select('b.id', 'b.bed_number', 'b.status', 'b.notes', 'w.id as ward_id', 'w.name as ward_name', 'a.id as admission_id', 'a.admission_code', 'a.admitted_at', 'a.discharge_approved_at',
      'p.id as patient_id', 'p.patient_code', 'p.first_name', 'p.last_name', 'p.gender', 'p.date_of_birth', 'u.full_name as doctor_name');
  if (wardId) q.where('w.id', wardId);
  return (await q).map((r) => ({
    id: r.id, bedNumber: r.bed_number, status: r.status, notes: r.notes, wardId: r.ward_id, wardName: r.ward_name,
    occupant: r.admission_id ? {
      admissionId: r.admission_id, admissionCode: r.admission_code, admittedAt: r.admitted_at, dischargeApproved: Boolean(r.discharge_approved_at),
      patientId: r.patient_id, patientCode: r.patient_code, fullName: `${r.first_name} ${r.last_name}`, gender: r.gender, age: ageFrom(r.date_of_birth), doctorName: r.doctor_name,
    } : null,
  }));
}

export async function createWard(req, b) {
  const [w] = await db('wards').insert({ name: b.name, ward_type: b.wardType, department_id: b.departmentId, floor: b.floor, gender_policy: b.genderPolicy, daily_rate: b.dailyRate }).returning('*');
  if (b.bedCount) await addBeds(req, w.id, { count: b.bedCount, prefix: b.bedPrefix });
  await audit(req, { action: 'ward.create', entityType: 'ward', entityId: w.id, details: { name: w.name, beds: b.bedCount ?? 0 } });
  return w;
}

export async function updateWard(req, id, b) {
  const patch = {};
  const map = { name: 'name', wardType: 'ward_type', departmentId: 'department_id', floor: 'floor', genderPolicy: 'gender_policy', dailyRate: 'daily_rate', isActive: 'is_active' };
  for (const [k, c] of Object.entries(map)) if (b[k] !== undefined) patch[c] = b[k];
  if (b.isActive === false) {
    const occ = await db('beds').where({ ward_id: id, status: 'occupied' }).count({ n: '*' }).first();
    if (occ.n > 0) throw conflict('This ward still has admitted patients. Transfer or discharge them first.');
  }
  const [w] = await db('wards').where({ id }).update(patch).returning('*');
  if (!w) throw notFound('Ward not found.');
  await audit(req, { action: 'ward.update', entityType: 'ward', entityId: id, details: { fields: Object.keys(b) } });
  return w;
}

export async function addBeds(req, wardId, { count, prefix, bedNumber }) {
  const ward = await db('wards').where({ id: wardId }).first();
  if (!ward) throw notFound('Ward not found.');
  const rows = [];
  if (bedNumber) rows.push({ ward_id: wardId, bed_number: bedNumber });
  else {
    const existing = await db('beds').where({ ward_id: wardId }).count({ n: '*' }).first();
    const p = prefix || ward.name.split(' ').map((s) => s[0]).join('').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
    for (let i = 1; i <= count; i++) rows.push({ ward_id: wardId, bed_number: `${p}-${String(Number(existing.n) + i).padStart(2, '0')}` });
  }
  const inserted = await db('beds').insert(rows).returning('*');
  await audit(req, { action: 'bed.create', entityType: 'ward', entityId: wardId, details: { beds: inserted.map((b) => b.bed_number) } });
  publishToPermission(['wards.view', 'admissions.manage'], 'beds.changed', {});
  return inserted;
}

export async function setBedStatus(req, bedId, status, notes) {
  return transaction(async (trx) => {
    const bed = await trx('beds').where({ id: bedId }).forUpdate().first();
    if (!bed) throw notFound('Bed not found.');
    if (bed.status === 'occupied') throw conflict('This bed is occupied. Transfer or discharge the patient first.');
    await trx('beds').where({ id: bedId }).update({ status, notes: notes ?? null, updated_at: new Date() });
    await audit(req, { action: 'bed.status_change', entityType: 'bed', entityId: bedId, details: { from: bed.status, to: status } }, trx);
    bedsChanged(trx);
  });
}

export async function deleteBed(req, bedId) {
  return transaction(async (trx) => {
    const bed = await trx('beds').where({ id: bedId }).forUpdate().first();
    if (!bed) throw notFound('Bed not found.');
    if (bed.status === 'occupied') throw conflict('This bed is occupied. Transfer or discharge the patient before deleting it.');

    const [admissions, transfers] = await Promise.all([
      trx('admissions').where({ bed_id: bedId }).count({ n: '*' }).first(),
      trx('bed_transfers').where((q) => q.where({ from_bed_id: bedId }).orWhere({ to_bed_id: bedId })).count({ n: '*' }).first(),
    ]);
    if (Number(admissions.n) > 0 || Number(transfers.n) > 0) {
      throw conflict('This bed has admission or transfer history and cannot be deleted. Mark it under maintenance instead.');
    }

    await trx('beds').where({ id: bedId }).del();
    await audit(req, { action: 'bed.delete', entityType: 'bed', entityId: bedId, details: { bedNumber: bed.bed_number, wardId: bed.ward_id } }, trx);
    bedsChanged(trx);
  });
}

/** UC-18 2-A: suggest other wards with free beds (same ward type first). */
async function suggestWards(conn, excludeWardId, gender, wardType) {
  const rows = await conn('wards as w').join('beds as b', 'b.ward_id', 'w.id')
    .where('w.is_active', true).where('b.status', 'available').whereNot('w.id', excludeWardId)
    .whereIn('w.gender_policy', ['any', gender])
    .groupBy('w.id').select('w.id', 'w.name', 'w.ward_type', db.raw('count(b.id)::int as available_beds'));
  return rows.sort((a, b) => (b.ward_type === wardType) - (a.ward_type === wardType) || b.available_beds - a.available_beds).map((w) => ({ wardId: w.id, wardName: w.name, wardType: w.ward_type, availableBeds: w.available_beds }));
}

/** Locks and validates a bed for assignment. */
async function lockAvailableBed(trx, wardId, bedId, patient) {
  const ward = await trx('wards').where({ id: wardId }).first();
  if (!ward || !ward.is_active) throw new AppError(422, 'Select an active ward.', { fields: { wardId: 'Select an active ward.' } });
  if (ward.gender_policy !== 'any' && ward.gender_policy !== patient.gender) {
    throw new AppError(422, `${ward.name} only admits ${ward.gender_policy} patients.`, { fields: { wardId: `This ward only admits ${ward.gender_policy} patients.` }, details: { suggestions: await suggestWards(trx, wardId, patient.gender, ward.ward_type) } });
  }
  const free = await trx('beds').where({ ward_id: wardId, status: 'available' }).count({ n: '*' }).first();
  if (Number(free.n) === 0) {
    throw conflict('No beds are currently available in this ward.', { code: 'NO_BEDS', details: { suggestions: await suggestWards(trx, wardId, patient.gender, ward.ward_type) } });
  }
  const bed = await trx('beds').where({ id: bedId }).forUpdate().first();
  if (!bed || bed.ward_id !== wardId) throw new AppError(422, 'Select a bed in the chosen ward.', { fields: { bedId: 'Select a bed in the chosen ward.' } });
  if (bed.status !== 'available') throw conflict(`Bed ${bed.bed_number} is ${bed.status}. Please choose another bed.`, { code: 'BED_UNAVAILABLE', fields: { bedId: 'This bed is no longer available.' } });
  return { ward, bed };
}

const admissionSelect = [
  'a.*', 'p.patient_code', 'p.first_name', 'p.last_name', 'p.gender', 'p.date_of_birth', 'w.name as ward_name', 'b.bed_number', 'u.full_name as doctor_name', 'u.id as doctor_user_id',
  'au.full_name as admitted_by_name', 'du.full_name as discharged_by_name', 'apu.full_name as discharge_approved_by_name',
];
const admissionQuery = (conn = db) =>
  conn('admissions as a').join('patients as p', 'p.id', 'a.patient_id').join('wards as w', 'w.id', 'a.ward_id').join('beds as b', 'b.id', 'a.bed_id')
    .join('doctors as d', 'd.id', 'a.attending_doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id')
    .join('users as au', 'au.id', 'a.admitted_by').leftJoin('users as du', 'du.id', 'a.discharged_by')
    .leftJoin('doctors as apd', 'apd.id', 'a.discharge_approved_by').leftJoin('staff as aps', 'aps.id', 'apd.staff_id').leftJoin('users as apu', 'apu.id', 'aps.user_id');

const admissionDto = (a) => ({
  id: a.id, admissionCode: a.admission_code, status: a.status, reason: a.reason, admittedAt: a.admitted_at, admittedByName: a.admitted_by_name,
  dischargeApprovedAt: a.discharge_approved_at, dischargeApprovedByName: a.discharge_approved_by_name, dischargeNotes: a.discharge_notes, dischargedAt: a.discharged_at, dischargedByName: a.discharged_by_name,
  patient: { id: a.patient_id, patientCode: a.patient_code, fullName: `${a.first_name} ${a.last_name}`, gender: a.gender, age: ageFrom(a.date_of_birth) },
  ward: { id: a.ward_id, name: a.ward_name }, bed: { id: a.bed_id, bedNumber: a.bed_number },
  doctor: { id: a.attending_doctor_id, fullName: a.doctor_name },
});

export async function listAdmissions({ status = 'active', wardId, q }) {
  const query = admissionQuery().select(admissionSelect).orderBy('a.admitted_at', 'desc').limit(300);
  if (status !== 'all') query.where('a.status', status);
  if (wardId) query.where('a.ward_id', wardId);
  if (q) query.where((w) => w.whereILike('p.patient_code', `%${q}%`).orWhereRaw("lower(p.first_name || ' ' || p.last_name) like lower(?)", [`%${q}%`]).orWhereILike('a.admission_code', `%${q}%`));
  return (await query).map(admissionDto);
}

export async function getAdmission(id, conn = db) {
  const a = await admissionQuery(conn).where('a.id', id).first(admissionSelect);
  if (!a) throw notFound('Admission not found.');
  return a;
}

const CLINICAL_SUMMARY_FIELDS = ['diagnoses', 'medications', 'investigations', 'treatmentSummary', 'finalDiagnosis'];

/** Full detail; clinical content of the discharge summary is only for the patient's doctors. */
export async function admissionDetail(id, req = null) {
  const a = await getAdmission(id);
  const transfers = await db('bed_transfers as t').join('wards as fw', 'fw.id', 't.from_ward_id').join('beds as fb', 'fb.id', 't.from_bed_id').join('wards as tw', 'tw.id', 't.to_ward_id').join('beds as tb', 'tb.id', 't.to_bed_id').join('users as u', 'u.id', 't.transferred_by')
    .where('t.admission_id', id).orderBy('t.transferred_at')
    .select('t.id', 't.reason', 't.transferred_at', 'fw.name as from_ward', 'fb.bed_number as from_bed', 'tw.name as to_ward', 'tb.bed_number as to_bed', 'u.full_name as by_name');
  const summary = await db('discharge_summaries').where({ admission_id: id }).first();
  const detail = {
    ...admissionDto(a),
    transfers: transfers.map((t) => ({ id: t.id, reason: t.reason, at: t.transferred_at, from: `${t.from_ward} / ${t.from_bed}`, to: `${t.to_ward} / ${t.to_bed}`, byName: t.by_name })),
    dischargeSummary: summary ? { id: summary.id, generatedAt: summary.generated_at, content: summary.content } : null,
  };
  const clinical = !req || (req.user.doctorId && (await hasCareRelationship(req.user.doctorId, a.patient_id)));
  if (!clinical) {
    detail.dischargeNotes = null;
    if (detail.dischargeSummary) {
      const c = { ...detail.dischargeSummary.content };
      for (const k of CLINICAL_SUMMARY_FIELDS) delete c[k];
      c.clinicalDetailsRedacted = true;
      detail.dischargeSummary = { ...detail.dischargeSummary, content: c };
    }
  }
  return detail;
}

// ----------------------------------------------------------------- admission requests (doctor recommends)
export async function createAdmissionRequest(req, b) {
  await assertCareAccess(req, b.patientId);
  if (b.requestType === 'transfer') {
    const active = await db('admissions').where({ patient_id: b.patientId, status: 'active' }).first();
    if (!active) throw conflict('This patient is not currently admitted, so a transfer cannot be requested.');
  } else if (await db('admissions').where({ patient_id: b.patientId, status: 'active' }).first()) {
    throw conflict('This patient is already admitted.');
  }
  const open = await db('admission_requests').where({ patient_id: b.patientId, status: 'pending', request_type: b.requestType }).first();
  if (open) throw conflict(`There is already a pending ${b.requestType} request for this patient.`);
  const patient = await db('patients').where({ id: b.patientId }).first();
  const [row] = await db('admission_requests').insert({ request_type: b.requestType, patient_id: b.patientId, doctor_id: req.user.doctorId, preferred_ward_id: b.preferredWardId, reason: b.reason, priority: b.priority }).returning('*');
  await audit(req, { action: `admission.${b.requestType}_requested`, entityType: 'patient', entityId: b.patientId, details: { requestId: row.id, priority: b.priority } });
  await notify(db, {
    permission: 'admissions.manage', priority: b.priority === 'routine' ? 'normal' : 'high', eventType: `admission.${b.requestType}_requested`,
    title: b.requestType === 'admission' ? 'Admission recommended' : 'Transfer requested',
    message: `${req.user.fullName} requested ${b.requestType} for ${patient.first_name} ${patient.last_name} (${patient.patient_code}). Priority: ${b.priority}. Reason: ${b.reason}`,
    link: '/admissions', entityType: 'admission_request', entityId: row.id,
  });
  return row;
}

export async function listAdmissionRequests(status = 'pending') {
  const rows = await db('admission_requests as r').join('patients as p', 'p.id', 'r.patient_id')
    .join('doctors as d', 'd.id', 'r.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id')
    .leftJoin('wards as w', 'w.id', 'r.preferred_ward_id')
    .modify((q) => status !== 'all' && q.where('r.status', status))
    .orderByRaw("CASE r.priority WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END").orderBy('r.created_at')
    .select('r.*', 'p.patient_code', 'p.first_name', 'p.last_name', 'p.gender', 'u.full_name as doctor_name', 'w.name as ward_name');
  return rows.map((r) => ({
    id: r.id, requestType: r.request_type, status: r.status, priority: r.priority, reason: r.reason, createdAt: r.created_at, preferredWardId: r.preferred_ward_id, preferredWardName: r.ward_name,
    patient: { id: r.patient_id, patientCode: r.patient_code, fullName: `${r.first_name} ${r.last_name}`, gender: r.gender }, doctor: { id: r.doctor_id, fullName: r.doctor_name }, admissionId: r.admission_id,
  }));
}

export async function cancelAdmissionRequest(req, id) {
  const r = await db('admission_requests').where({ id, status: 'pending' }).first();
  if (!r) throw notFound('Pending request not found.');
  if (req.user.role === 'doctor' && r.doctor_id !== req.user.doctorId) throw forbidden('You can only cancel your own requests.');
  await db('admission_requests').where({ id }).update({ status: 'cancelled' });
  await audit(req, { action: 'admission.request_cancelled', entityType: 'admission_request', entityId: id });
}

// ----------------------------------------------------------------- admit / transfer / discharge
export async function admit(req, b) {
  const result = await transaction(async (trx) => {
    const patient = await trx('patients').where({ id: b.patientId }).forUpdate().first();
    if (!patient) throw new AppError(422, 'Invalid patient ID. Please check and re-enter it.', { fields: { patientId: 'Patient not found.' } });
    if (await trx('admissions').where({ patient_id: patient.id, status: 'active' }).first()) throw conflict('This patient is already admitted.', { fields: { patientId: 'Already admitted.' } });
    const doctor = await trx('doctors').where({ id: b.attendingDoctorId, is_active: true }).first();
    if (!doctor) throw new AppError(422, 'Select an attending doctor.', { fields: { attendingDoctorId: 'Select an active doctor.' } });
    const { ward, bed } = await lockAvailableBed(trx, b.wardId, b.bedId, patient);

    let request = null;
    if (b.requestId) {
      request = await trx('admission_requests').where({ id: b.requestId, patient_id: patient.id, request_type: 'admission', status: 'pending' }).forUpdate().first();
      if (!request) throw conflict('The admission request is no longer pending.');
    }
    const [adm] = await trx('admissions').insert({
      admission_code: await nextCode(trx, 'admission_code_seq'), patient_id: patient.id, attending_doctor_id: doctor.id, ward_id: ward.id, bed_id: bed.id,
      admission_request_id: request?.id ?? null, reason: b.reason, admitted_by: req.user.id,
    }).returning('*');
    await trx('beds').where({ id: bed.id }).update({ status: 'occupied', updated_at: new Date() });
    await trx('patients').where({ id: patient.id }).update({ status: 'in_patient', updated_at: new Date() });
    if (request) await trx('admission_requests').where({ id: request.id }).update({ status: 'fulfilled', admission_id: adm.id, fulfilled_by: req.user.id, fulfilled_at: new Date() });
    // UC-18 special requirement: admission linked to the patient's medical record (IPD visit).
    await trx('visits').insert({ visit_code: await nextCode(trx, 'visit_code_seq'), patient_id: patient.id, doctor_id: doctor.id, admission_id: adm.id, visit_type: 'ipd', chief_complaint: b.reason });
    await audit(req, { action: 'admission.admit', entityType: 'admission', entityId: adm.id, details: { patientCode: patient.patient_code, ward: ward.name, bed: bed.bed_number } }, trx);
    await audit(req, { action: 'bed.assign', entityType: 'bed', entityId: bed.id, details: { admissionId: adm.id, patientCode: patient.patient_code } }, trx);
    const doctorUser = await trx('staff').where({ id: doctor.staff_id }).first('user_id');
    await notify(trx, { userIds: [doctorUser.user_id], eventType: 'admission.admitted', title: 'Patient admitted', message: `${patient.first_name} ${patient.last_name} (${patient.patient_code}) admitted to ${ward.name}, bed ${bed.bed_number}, under your care.`, link: `/doctor/patients/${patient.id}`, entityType: 'admission', entityId: adm.id });
    bedsChanged(trx);
    return adm;
  });
  return admissionDetail(result.id, req);
}

export async function transfer(req, admissionId, b) {
  await transaction(async (trx) => {
    const adm = await trx('admissions').where({ id: admissionId }).forUpdate().first();
    if (!adm || adm.status !== 'active') throw conflict('Only active admissions can be transferred.');
    if (adm.bed_id === b.toBedId) throw new AppError(422, 'Choose a different bed.', { fields: { toBedId: 'The patient is already in this bed.' } });
    const patient = await trx('patients').where({ id: adm.patient_id }).first();
    // Lock both beds in id order so two crossing transfers cannot deadlock.
    await trx('beds').whereIn('id', [adm.bed_id, b.toBedId]).orderBy('id').forUpdate();
    const { ward, bed } = await lockAvailableBed(trx, b.toWardId, b.toBedId, patient);
    const oldBed = await trx('beds').where({ id: adm.bed_id }).forUpdate().first();
    const oldWard = await trx('wards').where({ id: adm.ward_id }).first();
    // Old bed is freed and the new bed assigned in one transaction (UC-20 post-condition).
    await trx('beds').where({ id: oldBed.id }).update({ status: 'available', updated_at: new Date() });
    await trx('beds').where({ id: bed.id }).update({ status: 'occupied', updated_at: new Date() });
    await trx('admissions').where({ id: adm.id }).update({ ward_id: ward.id, bed_id: bed.id });
    // Logged with date, time and reason (UC-20 special requirement).
    await trx('bed_transfers').insert({ admission_id: adm.id, from_ward_id: oldWard.id, from_bed_id: oldBed.id, to_ward_id: ward.id, to_bed_id: bed.id, reason: b.reason, transferred_by: req.user.id });
    if (b.requestId) await trx('admission_requests').where({ id: b.requestId, patient_id: adm.patient_id, request_type: 'transfer', status: 'pending' }).update({ status: 'fulfilled', admission_id: adm.id, fulfilled_by: req.user.id, fulfilled_at: new Date() });
    await audit(req, { action: 'admission.transfer', entityType: 'admission', entityId: adm.id, details: { from: `${oldWard.name}/${oldBed.bed_number}`, to: `${ward.name}/${bed.bed_number}`, reason: b.reason } }, trx);
    const doctorUser = await trx('doctors as d').join('staff as s', 's.id', 'd.staff_id').where('d.id', adm.attending_doctor_id).first('s.user_id');
    await notify(trx, { userIds: [doctorUser.user_id], eventType: 'admission.transferred', title: 'Patient transferred', message: `${patient.first_name} ${patient.last_name} moved from ${oldWard.name} ${oldBed.bed_number} to ${ward.name} ${bed.bed_number}. Reason: ${b.reason}`, link: `/admissions/${adm.id}`, entityType: 'admission', entityId: adm.id });
    bedsChanged(trx);
  });
  return admissionDetail(admissionId, req);
}

/** Doctor confirms the patient is ready for discharge (Figure 13 "Doctor Approves Discharge"). */
export async function approveDischarge(req, admissionId, notes) {
  let a;
  await transaction(async (trx) => {
    const adm = await trx('admissions').where({ id: admissionId }).forUpdate().first();
    if (!adm || adm.status !== 'active') throw conflict('Only active admissions can be approved for discharge.');
    await assertCareAccess(req, adm.patient_id, trx);
    const approvedAt = adm.discharge_approved_at ?? new Date();
    await trx('admissions').where({ id: admissionId }).update({
      discharge_approved_by: adm.discharge_approved_by ?? req.user.doctorId,
      discharge_approved_at: approvedAt,
      discharge_notes: notes ?? adm.discharge_notes,
    });
    await audit(req, { action: 'admission.discharge_approved', entityType: 'admission', entityId: admissionId }, trx);
    a = await getAdmission(admissionId, trx);
  });
  await notify(db, { permission: 'admissions.manage', eventType: 'admission.discharge_approved', title: 'Ready for discharge', message: `${a.first_name} ${a.last_name} (${a.patient_code}) in ${a.ward_name} ${a.bed_number} has been approved for discharge by ${req.user.fullName}.`, link: `/admissions/${admissionId}`, entityType: 'admission', entityId: admissionId });
  await notify(db, { permission: 'billing.manage', eventType: 'billing.final_bill_needed', title: 'Final bill needed', message: `${a.first_name} ${a.last_name} (${a.patient_code}) is ready for discharge. Please generate the final bill.`, link: `/billing/patients/${a.patient_id}`, entityType: 'patient', entityId: a.patient_id });
  publishToPermission(['wards.view', 'admissions.manage'], 'beds.changed', {});
  return admissionDetail(admissionId, req);
}

/** UC-21 step 2: are all bills cleared? */
export async function dischargeCheck(admissionId) {
  const adm = await db('admissions').where({ id: admissionId }).first();
  if (!adm) throw notFound('Admission not found.');
  const outstanding = await outstandingBalance(adm.patient_id);
  const { items } = await getUnbilledServices(adm.patient_id);
  const unbilledTotal = items.reduce((s, i) => s + Number(i.amount), 0);
  return {
    doctorApproved: Boolean(adm.discharge_approved_at),
    billsCleared: outstanding.amount === 0 && items.length === 0,
    outstandingAmount: outstanding.amount, unpaidBills: outstanding.bills,
    unbilledServices: items.length, unbilledAmount: Math.round(unbilledTotal * 100) / 100,
  };
}

export async function discharge(req, admissionId, b) {
  const isDoctor = req.user.permissions.includes('discharge.approve') && req.user.doctorId;
  const result = await transaction(async (trx) => {
    const adm = await trx('admissions').where({ id: admissionId }).forUpdate().first();
    if (!adm || adm.status !== 'active') throw conflict('Only active admissions can be discharged.');
    if (isDoctor) await assertCareAccess(req, adm.patient_id, trx);
    else if (!adm.discharge_approved_at) throw conflict('A doctor must confirm the patient is ready for discharge first.', { code: 'NOT_APPROVED' });

    // UC-21 2-A: block discharge while bills are pending.
    const outstanding = await outstandingBalance(adm.patient_id, trx);
    const { items } = await getUnbilledServices(adm.patient_id, trx);
    if (outstanding.amount > 0 || items.length) {
      await audit(req, { action: 'admission.discharge_blocked', entityType: 'admission', entityId: adm.id, status: 'failure', details: { outstanding: outstanding.amount, unbilledServices: items.length } }, trx);
      const msg = outstanding.amount > 0
        ? `Discharge blocked: the patient has pending payments of ${outstanding.amount.toFixed(2)} on ${outstanding.bills} bill(s).`
        : `Discharge blocked: ${items.length} service(s) have not been billed yet. Ask accounts to generate the final bill.`;
      throw conflict(msg, { code: 'PENDING_BILLS', details: { outstanding: outstanding.amount, unbilledServices: items.length } });
    }

    const patient = await trx('patients').where({ id: adm.patient_id }).first();
    const ward = await trx('wards').where({ id: adm.ward_id }).first();
    const bed = await trx('beds').where({ id: adm.bed_id }).forUpdate().first();
    const doctor = await trx('doctors as d').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id').where('d.id', adm.attending_doctor_id).first('u.full_name', 'u.id as user_id', 'd.specialization');
    const now = new Date();
    const diagnoses = await trx('diagnoses').where({ patient_id: adm.patient_id }).where('diagnosed_at', '>=', adm.admitted_at).orderBy('diagnosed_at').select('condition_name', 'severity', 'diagnosed_at');
    const prescriptions = await trx('prescription_items as i').join('prescriptions as p', 'p.id', 'i.prescription_id').join('medicines as m', 'm.id', 'i.medicine_id')
      .where('p.patient_id', adm.patient_id).where('p.created_at', '>=', adm.admitted_at).whereNot('p.status', 'cancelled').select('m.name', 'm.strength', 'i.dosage', 'i.frequency', 'i.duration_days');
    const labs = await trx('lab_requests as l').join('lab_tests as t', 't.id', 'l.lab_test_id').where('l.patient_id', adm.patient_id).where('l.created_at', '>=', adm.admitted_at).whereNot('l.status', 'cancelled').select('t.name', 'l.status', 'l.request_code');
    const transfers = await trx('bed_transfers as t').join('wards as w', 'w.id', 't.to_ward_id').join('beds as b2', 'b2.id', 't.to_bed_id').where('t.admission_id', adm.id).orderBy('t.transferred_at').select('w.name', 'b2.bed_number', 't.transferred_at', 't.reason');

    // UC-21: discharge summary generated and attached to the patient record.
    const content = {
      hospital: env.HOSPITAL_NAME,
      patient: { code: patient.patient_code, name: `${patient.first_name} ${patient.last_name}`, gender: patient.gender, dateOfBirth: patient.date_of_birth },
      admission: { code: adm.admission_code, admittedAt: adm.admitted_at, dischargedAt: now, reason: adm.reason, finalWard: ward.name, finalBed: bed.bed_number },
      attendingDoctor: `${doctor.full_name} (${doctor.specialization})`,
      transfers: transfers.map((t) => ({ to: `${t.name} / ${t.bed_number}`, at: t.transferred_at, reason: t.reason })),
      diagnoses: diagnoses.map((d) => ({ condition: d.condition_name, severity: d.severity, at: d.diagnosed_at })),
      medications: prescriptions.map((p) => `${p.name} ${p.strength} — ${p.dosage}, ${p.frequency}, ${p.duration_days} day(s)`),
      investigations: labs.map((l) => `${l.name} (${l.request_code}) — ${l.status}`),
      finalDiagnosis: b.finalDiagnosis ?? diagnoses.at(-1)?.condition_name ?? null,
      conditionAtDischarge: b.conditionAtDischarge,
      treatmentSummary: b.treatmentSummary ?? adm.discharge_notes ?? null,
      followUpInstructions: b.followUpInstructions ?? null,
      dischargedBy: req.user.fullName,
    };
    await trx('discharge_summaries').insert({
      admission_id: adm.id, patient_id: adm.patient_id, final_diagnosis: content.finalDiagnosis, condition_at_discharge: b.conditionAtDischarge,
      treatment_summary: content.treatmentSummary, follow_up_instructions: content.followUpInstructions, content: JSON.stringify(content), generated_by: req.user.id,
    });
    await trx('admissions').where({ id: adm.id }).update({
      status: 'discharged', discharged_at: now, discharged_by: req.user.id,
      discharge_approved_by: adm.discharge_approved_by ?? req.user.doctorId, discharge_approved_at: adm.discharge_approved_at ?? now,
    });
    await trx('beds').where({ id: bed.id }).update({ status: 'available', updated_at: now });
    await trx('patients').where({ id: patient.id }).update({ status: 'discharged', updated_at: now });
    await trx('visits').where({ admission_id: adm.id, status: 'open' }).update({ status: 'closed', closed_at: now });
    await audit(req, { action: 'admission.discharge', entityType: 'admission', entityId: adm.id, details: { patientCode: patient.patient_code, bed: bed.bed_number } }, trx);
    await notify(trx, { patientId: patient.id, email: true, eventType: 'admission.discharged', title: 'Discharged', message: `You were discharged from ${ward.name} on ${now.toLocaleDateString()}. Your discharge summary is attached to your record.${content.followUpInstructions ? ` Follow-up: ${content.followUpInstructions}` : ''}`, link: '/portal' });
    await notify(trx, { userIds: [doctor.user_id], eventType: 'admission.discharged', title: 'Patient discharged', message: `${patient.first_name} ${patient.last_name} (${patient.patient_code}) was discharged; bed ${bed.bed_number} is free.`, entityType: 'admission', entityId: adm.id });
    bedsChanged(trx);
    return adm;
  });
  return admissionDetail(result.id, req);
}
