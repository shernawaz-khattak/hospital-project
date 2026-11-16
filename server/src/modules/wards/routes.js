import { Router } from 'express';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import * as svc from './service.js';

const WARD_TYPES = ['general', 'private', 'semi_private', 'icu', 'maternity', 'pediatric', 'surgical', 'emergency'];

export const wardRouter = Router();

wardRouter.get('/', requirePermission('wards.view', 'admissions.manage'), async (req, res) => {
  res.json({ data: await svc.listWards({ includeInactive: req.query.includeInactive === 'true' }) });
});

wardRouter.get('/board', requirePermission('wards.view', 'admissions.manage'), async (req, res) => {
  res.json({ data: await svc.bedBoard({ wardId: req.query.wardId ? Number(req.query.wardId) : undefined }) });
});

const wardBody = z.object({
  name: v.text(80, 'Ward name'),
  wardType: z.enum(WARD_TYPES, { errorMap: () => ({ message: 'Select a ward type.' }) }),
  departmentId: z.preprocess((x) => (x === '' ? null : x), v.id().nullable().optional()),
  floor: v.optionalText(20),
  genderPolicy: z.enum(['any', 'male', 'female']).default('any'),
  dailyRate: v.money('Daily rate'),
  bedCount: z.coerce.number().int().min(0).max(100).optional(),
  bedPrefix: z.string().trim().max(6).regex(/^[A-Za-z0-9]*$/, 'Letters and numbers only.').optional(),
});

wardRouter.post('/', requirePermission('wards.configure'), validate({ body: wardBody }), async (req, res) => res.status(201).json(await svc.createWard(req, req.body)));

wardRouter.patch(
  '/:id',
  requirePermission('wards.configure'),
  validate({ params: idParam, body: wardBody.omit({ bedCount: true, bedPrefix: true }).extend({ isActive: v.bool() }).partial() }),
  async (req, res) => res.json(await svc.updateWard(req, req.validParams.id, req.body)),
);

wardRouter.post(
  '/:id/beds',
  requirePermission('wards.configure'),
  validate({ params: idParam, body: z.object({ count: z.coerce.number().int().min(1, 'Add at least one bed.').max(50).optional(), prefix: z.string().max(6).optional(), bedNumber: z.string().trim().max(20).optional() }).refine((b) => b.count || b.bedNumber, { message: 'Enter a bed number or how many beds to add.', path: ['count'] }) }),
  async (req, res) => res.status(201).json({ data: await svc.addBeds(req, req.validParams.id, req.body) }),
);

wardRouter.patch(
  '/beds/:id',
  requirePermission('wards.configure', 'admissions.manage'),
  validate({ params: idParam, body: z.object({ status: z.enum(['available', 'maintenance']), notes: v.optionalText(200) }) }),
  async (req, res) => {
    await svc.setBedStatus(req, req.validParams.id, req.body.status, req.body.notes);
    res.json({ ok: true });
  },
);

wardRouter.delete(
  '/beds/:id',
  requirePermission('wards.configure'),
  validate({ params: idParam }),
  async (req, res) => {
    await svc.deleteBed(req, req.validParams.id);
    res.json({ ok: true });
  },
);

export const admissionRouter = Router();

admissionRouter.get('/', requirePermission('admissions.manage', 'wards.view'), validate({ query: z.object({ status: z.enum(['active', 'discharged', 'all']).default('active'), wardId: z.coerce.number().int().optional(), q: z.string().trim().max(80).optional() }) }), async (req, res) => {
  res.json({ data: await svc.listAdmissions(req.validQuery) });
});

admissionRouter.get('/requests', requirePermission('admissions.manage', 'admissions.request'), async (req, res) => {
  res.json({ data: await svc.listAdmissionRequests(String(req.query.status ?? 'pending')) });
});

admissionRouter.post(
  '/requests',
  requirePermission('admissions.request'),
  validate({ body: z.object({ patientId: v.id(), requestType: z.enum(['admission', 'transfer']), preferredWardId: z.preprocess((x) => (x === '' ? null : x), v.id().nullable().optional()), reason: v.text(500, 'Reason'), priority: z.enum(['routine', 'urgent', 'emergency']).default('routine') }) }),
  async (req, res) => res.status(201).json(await svc.createAdmissionRequest(req, req.body)),
);

admissionRouter.post('/requests/:id/cancel', requirePermission('admissions.manage', 'admissions.request'), validate({ params: idParam }), async (req, res) => {
  await svc.cancelAdmissionRequest(req, req.validParams.id);
  res.json({ ok: true });
});

admissionRouter.get('/:id', requirePermission('admissions.manage', 'wards.view'), validate({ params: idParam }), async (req, res) => res.json(await svc.admissionDetail(req.validParams.id, req)));

admissionRouter.post(
  '/',
  requirePermission('admissions.manage'),
  validate({ body: z.object({ patientId: v.id(), wardId: v.id(), bedId: v.id(), attendingDoctorId: v.id(), reason: v.text(500, 'Reason for admission'), requestId: z.coerce.number().int().positive().optional() }) }),
  async (req, res) => res.status(201).json(await svc.admit(req, req.body)),
);

admissionRouter.post(
  '/:id/transfer',
  requirePermission('admissions.manage'),
  validate({ params: idParam, body: z.object({ toWardId: v.id(), toBedId: v.id(), reason: v.text(300, 'Reason for transfer'), requestId: z.coerce.number().int().positive().optional() }) }),
  async (req, res) => res.json(await svc.transfer(req, req.validParams.id, req.body)),
);

admissionRouter.post('/:id/approve-discharge', requirePermission('discharge.approve'), validate({ params: idParam, body: z.object({ notes: v.optionalText(2000) }) }), async (req, res) => {
  res.json(await svc.approveDischarge(req, req.validParams.id, req.body.notes));
});

admissionRouter.get('/:id/discharge-check', requirePermission('admissions.manage', 'discharge.approve'), validate({ params: idParam }), async (req, res) => {
  res.json(await svc.dischargeCheck(req.validParams.id));
});

admissionRouter.post(
  '/:id/discharge',
  requirePermission('admissions.manage', 'discharge.approve'),
  validate({ params: idParam, body: z.object({ finalDiagnosis: v.optionalText(300), conditionAtDischarge: v.text(200, 'Condition at discharge'), treatmentSummary: v.optionalText(3000), followUpInstructions: v.optionalText(1000) }) }),
  async (req, res) => res.json(await svc.discharge(req, req.validParams.id, req.body)),
);
