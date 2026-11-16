import { Router } from 'express';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { pageQuery } from '../../lib/pagination.js';
import { hasPermission, requirePermission } from '../../middleware/auth.js';
import { todayStr } from '../../lib/dates.js';
import * as svc from './service.js';
import { audit } from '../../services/audit.js';

const router = Router();

const nationalId = z.preprocess(
  (x) => (x === '' || x === undefined || x === null ? null : x),
  z.string().trim().regex(/^\d{5}-?\d{7}-?\d$/, 'Enter the 13-digit CNIC, e.g. 61101-1234567-1.').nullable(),
);

const patientFields = {
  firstName: v.text(60, 'First name'),
  lastName: v.text(60, 'Last name'),
  dateOfBirth: v.pastDate('Date of birth').refine((d) => d >= '1900-01-01', 'Enter a valid date of birth.'),
  gender: z.enum(['male', 'female', 'other'], { errorMap: () => ({ message: 'Select a gender.' }) }),
  bloodGroup: z.preprocess((x) => (x === '' ? null : x), z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).nullable().optional()),
  maritalStatus: v.optionalText(20),
  phone: v.phone('Phone'),
  email: v.optionalEmail(),
  nationalId,
  address: v.optionalText(300),
  city: v.optionalText(80),
  emergencyContactName: v.optionalText(100),
  emergencyContactPhone: v.optionalPhone(),
  emergencyContactRelation: v.optionalText(40),
  allergies: v.optionalText(1000),
  medicalHistory: v.optionalText(3000),
  currentMedications: v.optionalText(1000),
};

const createSchema = z
  .object({
    ...patientFields,
    confirmDuplicate: v.bool().optional(),
    duplicateReason: v.optionalText(300),
    createPortalAccount: v.bool().optional(),
  })
  .refine((d) => !d.createPortalAccount || d.email, { message: 'An email address is required to create a portal account.', path: ['email'] });

// Search (receptionist, doctor, accountant): demographics only.
router.get(
  '/',
  requirePermission('patients.view'),
  validate({ query: pageQuery.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['out_patient', 'in_patient', 'discharged', 'inactive']).optional() }) }),
  async (req, res) => res.json(await svc.searchPatients(req.validQuery)),
);

router.post(
  '/check-duplicates',
  requirePermission('patients.create', 'patients.update'),
  validate({ body: z.object({ firstName: z.string().optional(), lastName: z.string().optional(), dateOfBirth: v.optionalDate(), phone: z.string().optional(), nationalId, excludeId: z.coerce.number().int().optional() }) }),
  async (req, res) => res.json({ matches: await svc.findDuplicates(req.body, req.body.excludeId) }),
);

// UC-14 Verify Patient ID — usable by every staff role that handles patients.
router.get(
  '/verify/:code',
  requirePermission('patients.view', 'lab.process', 'pharmacy.verify', 'billing.view'),
  async (req, res) => res.json(await svc.verifyPatientCode(String(req.params.code).slice(0, 30))),
);

router.post('/', requirePermission('patients.create'), validate({ body: createSchema }), async (req, res) => {
  res.status(201).json(await svc.registerPatient(req, req.body));
});

router.get('/:id', requirePermission('patients.view'), validate({ params: idParam }), async (req, res) => {
  const row = await svc.getPatientRow(req.validParams.id);
  // Registration staff see the full record they maintain; other roles see demographics.
  const level = hasPermission(req, 'patients.update') ? 'full' : 'basic';
  if (level === 'full') await audit(req, { action: 'patient.view', entityType: 'patient', entityId: row.id });
  res.json(svc.toProfile(row, level));
});

router.get('/:id/overview', requirePermission('patients.update', 'billing.manage'), validate({ params: idParam }), async (req, res) => {
  res.json(await svc.patientOverview(req.validParams.id));
});

router.get('/:id/changes', requirePermission('patients.update'), validate({ params: idParam }), async (req, res) => {
  res.json({ data: await svc.changeHistory(req.validParams.id) });
});

router.patch('/:id', requirePermission('patients.update'), validate({ params: idParam, body: z.object(patientFields).partial() }), async (req, res) => {
  res.json(await svc.updatePatient(req, req.validParams.id, req.body));
});

router.get('/:id/insurance', requirePermission('patients.update', 'billing.manage'), validate({ params: idParam }), async (req, res) => {
  res.json({ data: await svc.activeInsurance(req.validParams.id) });
});

router.post(
  '/:id/insurance',
  requirePermission('patients.update', 'billing.manage'),
  validate({
    params: idParam,
    body: z.object({
      providerId: v.id(),
      policyNumber: v.text(40, 'Policy number').regex(/^[A-Za-z0-9-]{4,40}$/, 'Use 4-40 letters, numbers or dashes.'),
      coveragePercent: z.preprocess((x) => (x === '' || x === null ? undefined : x), z.coerce.number().gt(0, 'Coverage must be above 0%.').max(100, 'Coverage cannot exceed 100%.').optional()),
      validFrom: v.date('Start date'),
      validUntil: v.date('Expiry date').refine((d) => d >= todayStr(), 'This policy has already expired.'),
    }),
  }),
  async (req, res) => {
    await svc.addInsurance(req, req.validParams.id, req.body);
    res.status(201).json({ data: await svc.activeInsurance(req.validParams.id) });
  },
);

router.post('/:id/portal-access', requirePermission('patients.portal_access'), validate({ params: idParam, body: z.object({ email: v.optionalEmail() }) }), async (req, res) => {
  res.status(201).json(await svc.enablePortal(req, req.validParams.id, req.body.email));
});

router.delete('/:id/portal-access', requirePermission('patients.portal_access'), validate({ params: idParam }), async (req, res) => {
  await svc.disablePortal(req, req.validParams.id);
  res.json({ ok: true });
});

export default router;
