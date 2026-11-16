import { Router } from 'express';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import * as svc from './service.js';

const router = Router();
const FORMS = ['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other'];

router.get(
  '/medicines',
  requirePermission('inventory.view', 'inventory.manage'),
  validate({ query: z.object({ search: z.string().trim().max(80).optional(), category: z.string().max(60).optional(), filter: z.enum(['low', 'out', 'expiring']).optional(), includeInactive: z.enum(['true', 'false']).optional() }) }),
  async (req, res) => res.json({ data: await svc.listMedicines({ ...req.validQuery, includeInactive: req.validQuery.includeInactive === 'true' }) }),
);
router.get('/medicines/:id', requirePermission('inventory.manage', 'pharmacy.dispense'), validate({ params: idParam }), async (req, res) => res.json(await svc.medicineDetail(req.validParams.id)));

const medicineBody = z.object({
  name: v.text(100, 'Medicine name'),
  genericName: v.text(120, 'Generic name'),
  form: z.enum(FORMS, { errorMap: () => ({ message: 'Select the form.' }) }),
  strength: v.text(40, 'Strength'),
  category: v.text(60, 'Category'),
  unitPrice: v.money('Unit price'),
  reorderLevel: z.coerce.number({ invalid_type_error: 'Enter a whole number.' }).int('Enter a whole number.').min(0, 'Restock level cannot be negative.').max(100000).default(10),
});
router.post('/medicines', requirePermission('inventory.manage'), validate({ body: medicineBody }), async (req, res) => res.status(201).json(await svc.createMedicine(req, req.body)));
router.patch('/medicines/:id', requirePermission('inventory.manage'), validate({ params: idParam, body: medicineBody.omit({ reorderLevel: true }).extend({ isActive: v.bool() }).partial() }), async (req, res) => {
  res.json(await svc.updateMedicine(req, req.validParams.id, req.body));
});

// UC-37 Set Restock Alert
router.put(
  '/medicines/:id/reorder-level',
  requirePermission('inventory.manage'),
  validate({ params: idParam, body: z.object({ reorderLevel: z.coerce.number({ invalid_type_error: 'Enter a valid number.' }).int('Enter a whole number.').min(0, 'Enter a valid number (0 or more).').max(100000, 'That number is too large.') }) }),
  async (req, res) => {
    await svc.setReorderLevel(req, req.validParams.id, req.body.reorderLevel);
    res.json({ ok: true });
  },
);

router.post(
  '/medicines/:id/batches',
  requirePermission('inventory.manage'),
  validate({ params: idParam, body: z.object({ batchNumber: v.text(40, 'Batch number'), quantity: z.coerce.number({ invalid_type_error: 'Enter a quantity.' }).int('Enter a whole number.').positive('Quantity must be greater than zero.').max(1_000_000), expiryDate: v.date('Expiry date'), supplier: v.optionalText(120), costPrice: z.preprocess((x) => (x === '' ? null : x), v.money('Cost price').nullable().optional()) }) }),
  async (req, res) => res.status(201).json(await svc.receiveBatch(req, req.validParams.id, req.body)),
);

router.post(
  '/batches/:id/adjust',
  requirePermission('inventory.manage'),
  validate({ params: idParam, body: z.object({ quantityChange: z.coerce.number({ invalid_type_error: 'Enter a number.' }).int().refine((n) => n !== 0, 'Change cannot be zero.'), reason: v.text(200, 'Reason') }) }),
  async (req, res) => {
    await svc.adjustBatch(req, req.validParams.id, req.body);
    res.json({ ok: true });
  },
);

router.get('/expiry', requirePermission('inventory.manage'), async (_req, res) => res.json(await svc.expiryTracker()));
router.post('/expiry/scan', requirePermission('inventory.manage'), async (_req, res) => res.json({ flagged: await svc.scanExpiry() }));
router.post('/batches/:id/remove-expired', requirePermission('inventory.manage'), validate({ params: idParam, body: z.object({ reason: v.optionalText(200) }) }), async (req, res) => {
  await svc.removeExpiredBatch(req, req.validParams.id, req.body.reason);
  res.json({ ok: true });
});

router.get('/alerts', requirePermission('inventory.manage'), async (req, res) => res.json({ data: await svc.listAlerts(String(req.query.status ?? 'open')) }));
router.post('/alerts/:id/resolve', requirePermission('inventory.manage'), validate({ params: idParam }), async (req, res) => {
  await svc.resolveAlert(req, req.validParams.id);
  res.json({ ok: true });
});

router.get('/prescriptions', requirePermission('pharmacy.verify', 'pharmacy.dispense'), async (req, res) => res.json({ data: await svc.listPrescriptions({ status: req.query.status ? String(req.query.status) : undefined }) }));
router.get('/prescriptions/:id', requirePermission('pharmacy.verify', 'pharmacy.dispense'), validate({ params: idParam }), async (req, res) => res.json(await svc.prescriptionDetail(req.validParams.id)));
router.post('/prescriptions/:id/verify', requirePermission('pharmacy.verify'), validate({ params: idParam }), async (req, res) => {
  await svc.verifyPrescription(req, req.validParams.id);
  res.json(await svc.prescriptionDetail(req.validParams.id));
});
router.post('/prescriptions/:id/flag', requirePermission('pharmacy.verify'), validate({ params: idParam, body: z.object({ reason: v.text(500, 'Reason') }) }), async (req, res) => {
  await svc.flagPrescription(req, req.validParams.id, req.body.reason);
  res.json(await svc.prescriptionDetail(req.validParams.id));
});
router.post(
  '/prescriptions/:id/dispense',
  requirePermission('pharmacy.dispense'),
  validate({ params: idParam, body: z.object({ items: z.array(z.object({ prescriptionItemId: v.id(), quantity: z.coerce.number().int().min(0, 'Quantity cannot be negative.').max(10000) })).min(1).max(30).refine((a) => new Set(a.map((i) => i.prescriptionItemId)).size === a.length, 'Each medicine can appear only once.'), notes: v.optionalText(300) }) }),
  async (req, res) => res.json(await svc.dispense(req, req.validParams.id, req.body)),
);

export default router;
