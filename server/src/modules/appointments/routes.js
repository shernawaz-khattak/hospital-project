import { Router } from 'express';
import { db } from '../../db/knex.js';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import { forbidden } from '../../lib/errors.js';
import * as svc from './service.js';

const router = Router();
const ANY_APPT = ['appointments.view', 'appointments.manage', 'portal.self'];

router.get(
  '/slots',
  requirePermission(...ANY_APPT),
  validate({ query: z.object({ doctorId: v.id(), date: v.date() }) }),
  async (req, res) => res.json(await svc.getSlots(req.validQuery.doctorId, req.validQuery.date)),
);

router.get(
  '/suggestions',
  requirePermission(...ANY_APPT),
  validate({ query: z.object({ doctorId: v.id(), date: v.date(), after: v.time().optional() }) }),
  async (req, res) => res.json({ suggestions: await svc.suggestSlots(req.validQuery.doctorId, req.validQuery.date, req.validQuery.after, 5) }),
);

router.get(
  '/',
  requirePermission(...ANY_APPT),
  validate({
    query: z.object({
      date: v.optionalDate(), from: v.optionalDate(), to: v.optionalDate(), doctorId: z.coerce.number().int().optional(), patientId: z.coerce.number().int().optional(),
      status: z.string().optional(), q: z.string().trim().max(80).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  async (req, res) => {
    const f = req.validQuery;
    const q = svc.appointmentQuery();
    // Row-level scoping: patients see only their own; doctors see only their own schedule.
    if (!req.user.permissions.includes('appointments.view')) q.where('a.patient_id', req.user.patientId ?? -1);
    else if (req.user.role === 'doctor') q.where('a.doctor_id', req.user.doctorId);
    if (f.date) q.where('a.appointment_date', f.date);
    if (f.from) q.where('a.appointment_date', '>=', f.from);
    if (f.to) q.where('a.appointment_date', '<=', f.to);
    if (f.doctorId) q.where('a.doctor_id', f.doctorId);
    if (f.patientId) q.where('a.patient_id', f.patientId);
    if (f.status) q.whereIn('a.status', f.status.split(','));
    if (f.q) q.where((w) => w.whereILike('p.patient_code', `%${f.q}%`).orWhereRaw("lower(p.first_name || ' ' || p.last_name) like lower(?)", [`%${f.q}%`]).orWhereILike('a.appointment_code', `%${f.q}%`));
    const total = await q.clone().count({ n: '*' }).first();
    const rows = await q.select(svc.appointmentSelect).orderBy([{ column: 'a.appointment_date', order: f.from || f.date ? 'asc' : 'desc' }, { column: 'a.start_time' }]).offset((f.page - 1) * f.pageSize).limit(f.pageSize);
    res.json({ data: rows.map(svc.toDto), total: Number(total.n), page: f.page, pageSize: f.pageSize });
  },
);

router.get('/cancellation-requests', requirePermission('appointments.approve_cancellation'), async (req, res) => {
  res.json({ data: await svc.listCancellationRequests(String(req.query.status ?? 'pending')) });
});

router.post(
  '/cancellation-requests/:id/:decision',
  requirePermission('appointments.approve_cancellation'),
  validate({ params: z.object({ id: v.id(), decision: z.enum(['approve', 'reject']) }), body: z.object({ note: v.optionalText(300) }) }),
  async (req, res) => {
    await svc.decideCancellation(req, req.validParams.id, req.validParams.decision === 'approve', req.body.note);
    res.json({ ok: true });
  },
);

router.get('/:id', requirePermission(...ANY_APPT), validate({ params: idParam }), async (req, res) => {
  const a = await svc.getAppointment(req.validParams.id);
  const own = req.user.patientId === a.patient_id || req.user.doctorId === a.doctor_id;
  if (!own && !(req.user.permissions.includes('appointments.view') && req.user.role !== 'doctor')) throw forbidden();
  const history = await db('appointments').where({ rescheduled_from_id: a.id }).first('id', 'appointment_code');
  res.json({ ...svc.toDto(a), rescheduledToId: history?.id ?? null });
});

router.post(
  '/',
  requirePermission('appointments.manage', 'portal.self'),
  validate({ body: z.object({ patientId: v.id(), doctorId: v.id(), date: v.date(), startTime: v.time(), reason: v.optionalText(300), waitlistEntryId: z.coerce.number().int().positive().optional() }) }),
  async (req, res) => res.status(201).json(await svc.book(req, req.body)),
);

router.post(
  '/:id/cancel',
  requirePermission('appointments.manage', 'portal.self'),
  validate({ params: idParam, body: z.object({ reason: v.text(300, 'Reason') }) }),
  async (req, res) => res.json(await svc.cancel(req, req.validParams.id, req.body.reason)),
);

router.post(
  '/:id/reschedule',
  requirePermission('appointments.manage', 'portal.self'),
  validate({ params: idParam, body: z.object({ date: v.date(), startTime: v.time(), reason: v.text(300, 'Reason') }) }),
  async (req, res) => res.json(await svc.reschedule(req, req.validParams.id, req.body)),
);

router.post('/:id/complete', requirePermission('clinical.record'), validate({ params: idParam }), async (req, res) => {
  await svc.markCompleted(req, req.validParams.id);
  res.json({ ok: true });
});

router.post('/:id/no-show', requirePermission('appointments.manage', 'clinical.record'), validate({ params: idParam }), async (req, res) => {
  await svc.markNoShow(req, req.validParams.id);
  res.json({ ok: true });
});

export default router;

// ----------------------------------------------------------------- waitlist routes
export const waitlistRouter = Router();
waitlistRouter.use(requirePermission('waitlist.manage'));

waitlistRouter.get('/', validate({ query: z.object({ status: z.string().optional(), doctorId: z.coerce.number().int().optional(), date: v.optionalDate() }) }), async (req, res) => {
  res.json({ data: await svc.listWaitlist(req.validQuery) });
});

waitlistRouter.post('/', validate({ body: z.object({ patientId: v.id(), doctorId: v.id(), preferredDate: v.date('Preferred date'), notes: v.optionalText(300) }) }), async (req, res) => {
  res.status(201).json(await svc.addToWaitlist(req, req.body));
});

waitlistRouter.post('/:id/book', validate({ params: idParam, body: z.object({ startTime: v.time(), date: v.optionalDate() }) }), async (req, res) => {
  const entry = await db('waitlist_entries').where({ id: req.validParams.id }).first();
  if (!entry) throw forbidden('Waitlist entry not found.');
  res.status(201).json(await svc.book(req, { patientId: entry.patient_id, doctorId: entry.doctor_id, date: req.body.date ?? entry.preferred_date, startTime: req.body.startTime, reason: entry.notes, waitlistEntryId: entry.id }));
});

waitlistRouter.post('/:id/remove', validate({ params: idParam, body: z.object({ reason: v.optionalText(200) }) }), async (req, res) => {
  await svc.removeFromWaitlist(req, req.validParams.id, req.body.reason);
  res.json({ ok: true });
});
