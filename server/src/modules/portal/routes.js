// Patient self-service portal (SRS FR-34; UC-48 View Own Info, UC-49 View Own Lab Reports,
// UC-50 View Own Bills). Every query is scoped to req.user.patientId; the portal is read-only
// except for booking/cancelling own appointments (FR-11), which goes through /api/appointments.
import { Router } from 'express';
import { db } from '../../db/knex.js';
import { requirePermission } from '../../middleware/auth.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { toProfile, activeInsurance } from '../patients/service.js';
import { billDetail } from '../billing/service.js';
import { audit } from '../../services/audit.js';
import { validate, idParam } from '../../lib/validate.js';

const router = Router();
router.use(requirePermission('portal.self'));
router.use((req, _res, next) => {
  if (!req.user.patientId) throw forbidden('This account is not linked to a patient record.');
  next();
});

router.get('/me', async (req, res) => {
  const p = await db('patients').where({ id: req.user.patientId }).first();
  const admission = await db('admissions as a').join('wards as w', 'w.id', 'a.ward_id').join('beds as b', 'b.id', 'a.bed_id').where({ 'a.patient_id': p.id, 'a.status': 'active' }).first('a.admission_code', 'a.admitted_at', 'w.name as ward_name', 'b.bed_number');
  const [counts] = await Promise.all([
    db.raw(
      `SELECT (SELECT count(*) FROM appointments WHERE patient_id = :p AND status IN ('scheduled','cancellation_requested') AND appointment_date >= current_date)::int AS upcoming,
              (SELECT count(*) FROM lab_reports WHERE patient_id = :p)::int AS reports,
              (SELECT count(*) FROM lab_requests WHERE patient_id = :p AND status IN ('requested','in_progress','delayed','completed'))::int AS pending_labs,
              (SELECT COALESCE(sum(balance),0) FROM bills WHERE patient_id = :p)::float AS balance`,
      { p: p.id },
    ),
  ]);
  await audit(req, { action: 'portal.profile_view', entityType: 'patient', entityId: p.id });
  res.json({
    profile: toProfile(p, 'full'),
    insurance: await activeInsurance(p.id),
    activeAdmission: admission ? { admissionCode: admission.admission_code, admittedAt: admission.admitted_at, ward: admission.ward_name, bed: admission.bed_number } : null,
    summary: counts.rows[0],
  });
});

// Medical information (read-only): diagnoses, prescriptions and discharge summaries.
router.get('/medical', async (req, res) => {
  const pid = req.user.patientId;
  const [visits, diagnoses, prescriptions, items, summaries] = await Promise.all([
    db('visits as v').join('doctors as d', 'd.id', 'v.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id').where('v.patient_id', pid).orderBy('v.started_at', 'desc')
      .select('v.id', 'v.visit_code', 'v.visit_type', 'v.started_at', 'v.chief_complaint', 'u.full_name as doctor_name', 'd.specialization'),
    db('diagnoses').where({ patient_id: pid }).orderBy('diagnosed_at', 'desc').select('id', 'visit_id', 'condition_name', 'severity', 'diagnosed_at'),
    db('prescriptions').where({ patient_id: pid }).whereNot('status', 'cancelled').orderBy('created_at', 'desc').select('id', 'visit_id', 'prescription_code', 'status', 'created_at'),
    db('prescription_items as i').join('prescriptions as p', 'p.id', 'i.prescription_id').join('medicines as m', 'm.id', 'i.medicine_id').where('p.patient_id', pid).select('i.prescription_id', 'm.name', 'm.strength', 'i.dosage', 'i.frequency', 'i.duration_days', 'i.instructions'),
    db('discharge_summaries').where({ patient_id: pid }).orderBy('generated_at', 'desc'),
  ]);
  res.json({
    visits: visits.map((v) => ({
      id: v.id, visitCode: v.visit_code, visitType: v.visit_type, date: v.started_at, reason: v.chief_complaint, doctor: v.doctor_name, specialization: v.specialization,
      diagnoses: diagnoses.filter((d) => d.visit_id === v.id).map((d) => ({ condition: d.condition_name, severity: d.severity, date: d.diagnosed_at })),
      prescriptions: prescriptions.filter((p) => p.visit_id === v.id).map((p) => ({ code: p.prescription_code, status: p.status, date: p.created_at, items: items.filter((i) => i.prescription_id === p.id).map((i) => ({ medicine: `${i.name} ${i.strength}`, dosage: i.dosage, frequency: i.frequency, days: i.duration_days, instructions: i.instructions })) })),
    })),
    dischargeSummaries: summaries.map((s) => ({ id: s.id, generatedAt: s.generated_at, content: s.content })),
    hasRecords: visits.length > 0,
  });
});

// UC-49: own lab reports; pending tests are listed as "not yet available".
router.get('/lab-reports', async (req, res) => {
  const rows = await db('lab_requests as l').join('lab_tests as t', 't.id', 'l.lab_test_id').leftJoin('lab_reports as r', 'r.lab_request_id', 'l.id')
    .join('doctors as d', 'd.id', 'l.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id')
    .where('l.patient_id', req.user.patientId).whereNot('l.status', 'cancelled').orderBy('l.created_at', 'desc')
    .select('l.id', 'l.request_code', 'l.status', 'l.created_at', 't.name as test_name', 't.category', 'u.full_name as doctor_name', 'r.id as report_id', 'r.uploaded_at', 'r.result_values', 'r.remarks', 'r.mime_type');
  res.json({
    data: rows.map((r) => ({
      id: r.id, requestCode: r.request_code, testName: r.test_name, category: r.category, requestedAt: r.created_at, doctorName: r.doctor_name,
      available: Boolean(r.report_id), status: r.report_id ? 'available' : 'not_yet_available',
      report: r.report_id ? { id: r.report_id, uploadedAt: r.uploaded_at, resultValues: r.result_values, remarks: r.remarks, mimeType: r.mime_type } : null,
    })),
  });
});

// UC-50: own bills (view only).
router.get('/bills', async (req, res) => {
  const bills = await db('bills').where({ patient_id: req.user.patientId }).orderBy('generated_at', 'desc');
  res.json({
    data: bills.map((b) => ({ id: b.id, billNumber: b.bill_number, status: b.status, generatedAt: b.generated_at, subtotal: b.subtotal, insuranceAmount: b.insurance_amount, totalPayable: b.total_payable, amountPaid: b.amount_paid, balance: b.balance })),
  });
});

router.get('/bills/:id', validate({ params: idParam }), async (req, res) => {
  const b = await db('bills').where({ id: req.validParams.id }).first('patient_id');
  if (!b) throw notFound('Bill not found.');
  if (b.patient_id !== req.user.patientId) {
    await audit(req, { action: 'portal.bill_view', entityType: 'bill', entityId: req.validParams.id, status: 'denied' });
    throw forbidden('You can only view your own bills.');
  }
  res.json(await billDetail(req.validParams.id));
});

router.get('/discharge-summaries/:id', validate({ params: idParam }), async (req, res) => {
  const s = await db('discharge_summaries').where({ id: req.validParams.id }).first();
  if (!s || s.patient_id !== req.user.patientId) throw notFound('Discharge summary not found.');
  res.json({ id: s.id, generatedAt: s.generated_at, content: s.content });
});

export default router;
