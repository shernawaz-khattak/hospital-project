import { Router } from 'express';
import { z, v, validate } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import { addDays, daysInclusive, todayStr } from '../../lib/dates.js';
import { audit } from '../../services/audit.js';
import { financialReportPdf } from '../../lib/pdf.js';
import * as svc from './service.js';

const router = Router();

router.get('/dashboard', async (req, res) => res.json(await svc.dashboard(req)));

const range = z
  .object({ from: v.date('From date').optional(), to: v.date('To date').optional(), period: z.enum(['daily', 'weekly', 'monthly']).default('daily') })
  .transform((r) => ({ ...r, to: r.to ?? todayStr(), from: r.from ?? addDays(r.to ?? todayStr(), -29) }))
  .refine((r) => r.from <= r.to, { message: 'The start date must be before the end date.', path: ['from'] })
  .refine((r) => daysInclusive(r.from, r.to) <= 731, { message: 'Choose a range of at most two years.', path: ['from'] });

router.get('/operational', requirePermission('reports.operational'), validate({ query: range }), async (req, res) => res.json(await svc.operationalReport(req.validQuery)));

router.get('/financial/summary', requirePermission('reports.financial'), async (_req, res) => res.json(await svc.financialSummary()));

router.get('/financial', requirePermission('reports.financial'), validate({ query: range }), async (req, res) => {
  const report = await svc.financialReport(req.validQuery);
  await audit(req, { action: 'report.financial', details: { ...req.validQuery, format: 'json' } });
  res.json(report);
});

router.get('/financial.pdf', requirePermission('reports.financial'), validate({ query: range }), async (req, res) => {
  const report = await svc.financialReport(req.validQuery);
  if (!report.hasData) throw new AppError(404, report.message, { code: 'NO_DATA' });
  await audit(req, { action: 'report.financial', details: { ...req.validQuery, format: 'pdf' } });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="financial-report-${report.period}-${report.from}-to-${report.to}.pdf"` });
  financialReportPdf(report, res);
});

export default router;
