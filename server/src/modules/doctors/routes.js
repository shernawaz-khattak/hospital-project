// Doctor profiles & weekly availability (SRS FR-06, UC-08). Each doctor has a unique
// doctor ID and a specialization; the weekly schedule drives appointment slots.
import { Router } from 'express';
import { db } from '../../db/knex.js';
import { transaction } from '../../db/tx.js';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { createStaffUser, deleteUser } from '../users/service.js';
import { timeToMinutes } from '../../lib/dates.js';

const router = Router();

const scheduleBlock = z.object({
  weekday: z.coerce.number().int().min(0).max(6),
  startTime: v.time(),
  endTime: v.time(),
}).refine((b) => timeToMinutes(b.endTime) > timeToMinutes(b.startTime), { message: 'End time must be after start time.', path: ['endTime'] });

const profile = {
  doctorCode: z.string().trim().min(2, 'Doctor ID is required.').max(20).regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers or dashes.').transform((s) => s.toUpperCase()),
  specialization: v.text(100, 'Specialization'),
  qualification: v.optionalText(150),
  licenseNumber: v.text(40, 'License number'),
  departmentId: v.id(),
  consultationFee: v.money('Consultation fee'),
  slotMinutes: z.coerce.number().int().min(5, 'Slot length must be 5-120 minutes.').max(120, 'Slot length must be 5-120 minutes.'),
};

const createBody = z.object({
  fullName: v.text(120, 'Full name'),
  username: z.string().trim().min(3, 'Username must be at least 3 characters.').max(40).regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore only.'),
  email: v.email(),
  phone: v.optionalPhone(),
  ...profile,
  schedules: z.array(scheduleBlock).max(21).default([]),
});

function checkOverlaps(blocks) {
  const byDay = {};
  for (const b of blocks) (byDay[b.weekday] ??= []).push(b);
  for (const list of Object.values(byDay)) {
    list.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    for (let i = 1; i < list.length; i++) {
      if (timeToMinutes(list[i].startTime) < timeToMinutes(list[i - 1].endTime)) {
        throw new AppError(422, 'Schedule blocks on the same day must not overlap.', { fields: { schedules: 'Schedule blocks on the same day must not overlap.' } });
      }
    }
  }
}

const doctorSelect = [
  'd.id', 'd.doctor_code', 'd.specialization', 'd.qualification', 'd.license_number', 'd.department_id', 'd.consultation_fee', 'd.slot_minutes', 'd.is_active',
  'u.id as user_id', 'u.full_name', 'u.email', 'u.phone', 'u.username', 'u.status as user_status', 'dep.name as department_name',
];
const dto = (r, schedules) => ({
  id: r.id, doctorCode: r.doctor_code, fullName: r.full_name, specialization: r.specialization, qualification: r.qualification, licenseNumber: r.license_number,
  departmentId: r.department_id, departmentName: r.department_name, consultationFee: r.consultation_fee, slotMinutes: r.slot_minutes, isActive: r.is_active,
  userId: r.user_id, username: r.username, email: r.email, phone: r.phone,
  ...(schedules ? { schedules: schedules.map((s) => ({ id: s.id, weekday: s.weekday, startTime: s.start_time.slice(0, 5), endTime: s.end_time.slice(0, 5) })) } : {}),
});

const baseQuery = () =>
  db('doctors as d').join('staff as st', 'st.id', 'd.staff_id').join('users as u', 'u.id', 'st.user_id').join('departments as dep', 'dep.id', 'd.department_id').whereNot('u.status', 'deleted');

// Doctor directory: readable by every signed-in user (patients choose a doctor when booking).
router.get('/', async (req, res) => {
  const q = baseQuery().select(doctorSelect).orderBy('u.full_name');
  const { search, departmentId, specialization, includeInactive } = req.query;
  if (!(includeInactive === 'true' && req.user.permissions.includes('doctors.manage'))) q.where('d.is_active', true).where('u.status', 'active');
  if (search) q.where((w) => w.whereILike('u.full_name', `%${search}%`).orWhereILike('d.specialization', `%${search}%`).orWhereILike('d.doctor_code', `%${search}%`));
  if (departmentId) q.where('d.department_id', Number(departmentId));
  if (specialization) q.whereILike('d.specialization', String(specialization));
  const rows = await q;
  const schedules = await db('doctor_schedules').whereIn('doctor_id', rows.map((r) => r.id)).orderBy(['weekday', 'start_time']);
  const isManager = req.user.permissions.includes('doctors.manage');
  res.json({
    data: rows.map((r) => {
      const d = dto(r, schedules.filter((s) => s.doctor_id === r.id));
      if (!isManager) { delete d.username; delete d.email; delete d.phone; delete d.licenseNumber; delete d.userId; }
      return d;
    }),
  });
});

router.get('/:id', validate({ params: idParam }), async (req, res) => {
  const row = await baseQuery().where('d.id', req.validParams.id).first(doctorSelect);
  if (!row) throw notFound('Doctor not found.');
  const schedules = await db('doctor_schedules').where({ doctor_id: row.id }).orderBy(['weekday', 'start_time']);
  const d = dto(row, schedules);
  if (!req.user.permissions.includes('doctors.manage')) { delete d.username; delete d.email; delete d.phone; delete d.licenseNumber; delete d.userId; }
  res.json(d);
});

router.post('/', requirePermission('doctors.manage'), validate({ body: createBody }), async (req, res) => {
  const b = req.body;
  checkOverlaps(b.schedules);
  const result = await transaction(async (trx) => {
    const dep = await trx('departments').where({ id: b.departmentId, is_active: true }).first();
    if (!dep) throw new AppError(422, 'Select an active department.', { fields: { departmentId: 'Select an active department.' } });
    if (await trx('doctors').where({ doctor_code: b.doctorCode }).first()) throw conflict('This doctor ID is already in use.', { fields: { doctorCode: 'This doctor ID is already in use.' } });
    const { user, staff, tempPassword } = await createStaffUser(
      req,
      { username: b.username, fullName: b.fullName, email: b.email, phone: b.phone, role: 'doctor', departmentId: b.departmentId, designation: `Consultant ${b.specialization}` },
      trx,
      { allowSpecial: true },
    );
    const [doc] = await trx('doctors').insert({
      staff_id: staff.id, doctor_code: b.doctorCode, specialization: b.specialization, qualification: b.qualification, license_number: b.licenseNumber,
      department_id: b.departmentId, consultation_fee: b.consultationFee, slot_minutes: b.slotMinutes,
    }).returning('*');
    if (b.schedules.length) {
      await trx('doctor_schedules').insert(b.schedules.map((s) => ({ doctor_id: doc.id, weekday: s.weekday, start_time: s.startTime, end_time: s.endTime })));
    }
    await audit(req, { action: 'doctor.create', entityType: 'doctor', entityId: doc.id, details: { doctorCode: doc.doctor_code, userId: user.id } }, trx);
    return { id: doc.id, tempPassword };
  });
  const row = await baseQuery().where('d.id', result.id).first(doctorSelect);
  res.status(201).json({ doctor: dto(row, []), tempPassword: result.tempPassword });
});

router.patch(
  '/:id',
  requirePermission('doctors.manage'),
  validate({ params: idParam, body: z.object({ ...profile, fullName: v.text(120, 'Full name'), email: v.email(), phone: v.optionalPhone(), isActive: v.bool() }).partial() }),
  async (req, res) => {
    const { id } = req.validParams;
    const b = req.body;
    await transaction(async (trx) => {
      const doc = await trx('doctors as d').join('staff as st', 'st.id', 'd.staff_id').where('d.id', id).first('d.*', 'st.user_id');
      if (!doc) throw notFound('Doctor not found.');
      if (b.departmentId) {
        const dep = await trx('departments').where({ id: b.departmentId, is_active: true }).first();
        if (!dep) throw new AppError(422, 'Select an active department.', { fields: { departmentId: 'Select an active department.' } });
      }
      const patch = { updated_at: new Date() };
      const map = { doctorCode: 'doctor_code', specialization: 'specialization', qualification: 'qualification', licenseNumber: 'license_number', departmentId: 'department_id', consultationFee: 'consultation_fee', slotMinutes: 'slot_minutes', isActive: 'is_active' };
      for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) patch[col] = b[k];
      await trx('doctors').where({ id }).update(patch);
      const userPatch = {};
      if (b.fullName) userPatch.full_name = b.fullName;
      if (b.email) userPatch.email = b.email;
      if (b.phone !== undefined) userPatch.phone = b.phone;
      if (Object.keys(userPatch).length) await trx('users').where({ id: doc.user_id }).update({ ...userPatch, updated_at: new Date() });
      if (b.departmentId) await trx('staff').where({ user_id: doc.user_id }).update({ department_id: b.departmentId });
      await audit(req, { action: 'doctor.update', entityType: 'doctor', entityId: id, details: { fields: Object.keys(b) } }, trx);
    });
    const row = await baseQuery().where('d.id', id).first(doctorSelect);
    res.json(dto(row));
  },
);

router.put(
  '/:id/schedules',
  requirePermission('doctors.manage'),
  validate({ params: idParam, body: z.object({ schedules: z.array(scheduleBlock).max(21) }) }),
  async (req, res) => {
    const { id } = req.validParams;
    checkOverlaps(req.body.schedules);
    await transaction(async (trx) => {
      if (!(await trx('doctors').where({ id }).first())) throw notFound('Doctor not found.');
      await trx('doctor_schedules').where({ doctor_id: id }).del();
      if (req.body.schedules.length) {
        await trx('doctor_schedules').insert(req.body.schedules.map((s) => ({ doctor_id: id, weekday: s.weekday, start_time: s.startTime, end_time: s.endTime })));
      }
      await audit(req, { action: 'doctor.schedule_update', entityType: 'doctor', entityId: id, details: { blocks: req.body.schedules.length } }, trx);
    });
    const schedules = await db('doctor_schedules').where({ doctor_id: id }).orderBy(['weekday', 'start_time']);
    res.json({ schedules: schedules.map((s) => ({ weekday: s.weekday, startTime: s.start_time.slice(0, 5), endTime: s.end_time.slice(0, 5) })) });
  },
);

// Removing a doctor removes their account (archived first) — same rules as UC-07.
router.delete('/:id', requirePermission('doctors.manage'), validate({ params: idParam }), async (req, res) => {
  const doc = await db('doctors as d').join('staff as st', 'st.id', 'd.staff_id').where('d.id', req.validParams.id).first('st.user_id');
  if (!doc) throw notFound('Doctor not found.');
  if (doc.user_id === req.user.id) throw badRequest('You cannot remove your own account.');
  await deleteUser(req, doc.user_id, 'Doctor removed');
  res.json({ ok: true });
});

export default router;
