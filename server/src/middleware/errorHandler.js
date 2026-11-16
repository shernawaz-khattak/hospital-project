// Converts every error into a safe JSON response. Raw database errors are never shown
// to users (requirement §28); known constraint violations are mapped to clear messages.
import multer from 'multer';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { randomToken } from '../lib/crypto.js';

const CONSTRAINT_MESSAGES = {
  users_username_active_uq: ['This username is already taken. Please choose a different username.', 'username'],
  users_email_active_uq: ['This email address is already used by another account.', 'email'],
  departments_name_key: ['A department with this name already exists.', 'name'],
  departments_code_key: ['A department with this code already exists.', 'code'],
  doctors_doctor_code_key: ['This doctor ID is already in use.', 'doctorCode'],
  doctors_license_number_key: ['This license number is already registered to another doctor.', 'licenseNumber'],
  staff_employee_code_key: ['This employee code is already in use.', 'employeeCode'],
  patients_national_id_hash_key: ['A patient with this national ID (CNIC) is already registered.', 'nationalId'],
  appt_doctor_slot_uq: ['This appointment slot is already booked.', 'startTime'],
  appt_patient_slot_uq: ['This patient already has an appointment at this time.', 'startTime'],
  appt_token_uq: ['Token number conflict, please try again.', null],
  admissions_patient_active_uq: ['This patient is already admitted.', 'patientId'],
  admissions_bed_active_uq: ['This bed is already occupied. Please choose another bed.', 'bedId'],
  wards_name_key: ['A ward with this name already exists.', 'name'],
  beds_ward_id_bed_number_key: ['This bed number already exists in the ward.', 'bedNumber'],
  medicines_identity_uq: ['This medicine (name, strength and form) already exists.', 'name'],
  medicine_batches_medicine_id_batch_number_key: ['This batch number already exists for the medicine.', 'batchNumber'],
  lab_tests_code_key: ['A lab test with this code already exists.', 'code'],
  insurance_providers_name_key: ['This insurance provider already exists.', 'name'],
  bill_items_source_uq: ['One of these services has already been billed.', null],
  waitlist_open_uq: ['This patient is already on the waitlist for this doctor and date.', null],
  cancel_req_pending_uq: ['A cancellation request is already awaiting approval for this appointment.', null],
  staffing_levels_department_id_role_id_key: ['A staffing level for this department and role already exists.', 'roleId'],
  doctor_schedules_doctor_id_weekday_start_time_key: ['This schedule block already exists.', null],
  medicine_batches_quantity_check: ['Stock cannot go below zero.', 'quantity'],
  bills_not_overpaid: ['Payment exceeds the outstanding balance.', 'amount'],
  stock_alerts_open_uq: ['An open alert already exists for this medicine.', null],
};

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { message: 'The requested resource was not found.', code: 'NOT_FOUND' } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { message: err.message, code: err.code, fields: err.fields, details: err.details } });
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large.' : 'The file could not be uploaded.';
    return res.status(400).json({ error: { message, code: err.code, fields: { file: message } } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'The request body is not valid JSON.', code: 'BAD_JSON' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: 'The request is too large.', code: 'TOO_LARGE' } });
  }
  // PostgreSQL errors
  if (err?.code === '23505' || err?.code === '23514') {
    const mapped = CONSTRAINT_MESSAGES[err.constraint];
    const message = mapped?.[0] ?? (err.code === '23505' ? 'This record already exists.' : 'Some of the values entered are not valid.');
    const fields = mapped?.[1] ? { [mapped[1]]: message } : undefined;
    return res.status(err.code === '23505' ? 409 : 422).json({ error: { message, code: err.code === '23505' ? 'DUPLICATE' : 'INVALID', fields } });
  }
  if (err?.code === '23503') {
    return res.status(409).json({ error: { message: 'This record is linked to other records and cannot be changed this way.', code: 'IN_USE' } });
  }
  if (err?.code === 'P0001') {
    return res.status(409).json({ error: { message: 'This record is read-only and cannot be changed or deleted.', code: 'READ_ONLY' } });
  }
  if (err?.code === '40001' || err?.code === '40P01') {
    return res.status(409).json({ error: { message: 'Another user changed this record at the same time. Please try again.', code: 'RETRY' } });
  }
  const ref = randomToken(6);
  logger.error(`Unhandled error [ref ${ref}] ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({ error: { message: `Something went wrong. Please try again or contact support (ref ${ref}).`, code: 'INTERNAL' } });
}
