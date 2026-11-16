// Laboratory (SRS FR-21, FR-22; UC-30 Process, UC-31 Upload, UC-32 View, UC-33 Notify).
import crypto from 'node:crypto';
import { db } from '../../db/knex.js';
import { transaction } from '../../db/tx.js';
import { env } from '../../config/env.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { ageFrom } from '../../lib/dates.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notifications.js';
import { publishToPermission } from '../../services/realtime.js';
import { hasCareRelationship } from '../clinical/access.js';
import { uploadStorage, createStorageForProvider } from '../../services/storage/index.js';
import { patientReportKey } from '../../services/storage/objectKey.js';
import { cleanupOrphan } from '../../services/storageReconciliation.js';
import { registerObjectReference } from '../../services/storageLifecycle.js';

const URGENCY_ORDER = "CASE l.urgency WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END";

const requestSelect = [
  'l.*', 't.name as test_name', 't.code as test_code', 't.category', 't.sample_type', 't.parameters as test_parameters', 't.turnaround_hours',
  'p.patient_code', 'p.first_name', 'p.last_name', 'p.gender', 'p.date_of_birth', 'du.full_name as doctor_name', 'du.id as doctor_user_id', 'tu.full_name as technician_name',
  'r.id as report_id', 'r.uploaded_at', 'r.original_name', 'r.mime_type', 'r.file_size', 'r.result_values', 'r.remarks', 'ru.full_name as uploaded_by_name',
];
const requestQuery = (conn = db) =>
  conn('lab_requests as l').join('lab_tests as t', 't.id', 'l.lab_test_id').join('patients as p', 'p.id', 'l.patient_id')
    .join('doctors as d', 'd.id', 'l.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as du', 'du.id', 's.user_id')
    .leftJoin('users as tu', 'tu.id', 'l.technician_id').leftJoin('lab_reports as r', 'r.lab_request_id', 'l.id').leftJoin('users as ru', 'ru.id', 'r.uploaded_by');

export function toDto(l) {
  const ageMin = Math.round((Date.now() - new Date(l.created_at).getTime()) / 60000);
  return {
    id: l.id, requestCode: l.request_code, status: l.status, urgency: l.urgency, clinicalNotes: l.clinical_notes, parameters: l.parameters, specialInstructions: l.special_instructions,
    createdAt: l.created_at, startedAt: l.started_at, completedAt: l.completed_at, processingMinutes: l.processing_minutes, delayReason: l.delay_reason, delayedAt: l.delayed_at, waitingMinutes: ageMin,
    overdue: !['reported', 'cancelled'].includes(l.status) && ageMin > l.turnaround_hours * 60,
    test: { id: l.lab_test_id, name: l.test_name, code: l.test_code, category: l.category, sampleType: l.sample_type, parameters: l.test_parameters, turnaroundHours: l.turnaround_hours },
    patient: { id: l.patient_id, patientCode: l.patient_code, fullName: `${l.first_name} ${l.last_name}`, gender: l.gender, age: ageFrom(l.date_of_birth) },
    doctor: { id: l.doctor_id, fullName: l.doctor_name }, technicianName: l.technician_name,
    report: l.report_id ? { id: l.report_id, uploadedAt: l.uploaded_at, originalName: l.original_name, mimeType: l.mime_type, fileSize: l.file_size, resultValues: l.result_values, remarks: l.remarks, uploadedByName: l.uploaded_by_name } : null,
  };
}

export async function listRequests({ status, urgency, q, patientId, page = 1, pageSize = 50 }) {
  const query = requestQuery();
  if (status === 'pending') query.whereIn('l.status', ['requested', 'in_progress', 'delayed']);
  else if (status === 'ready') query.where('l.status', 'completed');
  else if (status && status !== 'all') query.whereIn('l.status', status.split(','));
  if (urgency) query.where('l.urgency', urgency);
  if (patientId) query.where('l.patient_id', patientId);
  if (q) query.where((w) => w.whereILike('l.request_code', `%${q}%`).orWhereILike('p.patient_code', `%${q}%`).orWhereRaw("lower(p.first_name || ' ' || p.last_name) like lower(?)", [`%${q}%`]).orWhereILike('t.name', `%${q}%`));
  const total = await query.clone().count({ n: '*' }).first();
  const rows = await query.select(requestSelect).orderByRaw(status === 'pending' ? `${URGENCY_ORDER}, l.created_at` : 'l.created_at DESC').offset((page - 1) * pageSize).limit(pageSize);
  return { data: rows.map(toDto), total: Number(total.n), page, pageSize };
}

export async function getRequest(id, conn = db) {
  const row = await requestQuery(conn).where('l.id', id).first(requestSelect);
  if (!row) throw notFound('Lab request not found.');
  return row;
}

async function transition(req, id, from, patch, action, details) {
  return transaction(async (trx) => {
    const lr = await trx('lab_requests').where({ id }).forUpdate().first();
    if (!lr) throw notFound('Lab request not found.');
    if (!from.includes(lr.status)) throw conflict(`This request is ${lr.status.replace('_', ' ')} and cannot be ${action.split('.').pop().replace('_', ' ')}.`);
    const values = typeof patch === 'function' ? patch(lr) : patch;
    await trx('lab_requests').where({ id }).update(values);
    await audit(req, { action, entityType: 'lab_request', entityId: id, details }, trx);
    trx.afterCommit(() => publishToPermission(['lab.process'], 'lab.changed', { id }));
    return lr;
  });
}

/** UC-30 step 4: In Progress */
export const startProcessing = (req, id) =>
  transition(req, id, ['requested', 'delayed'], (lr) => ({ status: 'in_progress', started_at: lr.started_at ?? new Date(), technician_id: req.user.id, delay_reason: lr.status === 'delayed' ? lr.delay_reason : null }), 'lab.start');

/** UC-30 1-A: materials unavailable -> alert technician, notify requesting doctor of the delay. */
export async function markDelayed(req, id, reason) {
  const lr = await transition(req, id, ['requested', 'in_progress'], { status: 'delayed', delay_reason: reason, delayed_at: new Date() }, 'lab.delay', { reason });
  const r = await getRequest(id);
  await notify(db, { userIds: [r.doctor_user_id], priority: 'high', eventType: 'lab.delayed', title: 'Lab test delayed', message: `${r.test_name} (${r.request_code}) for ${r.first_name} ${r.last_name} is delayed: ${reason}`, link: `/doctor/patients/${lr.patient_id}`, entityType: 'lab_request', entityId: id });
}

/** UC-30 step 6: Completed, processing time recorded. */
export const completeProcessing = (req, id) =>
  transition(req, id, ['in_progress'], (lr) => {
    const now = new Date();
    return { status: 'completed', completed_at: now, processing_minutes: Math.max(0, Math.round((now - new Date(lr.started_at)) / 60000)) };
  }, 'lab.complete');

// UC-31: PDF or image only — validated by the file's actual content (magic bytes), not its name.
const SIGNATURES = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];
export const detectFileType = (buffer) => SIGNATURES.find((s) => buffer?.length > 8 && s.test(buffer)) ?? null;

export async function uploadReport(req, id, file, { resultValues, remarks }) {
  if (!file) throw new AppError(422, 'Choose the report file to upload.', { fields: { file: 'A PDF or image file is required.' } });
  const type = detectFileType(file.buffer);
  if (!type) {
    await audit(req, { action: 'lab.report_upload', entityType: 'lab_request', entityId: id, status: 'failure', details: { reason: 'invalid_format', name: file.originalname } });
    throw new AppError(422, 'Invalid file format. Upload the report as a PDF, PNG or JPEG file.', { code: 'INVALID_FILE', fields: { file: 'Only PDF, PNG or JPEG files are accepted.' } });
  }
  const lr0 = await getRequest(id);
  if (lr0.status !== 'completed') throw conflict(lr0.status === 'reported' ? 'A report has already been uploaded for this request.' : 'Complete the test before uploading the report.');

  const storageKey = patientReportKey(lr0.patient_id, type.ext);
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  let uploaded = false;

  try {
    await uploadStorage().put(storageKey, file.buffer, { contentType: type.mime, sha256: sha, userMetadata: { patientId: String(lr0.patient_id) } });
    uploaded = true;
    await transaction(async (trx) => {
      const lr = await trx('lab_requests').where({ id }).forUpdate().first();
      if (lr.status !== 'completed') throw conflict('This request is no longer awaiting a report.');
      await registerObjectReference(trx, {
        provider: env.STORAGE_PROVIDER,
        bucket: env.STORAGE_PROVIDER === 'r2' ? env.R2_BUCKET_UPLOADS : env.UPLOAD_DIR,
        objectKey: storageKey,
      });
      const [report] = await trx('lab_reports').insert({
        lab_request_id: id, patient_id: lr.patient_id, file_path: storageKey, storage_provider: env.STORAGE_PROVIDER, storage_key: storageKey, storage_bucket: env.STORAGE_PROVIDER === 'r2' ? env.R2_BUCKET_UPLOADS : null, storage_status: 'ready',
        original_name: file.originalname.slice(0, 200), mime_type: type.mime, file_size: file.size, sha256: sha,
        result_values: JSON.stringify(resultValues ?? []), remarks, uploaded_by: req.user.id,
      }).returning('*');
      await trx('lab_requests').where({ id }).update({ status: 'reported' });
      await audit(req, { action: 'lab.report_upload', entityType: 'lab_request', entityId: id, details: { reportId: report.id, mime: type.mime, size: file.size } }, trx);
      // UC-33: notify the requesting doctor and the patient (email retried up to 3 times).
      await notify(trx, { userIds: [lr0.doctor_user_id], priority: lr.urgency === 'routine' ? 'normal' : 'high', eventType: 'lab.report_ready', title: 'Lab report ready', message: `${lr0.test_name} (${lr0.request_code}) for ${lr0.first_name} ${lr0.last_name} is ready.`, link: `/doctor/patients/${lr.patient_id}`, entityType: 'lab_report', entityId: report.id });
      await notify(trx, { patientId: lr.patient_id, email: true, eventType: 'lab.report_ready', title: 'Your lab report is ready', message: `Your ${lr0.test_name} report (${lr0.request_code}) is now available in the patient portal.`, link: '/portal/lab-reports', entityType: 'lab_report', entityId: report.id });
    });
  } catch (err) {
    if (uploaded) {
      await cleanupOrphan({
        provider: env.STORAGE_PROVIDER,
        bucket: env.STORAGE_PROVIDER === 'r2' ? env.R2_BUCKET_UPLOADS : env.UPLOAD_DIR,
        objectKey: storageKey,
        operation: 'lab_report_upload',
        failureReason: err.message,
      });
    }
    throw err;
  }
  return toDto(await getRequest(id));
}

/** UC-32 / UC-49: only the lab, the patient's doctors and the patient may open a report. */
export async function authorizeReportAccess(req, report) {
  if (req.user.permissions.includes('lab.process')) return;
  if (req.user.patientId && req.user.patientId === report.patient_id && req.user.permissions.includes('portal.self')) return;
  if (req.user.doctorId && req.user.permissions.includes('clinical.view') && (await hasCareRelationship(req.user.doctorId, report.patient_id))) return;
  await audit(req, { action: 'lab.report_view', entityType: 'lab_report', entityId: report.id, status: 'denied' });
  throw forbidden('You do not have permission to view this report.');
}

export async function reportFile(req, reportId) {
  const report = await db('lab_reports').where({ id: reportId }).first();
  if (!report) throw notFound('Report not found.');
  await authorizeReportAccess(req, report);
  await audit(req, { action: 'lab.report_view', entityType: 'lab_report', entityId: report.id });
  const legacy = !report.storage_key;
  const provider = legacy ? (report.storage_provider ?? 'local') : report.storage_provider;
  if (!['local', 'r2'].includes(provider)) {
    throw new AppError(503, 'This historical report storage provider cannot be resolved safely.', { code: 'LEGACY_STORAGE_UNKNOWN' });
  }
  const storage = legacy
    ? createStorageForProvider(provider, provider === 'r2' ? report.storage_bucket : env.UPLOAD_DIR, report.storage_bucket)
    : provider === env.STORAGE_PROVIDER ? uploadStorage() : createStorageForProvider(provider, provider === 'r2' ? report.storage_bucket : env.UPLOAD_DIR, report.storage_bucket);
  const key = legacy ? report.file_path : report.storage_key;
  const object = await storage.get(key);
  return { stream: object.stream, metadata: object.metadata, report };
}

// ----------------------------------------------------------------- test catalogue
const testDto = (t) => ({ id: t.id, code: t.code, name: t.name, category: t.category, sampleType: t.sample_type, price: t.price, turnaroundHours: t.turnaround_hours, parameters: t.parameters, isAvailable: t.is_available });
export const listTests = async ({ includeUnavailable = true } = {}) => (await db('lab_tests').modify((q) => !includeUnavailable && q.where('is_available', true)).orderBy(['category', 'name'])).map(testDto);

export async function saveTest(req, id, b) {
  const values = { code: b.code, name: b.name, category: b.category, sample_type: b.sampleType, price: b.price, turnaround_hours: b.turnaroundHours, parameters: JSON.stringify(b.parameters), is_available: b.isAvailable ?? true };
  const [row] = id ? await db('lab_tests').where({ id }).update(values).returning('*') : await db('lab_tests').insert(values).returning('*');
  if (!row) throw notFound('Lab test not found.');
  await audit(req, { action: id ? 'lab.test_update' : 'lab.test_create', entityType: 'lab_test', entityId: row.id, details: { code: row.code } });
  return testDto(row);
}
