// Doctor ↔ patient care relationship (SRS UC-32: "Doctors can view reports of their patients").
// A doctor may open a patient's clinical record when any of these exist:
//   an appointment, a visit, an admission (attending), a lab request or an admission request
//   with that doctor — or an unexpired, audited emergency-access grant.
import { db } from '../../db/knex.js';
import { forbidden } from '../../lib/errors.js';

export async function hasCareRelationship(doctorId, patientId, conn = db) {
  if (!doctorId) return false;
  const { rows } = await conn.raw(
    `SELECT (
        EXISTS (SELECT 1 FROM appointments WHERE doctor_id = :d AND patient_id = :p AND status NOT IN ('cancelled'))
     OR EXISTS (SELECT 1 FROM visits WHERE doctor_id = :d AND patient_id = :p)
     OR EXISTS (SELECT 1 FROM admissions WHERE attending_doctor_id = :d AND patient_id = :p)
     OR EXISTS (SELECT 1 FROM lab_requests WHERE doctor_id = :d AND patient_id = :p)
     OR EXISTS (SELECT 1 FROM admission_requests WHERE doctor_id = :d AND patient_id = :p)
     OR EXISTS (SELECT 1 FROM emergency_access_grants WHERE doctor_id = :d AND patient_id = :p AND expires_at > now())
     ) AS ok`,
    { d: doctorId, p: patientId },
  );
  return rows[0].ok;
}

export async function assertCareAccess(req, patientId, conn = db) {
  if (!req.user.doctorId) throw forbidden('Only doctors can open clinical records.');
  if (!(await hasCareRelationship(req.user.doctorId, patientId, conn))) {
    throw forbidden('This patient is not under your care. Use emergency access (with a reason) if you must view this record.', { code: 'NO_CARE_RELATIONSHIP' });
  }
}
