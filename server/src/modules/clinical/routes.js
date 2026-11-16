import { Router } from 'express';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import * as svc from './service.js';

const router = Router();

const optNum = (min, max, label) =>
  z.preprocess(
    (x) => (x === '' || x === null || x === undefined ? null : x),
    z.coerce.number({ invalid_type_error: `${label} must be a number.` }).min(min, `${label} must be between ${min} and ${max}.`).max(max, `${label} must be between ${min} and ${max}.`).nullable(),
  );

// UC-26: invalid vital values are rejected with a message for the specific field.
const observationBody = z
  .object({
    temperatureC: optNum(30, 45, 'Temperature (°C)'),
    pulseBpm: optNum(20, 250, 'Pulse'),
    systolicBp: optNum(50, 260, 'Systolic BP'),
    diastolicBp: optNum(30, 160, 'Diastolic BP'),
    respiratoryRate: optNum(4, 60, 'Respiratory rate'),
    spo2: optNum(50, 100, 'SpO₂'),
    weightKg: optNum(0.3, 400, 'Weight'),
    heightCm: optNum(20, 260, 'Height'),
    bloodGlucose: optNum(10, 900, 'Blood glucose'),
    symptoms: v.optionalText(1000),
    notes: v.optionalText(2000),
  })
  .refine((o) => Object.values(o).some((x) => x !== null && x !== undefined), { message: 'Enter at least one vital sign or symptom.', path: ['symptoms'] })
  .refine((o) => o.systolicBp == null || o.diastolicBp == null || o.systolicBp > o.diastolicBp, { message: 'Systolic must be higher than diastolic.', path: ['diastolicBp'] })
  .refine((o) => (o.systolicBp == null) === (o.diastolicBp == null), { message: 'Enter both systolic and diastolic values.', path: ['diastolicBp'] });

const rxItems = z
  .array(
    z.object({
      medicineId: v.id(),
      dosage: v.text(60, 'Dosage'),
      frequency: v.text(60, 'Frequency'),
      durationDays: z.coerce.number({ invalid_type_error: 'Enter the duration in days.' }).int().min(1, 'Duration must be at least 1 day.').max(365, 'Duration cannot exceed 365 days.'),
      quantity: z.coerce.number({ invalid_type_error: 'Enter a quantity.' }).int().min(1, 'Quantity must be at least 1.').max(1000, 'Quantity is too large.'),
      instructions: v.optionalText(300),
    }),
  )
  .min(1, 'Add at least one medicine.')
  .max(20);

router.use(requirePermission('clinical.view', 'clinical.record'));

router.get('/patients', async (req, res) => res.json({ data: await svc.myPatients(req, { q: req.query.q ? String(req.query.q).slice(0, 80) : undefined }) }));
router.get('/patients/:id/history', validate({ params: idParam }), async (req, res) => res.json(await svc.patientHistory(req, req.validParams.id)));
router.get('/patients/:id/diagnoses', validate({ params: idParam }), async (req, res) => res.json({ data: await svc.diagnosisLog(req, req.validParams.id) }));
router.post('/patients/:id/emergency-access', validate({ params: idParam, body: z.object({ reason: z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(500) }) }), async (req, res) => {
  res.status(201).json(await svc.grantEmergencyAccess(req, req.validParams.id, req.body.reason));
});

router.post(
  '/visits',
  requirePermission('clinical.record'),
  validate({ body: z.object({ patientId: v.id(), appointmentId: z.coerce.number().int().positive().optional(), visitType: z.enum(['opd', 'ipd', 'emergency']).default('opd'), chiefComplaint: v.optionalText(500), emergencyReason: v.optionalText(500) }) }),
  async (req, res) => res.status(201).json(await svc.startVisit(req, req.body)),
);
router.get('/visits/:id', validate({ params: idParam }), async (req, res) => res.json(await svc.getVisit(req, req.validParams.id)));
router.patch('/visits/:id', requirePermission('clinical.record'), validate({ params: idParam, body: z.object({ chiefComplaint: v.optionalText(500), notes: v.optionalText(5000) }) }), async (req, res) => {
  await svc.updateVisitNotes(req, req.validParams.id, req.body);
  res.json({ ok: true });
});
router.post('/visits/:id/close', requirePermission('clinical.record'), validate({ params: idParam, body: z.object({ notes: v.optionalText(5000) }) }), async (req, res) => {
  await svc.closeVisit(req, req.validParams.id, req.body.notes);
  res.json({ ok: true });
});

router.post(
  '/visits/:id/diagnoses',
  requirePermission('clinical.record'),
  validate({ params: idParam, body: z.object({ conditionName: v.text(200, 'Condition'), icdCode: v.optionalText(12), severity: z.enum(['mild', 'moderate', 'severe', 'critical'], { errorMap: () => ({ message: 'Select the severity.' }) }), notes: v.text(2000, 'Notes') }) }),
  async (req, res) => res.status(201).json(await svc.addDiagnosis(req, req.validParams.id, req.body)),
);

router.post('/visits/:id/observations', requirePermission('clinical.record'), validate({ params: idParam, body: observationBody }), async (req, res) => {
  res.status(201).json(await svc.addObservation(req, req.validParams.id, req.body));
});

router.post(
  '/visits/:id/prescriptions',
  requirePermission('prescriptions.create'),
  validate({ params: idParam, body: z.object({ items: rxItems, notes: v.optionalText(500), acknowledgeWarnings: v.bool().optional() }) }),
  async (req, res) => res.status(201).json(await svc.createPrescription(req, req.validParams.id, req.body)),
);

router.get('/prescriptions/flagged', requirePermission('prescriptions.create'), async (req, res) => res.json({ data: await svc.myFlaggedPrescriptions(req) }));
router.put(
  '/prescriptions/:id',
  requirePermission('prescriptions.create'),
  validate({ params: idParam, body: z.object({ items: rxItems, notes: v.optionalText(500), acknowledgeWarnings: v.bool().optional() }) }),
  async (req, res) => {
    await svc.revisePrescription(req, req.validParams.id, req.body);
    res.json({ ok: true });
  },
);
router.post('/prescriptions/:id/cancel', requirePermission('prescriptions.create'), validate({ params: idParam, body: z.object({ reason: v.text(300, 'Reason') }) }), async (req, res) => {
  await svc.cancelPrescription(req, req.validParams.id, req.body.reason);
  res.json({ ok: true });
});

router.post(
  '/lab-requests',
  requirePermission('lab.request'),
  validate({ body: z.object({ patientId: v.id(), visitId: z.coerce.number().int().positive().optional(), labTestId: v.id(), urgency: z.enum(['routine', 'urgent', 'stat'], { errorMap: () => ({ message: 'Select the urgency level.' }) }), clinicalNotes: v.text(1000, 'Clinical notes'), parameters: z.array(z.string().max(80)).max(30).optional(), specialInstructions: v.optionalText(500) }) }),
  async (req, res) => res.status(201).json(await svc.requestLabTest(req, req.body)),
);
router.patch(
  '/lab-requests/:id/parameters',
  requirePermission('lab.request'),
  validate({ params: idParam, body: z.object({ parameters: z.array(z.string().max(80)).min(1, 'Select at least one parameter.').max(30), specialInstructions: v.optionalText(500) }) }),
  async (req, res) => res.json(await svc.updateLabParameters(req, req.validParams.id, req.body)),
);
router.post('/lab-requests/:id/cancel', requirePermission('lab.request'), validate({ params: idParam, body: z.object({ reason: v.text(300, 'Reason') }) }), async (req, res) => {
  await svc.cancelLabRequest(req, req.validParams.id, req.body.reason);
  res.json({ ok: true });
});

export default router;
