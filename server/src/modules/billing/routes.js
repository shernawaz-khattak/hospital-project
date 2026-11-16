import { Router } from 'express';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import * as svc from './service.js';

const router = Router();

router.get('/patients', requirePermission('billing.view'), async (req, res) => res.json({ data: await svc.billingPatients({ q: req.query.q ? String(req.query.q).slice(0, 80) : undefined }) }));
router.get('/patients/:id/unbilled', requirePermission('billing.manage'), validate({ params: idParam }), async (req, res) => res.json(await svc.billingPreview(req.validParams.id)));
router.get('/awaiting-final-bill', requirePermission('billing.view'), async (_req, res) => res.json({ data: await svc.awaitingFinalBill() }));

router.post(
  '/bills',
  requirePermission('billing.manage'),
  validate({
    body: z.object({
      patientId: v.id(),
      excludeKeys: z.array(z.string().max(60)).max(500).default([]),
      otherCharges: z.array(z.object({ description: v.text(200, 'Description'), quantity: z.coerce.number().positive('Quantity must be above zero.').max(1000), unitPrice: v.money('Unit price') })).max(30).default([]),
      acknowledgeWarnings: v.bool().optional(),
      notes: v.optionalText(500),
    }),
  }),
  async (req, res) => res.status(201).json(await svc.generateBill(req, req.body)),
);

router.get(
  '/bills',
  requirePermission('billing.view'),
  validate({ query: z.object({ status: z.enum(['unpaid', 'partially_paid', 'paid', 'outstanding']).optional(), patientId: z.coerce.number().int().optional(), q: z.string().trim().max(80).optional(), from: v.optionalDate(), to: v.optionalDate(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) }) }),
  async (req, res) => res.json(await svc.listBills(req.validQuery)),
);

router.get('/bills/:id', requirePermission('billing.view', 'portal.self'), validate({ params: idParam }), async (req, res) => {
  await svc.assertBillAccess(req, req.validParams.id);
  res.json(await svc.billDetail(req.validParams.id));
});

router.post('/bills/:id/insurance', requirePermission('billing.manage'), validate({ params: idParam, body: z.object({ patientInsuranceId: v.id() }) }), async (req, res) => {
  await svc.applyInsurance(req, req.validParams.id, req.body.patientInsuranceId);
  res.json(await svc.billDetail(req.validParams.id));
});

router.post(
  '/bills/:id/payments',
  requirePermission('payments.record'),
  validate({
    params: idParam,
    body: z
      .object({
        amount: z.coerce.number({ invalid_type_error: 'Invalid payment amount.' }).positive('Invalid payment amount.').max(100_000_000).refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'Use at most 2 decimals.'),
        method: z.enum(['cash', 'card', 'bank_transfer', 'cheque', 'mobile_wallet'], { errorMap: () => ({ message: 'Select a payment method.' }) }),
        referenceNo: v.optionalText(60),
        notes: v.optionalText(300),
      })
      .refine((b) => b.method === 'cash' || b.referenceNo, { message: 'A reference number is required for non-cash payments.', path: ['referenceNo'] }),
  }),
  async (req, res) => res.status(201).json(await svc.recordPayment(req, req.validParams.id, req.body)),
);

router.post('/payments/:id/receipt', requirePermission('payments.record'), validate({ params: idParam }), async (req, res) => {
  const r = await svc.issueReceipt(req, req.validParams.id);
  res.status(201).json(await svc.getReceipt(req, r.id));
});
router.get('/receipts/:id', requirePermission('billing.view', 'portal.self'), validate({ params: idParam }), async (req, res) => res.json(await svc.getReceipt(req, req.validParams.id)));

router.get('/insurance-providers', requirePermission('billing.view', 'insurance.manage', 'patients.update'), async (_req, res) => res.json({ data: await svc.listProviders() }));
const providerBody = z.object({
  name: v.text(100, 'Name'),
  defaultCoveragePercent: z.coerce.number().gt(0, 'Coverage must be above 0%.').max(100, 'Coverage cannot exceed 100%.'),
  maxCoverageAmount: z.preprocess((x) => (x === '' || x === null ? null : x), v.money('Maximum coverage').nullable().optional()),
  policyNumberPattern: v.optionalText(100),
  contactPhone: v.optionalPhone(),
  isActive: v.bool().optional(),
});
router.post('/insurance-providers', requirePermission('insurance.manage'), validate({ body: providerBody }), async (req, res) => res.status(201).json(await svc.saveProvider(req, null, req.body)));
router.put('/insurance-providers/:id', requirePermission('insurance.manage'), validate({ params: idParam, body: providerBody }), async (req, res) => res.json(await svc.saveProvider(req, req.validParams.id, req.body)));

export default router;
