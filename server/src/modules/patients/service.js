// Patient management (SRS FR-08/09/10, UC-12 Register, UC-13 Update, UC-14 Verify Patient ID).
import { db } from '../../db/knex.js';
import { transaction } from '../../db/tx.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { blindIndex, decrypt, encrypt, generateTempPassword, randomToken, sha256 } from '../../lib/crypto.js';
import { nextCode } from '../../lib/codes.js';
import { ageFrom, todayStr } from '../../lib/dates.js';
import { paginate } from '../../lib/pagination.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notifications.js';
import { hashPassword } from '../auth/service.js';
import { env } from '../../config/env.js';
import { revokeUserSessions } from '../../auth/sessions.js';

const SENSITIVE = { nationalId: 'national_id_enc', address: 'address_enc', allergies: 'allergies_enc', medicalHistory: 'medical_history_enc', currentMedications: 'current_medications_enc' };
const PLAIN = {
  firstName: 'first_name', lastName: 'last_name', dateOfBirth: 'date_of_birth', gender: 'gender', bloodGroup: 'blood_group', maritalStatus: 'marital_status',
  phone: 'phone', email: 'email', city: 'city', emergencyContactName: 'emergency_contact_name', emergencyContactPhone: 'emergency_contact_phone', emergencyContactRelation: 'emergency_contact_relation',
};

export const formatNationalId = (v) => {
  if (!v) return null;
  const digits = String(v).replace(/\D/g, '');
  return digits.length === 13 ? `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}` : String(v).trim();
};
const maskNationalId = (v) => (v ? `*****-*****${v.slice(-3)}` : null);

export function toSummary(r) {
  return {
    id: r.id, patientCode: r.patient_code, firstName: r.first_name, lastName: r.last_name, fullName: `${r.first_name} ${r.last_name}`,
    dateOfBirth: r.date_of_birth, age: ageFrom(r.date_of_birth), gender: r.gender, phone: r.phone, bloodGroup: r.blood_group, status: r.status,
    hasPortalAccount: Boolean(r.user_id), createdAt: r.created_at,
  };
}

/** Full profile. `level`: 'full' (registration staff, the patient) or 'basic' (demographics only). */
export function toProfile(r, level = 'basic') {
  const base = {
    ...toSummary(r), email: r.email, city: r.city, maritalStatus: r.marital_status,
    emergencyContactName: r.emergency_contact_name, emergencyContactPhone: r.emergency_contact_phone, emergencyContactRelation: r.emergency_contact_relation,
    updatedAt: r.updated_at,
  };
  if (level !== 'full') return { ...base, nationalIdMasked: maskNationalId(decrypt(r.national_id_enc)) };
  return {
    ...base,
    nationalId: decrypt(r.national_id_enc), address: decrypt(r.address_enc), allergies: decrypt(r.allergies_enc),
    medicalHistory: decrypt(r.medical_history_enc), currentMedications: decrypt(r.current_medications_enc),
  };
}

/** UC-12 alternative flow: find possible duplicates before registering. */
export async function findDuplicates({ firstName, lastName, dateOfBirth, phone, nationalId }, excludeId = null) {
  const matches = [];
  if (nationalId) {
    const q = db('patients').where({ national_id_hash: blindIndex(formatNationalId(nationalId)) });
    if (excludeId) q.whereNot({ id: excludeId });
    const row = await q.first();
    if (row) matches.push({ reason: 'national_id', blocking: true, patient: toSummary(row) });
  }
  if (firstName && lastName && dateOfBirth) {
    const q = db('patients').whereRaw('lower(first_name) = lower(?) AND lower(last_name) = lower(?)', [firstName.trim(), lastName.trim()]).where({ date_of_birth: dateOfBirth });
    if (excludeId) q.whereNot({ id: excludeId });
    for (const row of await q.limit(5)) if (!matches.some((m) => m.patient.id === row.id)) matches.push({ reason: 'name_dob', blocking: false, patient: toSummary(row) });
  }
  if (phone && dateOfBirth) {
    const q = db('patients').where({ phone: phone.trim(), date_of_birth: dateOfBirth });
    if (excludeId) q.whereNot({ id: excludeId });
    for (const row of await q.limit(5)) if (!matches.some((m) => m.patient.id === row.id)) matches.push({ reason: 'phone_dob', blocking: false, patient: toSummary(row) });
  }
  return matches;
}

function columnsFrom(data) {
  const cols = {};
  for (const [k, col] of Object.entries(PLAIN)) if (data[k] !== undefined) cols[col] = data[k];
  for (const [k, col] of Object.entries(SENSITIVE)) {
    if (data[k] === undefined) continue;
    const value = k === 'nationalId' ? formatNationalId(data[k]) : data[k];
    cols[col] = encrypt(value);
    if (k === 'nationalId') cols.national_id_hash = value ? blindIndex(value) : null;
  }
  return cols;
}

async function createPortalAccount(req, trx, patient, email) {
  if (!email) throw new AppError(422, 'An email address is required to create a portal account.', { fields: { email: 'Required for portal access.' } });
  const normalizedEmail = String(email).trim().toLowerCase();
  if (await trx('users').whereRaw('LOWER(email) = LOWER(?)', [normalizedEmail]).whereNull('deleted_at').first()) {
    throw conflict('This email address is already used by another account.', { fields: { email: 'This email address is already in use.' } });
  }
  const role = await trx('roles').where({ code: 'patient' }).first();
  const tempPassword = generateTempPassword();
  const username = patient.patient_code; // patients sign in with their patient ID
  const [user] = await trx('users').insert({
    username, email, full_name: `${patient.first_name} ${patient.last_name}`, phone: patient.phone, role_id: role.id,
    password_hash: await hashPassword(tempPassword), must_change_password: true, created_by: req.user.id,
  }).returning('*');
  await trx('patients').where({ id: patient.id }).update({ user_id: user.id });
  const token = randomToken(32);
  await trx('password_reset_tokens').insert({ user_id: user.id, token_hash: sha256(token), expires_at: new Date(Date.now() + env.RESET_TOKEN_HOURS * 3600_000) });
  await notify(trx, {
    userIds: [user.id], inApp: false, email: true, secretLink: true, eventType: 'portal.account_created', title: 'Your patient portal account',
    message: `Your patient portal account is ready.\nPatient ID / username: ${username}\nUse the link below to choose your password (valid ${env.RESET_TOKEN_HOURS} hours), or sign in with the temporary password given to you at reception.`,
    link: `/reset-password/${token}`,
  });
  await audit(req, { action: 'patient.portal_enabled', entityType: 'patient', entityId: patient.id, details: { userId: user.id } }, trx);
  return { username, tempPassword };
}

export async function registerPatient(req, data) {
  const dupes = await findDuplicates(data);
  const blocking = dupes.find((d) => d.blocking);
  if (blocking) {
    throw conflict(`A patient with this national ID is already registered (${blocking.patient.patientCode}).`, { code: 'DUPLICATE_PATIENT', fields: { nationalId: 'Already registered to another patient.' }, details: { matches: dupes } });
  }
  if (dupes.length && !data.confirmDuplicate) {
    // UC-12 2-A: warn and ask for confirmation.
    throw conflict('A patient with the same name and date of birth (or phone) already exists. Review the matches and confirm if this is a different person.', { code: 'POSSIBLE_DUPLICATE', details: { matches: dupes } });
  }
  if (dupes.length && !data.duplicateReason) {
    throw new AppError(422, 'Explain why this is a different person.', { fields: { duplicateReason: 'Explain why this is a different person.' } });
  }

  return transaction(async (trx) => {
    const code = await nextCode(trx, 'patient_code_seq');
    const [patient] = await trx('patients').insert({
      patient_code: code, ...columnsFrom(data), status: 'out_patient', created_by: req.user.id,
      duplicate_override_reason: dupes.length ? data.duplicateReason : null,
    }).returning('*');
    await audit(req, { action: 'patient.create', entityType: 'patient', entityId: patient.id, details: { patientCode: code, duplicateOverride: dupes.length > 0 } }, trx);
    let portal = null;
    if (data.createPortalAccount) portal = await createPortalAccount(req, trx, patient, data.email);
    const fresh = await trx('patients').where({ id: patient.id }).first();
    return { patient: toProfile(fresh, 'full'), portal };
  });
}

export async function updatePatient(req, id, data) {
  return transaction(async (trx) => {
    const current = await trx('patients').where({ id }).forUpdate().first();
    if (!current) throw notFound('Patient not found. Check the patient ID or register the patient.');
    const merged = { firstName: current.first_name, lastName: current.last_name, dateOfBirth: current.date_of_birth, phone: current.phone, ...data };
    const dupes = (await findDuplicates({ ...merged, nationalId: data.nationalId }, id)).filter((d) => d.blocking);
    if (dupes.length) throw conflict('Another patient is already registered with this national ID.', { fields: { nationalId: 'Already registered to another patient.' } });

    const cols = columnsFrom(data);
    const changed = [];
    for (const [k, col] of Object.entries(PLAIN)) if (data[k] !== undefined && String(current[col] ?? '') !== String(cols[col] ?? '')) changed.push({ field: k, from: current[col], to: cols[col] });
    for (const [k, col] of Object.entries(SENSITIVE)) {
      if (data[k] === undefined) continue;
      const before = decrypt(current[col]) ?? '';
      const after = (k === 'nationalId' ? formatNationalId(data[k]) : data[k]) ?? '';
      if (before !== after) changed.push({ field: k, sensitive: true }); // values not written to the log
    }
    if (!changed.length) return toProfile(current, 'full');
    const [row] = await trx('patients').where({ id }).update({ ...cols, updated_at: new Date() }).returning('*');
    // UC-13: every change is logged with the date and time of the update.
    await audit(req, { action: 'patient.update', entityType: 'patient', entityId: id, details: { changes: changed } }, trx);
    return toProfile(row, 'full');
  });
}

export async function searchPatients({ q, status, page, pageSize }) {
  const query = db('patients').select('*').orderBy('created_at', 'desc');
  if (q) {
    const term = q.trim();
    const hash = /\d{5}-?\d{7}-?\d/.test(term) ? blindIndex(formatNationalId(term)) : null;
    query.where((w) => {
      w.whereILike('patient_code', `%${term}%`)
        .orWhereRaw("lower(first_name || ' ' || last_name) LIKE lower(?)", [`%${term}%`])
        .orWhereRaw("regexp_replace(phone, '\\D', '', 'g') LIKE ?", [`%${term.replace(/\D/g, '') || '~'}%`]);
      if (hash) w.orWhere('national_id_hash', hash);
    });
  }
  if (status) query.where({ status });
  const result = await paginate(query, { page, pageSize });
  return { ...result, data: result.data.map(toSummary) };
}

/** UC-14: verify a patient ID (target < 2 s; indexed unique lookup). */
export async function verifyPatientCode(code) {
  const started = process.hrtime.bigint();
  const row = await db('patients').whereRaw('upper(patient_code) = upper(?)', [code.trim()]).first();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (!row) return { valid: false, message: 'Invalid patient ID. Please check and re-enter it.', lookupMs: Math.round(ms) };
  return { valid: true, patient: toSummary(row), lookupMs: Math.round(ms) };
}

export async function getPatientRow(id, conn = db) {
  const row = await conn('patients').where({ id }).first();
  if (!row) throw notFound('Patient not found.');
  return row;
}

export async function patientOverview(id) {
  const row = await getPatientRow(id);
  const [appointments, admission, balance, insurance] = await Promise.all([
    db('appointments as a').join('doctors as d', 'd.id', 'a.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id')
      .where('a.patient_id', id).orderBy([{ column: 'a.appointment_date', order: 'desc' }, { column: 'a.start_time', order: 'desc' }]).limit(10)
      .select('a.id', 'a.appointment_code', 'a.appointment_date', 'a.start_time', 'a.status', 'a.token_number', 'u.full_name as doctor_name', 'd.specialization'),
    db('admissions as ad').join('wards as w', 'w.id', 'ad.ward_id').join('beds as b', 'b.id', 'ad.bed_id').where({ 'ad.patient_id': id, 'ad.status': 'active' })
      .first('ad.id', 'ad.admission_code', 'ad.admitted_at', 'w.name as ward_name', 'b.bed_number', 'ad.discharge_approved_at'),
    db('bills').where({ patient_id: id }).sum({ balance: 'balance' }).first(),
    activeInsurance(id),
  ]);
  return {
    appointments: appointments.map((a) => ({ id: a.id, appointmentCode: a.appointment_code, date: a.appointment_date, startTime: a.start_time.slice(0, 5), status: a.status, tokenNumber: a.token_number, doctorName: a.doctor_name, specialization: a.specialization })),
    activeAdmission: admission ? { id: admission.id, admissionCode: admission.admission_code, admittedAt: admission.admitted_at, wardName: admission.ward_name, bedNumber: admission.bed_number, dischargeApproved: Boolean(admission.discharge_approved_at) } : null,
    outstandingBalance: Number(balance?.balance ?? 0),
    insurance,
    status: row.status,
  };
}

export async function changeHistory(id) {
  const rows = await db('audit_logs').where({ entity_type: 'patient', entity_id: String(id) }).whereIn('action', ['patient.create', 'patient.update', 'patient.portal_enabled', 'patient.portal_disabled', 'patient.insurance_add']).orderBy('created_at', 'desc').limit(100);
  return rows.map((r) => ({ id: r.id, action: r.action, by: r.username, at: r.created_at, details: r.details }));
}

// ----------------------------------------------------------------- insurance
export async function activeInsurance(patientId, conn = db) {
  const rows = await conn('patient_insurance as pi').join('insurance_providers as ip', 'ip.id', 'pi.provider_id').where('pi.patient_id', patientId).orderBy('pi.created_at', 'desc')
    .select('pi.*', 'ip.name as provider_name', 'ip.is_active as provider_active', 'ip.max_coverage_amount');
  return rows.map((r) => ({
    id: r.id, providerId: r.provider_id, providerName: r.provider_name, policyNumberMasked: r.policy_number_last4 ? `••••${r.policy_number_last4}` : null,
    coveragePercent: r.coverage_percent, maxCoverageAmount: r.max_coverage_amount, validFrom: r.valid_from, validUntil: r.valid_until, isActive: r.is_active,
    expired: r.valid_until < todayStr(), providerActive: r.provider_active,
  }));
}

export async function addInsurance(req, patientId, data) {
  await getPatientRow(patientId);
  const provider = await db('insurance_providers').where({ id: data.providerId, is_active: true }).first();
  if (!provider) throw new AppError(422, 'Select an accepted insurance provider.', { fields: { providerId: 'Select an accepted insurance provider.' } });
  if (provider.policy_number_pattern && !new RegExp(provider.policy_number_pattern).test(data.policyNumber)) {
    throw new AppError(422, `Policy number format is not valid for ${provider.name}.`, { fields: { policyNumber: 'Policy number format is not valid for this provider.' } });
  }
  if (data.validUntil < data.validFrom) throw new AppError(422, 'Expiry must be after the start date.', { fields: { validUntil: 'Expiry must be after the start date.' } });
  return transaction(async (trx) => {
    await trx('patient_insurance').where({ patient_id: patientId, is_active: true }).update({ is_active: false });
    const [row] = await trx('patient_insurance').insert({
      patient_id: patientId, provider_id: provider.id, policy_number_enc: encrypt(data.policyNumber), policy_number_last4: data.policyNumber.slice(-4),
      coverage_percent: data.coveragePercent ?? provider.default_coverage_percent, valid_from: data.validFrom, valid_until: data.validUntil,
    }).returning('*');
    await audit(req, { action: 'patient.insurance_add', entityType: 'patient', entityId: patientId, details: { provider: provider.name } }, trx);
    return row;
  });
}

// ----------------------------------------------------------------- portal access
export async function enablePortal(req, patientId, email) {
  return transaction(async (trx) => {
    const patient = await trx('patients').where({ id: patientId }).forUpdate().first();
    if (!patient) throw notFound('Patient not found.');
    if (patient.user_id) {
      const u = await trx('users').where({ id: patient.user_id }).first();
      if (u?.status === 'active') throw conflict('This patient already has a portal account.');
      if (u?.status === 'inactive') {
        // Re-enable a previously disabled account with a fresh temporary password.
        const tempPassword = generateTempPassword();
        await trx('users').where({ id: u.id }).update({ status: 'active', password_hash: await hashPassword(tempPassword), must_change_password: true, locked_until: null, failed_login_count: 0, updated_at: new Date() });
        await audit(req, { action: 'patient.portal_enabled', entityType: 'patient', entityId: patientId, details: { userId: u.id, reactivated: true } }, trx);
        return { username: u.username, tempPassword };
      }
    }
    const mail = email || patient.email;
    if (email && email !== patient.email) await trx('patients').where({ id: patientId }).update({ email });
    return createPortalAccount(req, trx, patient, mail);
  });
}

export async function disablePortal(req, patientId) {
  const patient = await getPatientRow(patientId);
  if (!patient.user_id) throw badRequest('This patient does not have a portal account.');
  await transaction(async (trx) => {
    await trx('users').where({ id: patient.user_id }).update({ status: 'inactive', updated_at: new Date() });
    await revokeUserSessions(patient.user_id, 'portal_disabled', trx);
    await audit(req, { action: 'patient.portal_disabled', entityType: 'patient', entityId: patientId }, trx);
  });
}
