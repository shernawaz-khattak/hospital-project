import { Router } from 'express';
import multer from 'multer';
import { z, v, validate, idParam, parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { forbidden } from '../../lib/errors.js';
import { hasCareRelationship } from '../clinical/access.js';
import * as svc from './service.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

router.get('/tests', requirePermission('lab.process', 'lab.catalog', 'lab.request'), async (req, res) => {
  res.json({ data: await svc.listTests({ includeUnavailable: req.query.available !== 'true' }) });
});

const testBody = z.object({
  code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers or dashes.').transform((s) => s.toUpperCase()),
  name: v.text(120, 'Test name'),
  category: v.text(60, 'Category'),
  sampleType: v.text(60, 'Sample type'),
  price: v.money('Price'),
  turnaroundHours: z.coerce.number().int().min(1, 'Turnaround must be at least 1 hour.').max(720),
  parameters: z.array(z.object({ name: v.text(80, 'Parameter name'), unit: z.string().max(30).default(''), referenceRange: z.string().max(60).default('') })).min(1, 'Add at least one parameter.').max(40),
  isAvailable: v.bool().optional(),
});
router.post('/tests', requirePermission('lab.catalog'), validate({ body: testBody }), async (req, res) => res.status(201).json(await svc.saveTest(req, null, req.body)));
router.put('/tests/:id', requirePermission('lab.catalog'), validate({ params: idParam, body: testBody }), async (req, res) => res.json(await svc.saveTest(req, req.validParams.id, req.body)));

// Requests: the lab sees all; a doctor may list their patients' requests via ?patientId.
router.get(
  '/requests',
  requirePermission('lab.process', 'clinical.view'),
  validate({ query: z.object({ status: z.string().optional(), urgency: z.enum(['routine', 'urgent', 'stat']).optional(), q: z.string().trim().max(80).optional(), patientId: z.coerce.number().int().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }) }),
  async (req, res) => {
    const f = req.validQuery;
    if (!req.user.permissions.includes('lab.process')) {
      if (!f.patientId || !(await hasCareRelationship(req.user.doctorId, f.patientId))) throw forbidden('Choose one of your patients to view their lab requests.');
    }
    res.json(await svc.listRequests(f));
  },
);

router.get('/requests/:id', requirePermission('lab.process'), validate({ params: idParam }), async (req, res) => res.json(svc.toDto(await svc.getRequest(req.validParams.id))));

router.post('/requests/:id/start', requirePermission('lab.process'), validate({ params: idParam }), async (req, res) => {
  await svc.startProcessing(req, req.validParams.id);
  res.json(svc.toDto(await svc.getRequest(req.validParams.id)));
});
router.post('/requests/:id/delay', requirePermission('lab.process'), validate({ params: idParam, body: z.object({ reason: v.text(300, 'Reason') }) }), async (req, res) => {
  await svc.markDelayed(req, req.validParams.id, req.body.reason);
  res.json(svc.toDto(await svc.getRequest(req.validParams.id)));
});
router.post('/requests/:id/complete', requirePermission('lab.process'), validate({ params: idParam }), async (req, res) => {
  await svc.completeProcessing(req, req.validParams.id);
  res.json(svc.toDto(await svc.getRequest(req.validParams.id)));
});

const resultValues = z.array(z.object({ name: z.string().max(80), value: z.string().max(80), unit: z.string().max(30).optional(), referenceRange: z.string().max(60).optional(), flag: z.enum(['normal', 'low', 'high', 'abnormal', '']).optional() })).max(40);

router.post('/requests/:id/report', requirePermission('lab.process'), validate({ params: idParam }), upload.single('file'), async (req, res) => {
  let values = [];
  if (req.body?.resultValues) {
    try {
      values = parse(resultValues, JSON.parse(req.body.resultValues));
    } catch (e) {
      if (e.status) throw e;
      values = parse(resultValues, null);
    }
  }
  const remarks = parse(v.optionalText(2000), req.body?.remarks);
  res.status(201).json(await svc.uploadReport(req, req.validParams.id, req.file, { resultValues: values, remarks }));
});

router.get('/reports/:id/file', validate({ params: idParam }), async (req, res) => {
  const { stream, metadata, report } = await svc.reportFile(req, req.validParams.id);
  res.set({ 'Content-Type': report.mime_type, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${report.original_name.replace(/[^\w.-]/g, '_')}"`, 'Cache-Control': 'private, no-store' });
  if (metadata?.size) res.set('Content-Length', String(metadata.size));
  stream.on('error', () => {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  stream.pipe(res);
});

export default router;
