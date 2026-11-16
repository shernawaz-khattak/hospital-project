// Departments (SRS FR-07, UC-09). Department names are unique (case-insensitive).
import { Router } from 'express';
import { db } from '../../db/knex.js';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';

const router = Router();

const body = z.object({
  name: v.text(80, 'Department name').refine((s) => s.length >= 2, 'Department name must be at least 2 characters.'),
  code: v.text(12, 'Code').transform((s) => s.toUpperCase()).refine((s) => /^[A-Z0-9-]+$/.test(s), 'Use letters, numbers or dashes.'),
  description: v.optionalText(500),
  location: v.optionalText(120),
  phone: v.optionalPhone(),
  isActive: v.bool().optional(),
});

const dto = (r) => ({
  id: r.id, name: r.name, code: r.code, description: r.description, location: r.location, phone: r.phone, isActive: r.is_active,
  doctorCount: Number(r.doctor_count ?? 0), staffCount: Number(r.staff_count ?? 0), wardCount: Number(r.ward_count ?? 0),
});

const listQuery = () =>
  db('departments as d').select(
    'd.*',
    db.raw('(SELECT count(*) FROM doctors x WHERE x.department_id = d.id AND x.is_active) AS doctor_count'),
    db.raw("(SELECT count(*) FROM staff s JOIN users u ON u.id = s.user_id WHERE s.department_id = d.id AND u.status <> 'deleted') AS staff_count"),
    db.raw('(SELECT count(*) FROM wards w WHERE w.department_id = d.id) AS ward_count'),
  );

// Any signed-in staff member may read the department list (used by many forms).
router.get('/', async (req, res) => {
  const q = listQuery().orderBy('d.name');
  if (req.query.active === 'true') q.where('d.is_active', true);
  if (req.query.search) q.whereILike('d.name', `%${String(req.query.search).slice(0, 80)}%`);
  res.json({ data: (await q).map(dto) });
});

router.post('/', requirePermission('departments.manage'), validate({ body }), async (req, res) => {
  const b = req.body;
  if (await db('departments').where({ name: b.name }).first()) throw conflict('A department with this name already exists.', { fields: { name: 'A department with this name already exists.' } });
  const [row] = await db('departments').insert({ name: b.name, code: b.code, description: b.description, location: b.location, phone: b.phone, is_active: b.isActive ?? true }).returning('*');
  await audit(req, { action: 'department.create', entityType: 'department', entityId: row.id, details: { name: row.name } });
  res.status(201).json(dto(row));
});

router.patch('/:id', requirePermission('departments.manage'), validate({ params: idParam, body: body.partial() }), async (req, res) => {
  const { id } = req.validParams;
  const b = req.body;
  if (b.name && (await db('departments').where({ name: b.name }).whereNot({ id }).first())) {
    throw conflict('A department with this name already exists.', { fields: { name: 'A department with this name already exists.' } });
  }
  const patch = { updated_at: new Date() };
  for (const [k, col] of [['name', 'name'], ['code', 'code'], ['description', 'description'], ['location', 'location'], ['phone', 'phone'], ['isActive', 'is_active']]) {
    if (b[k] !== undefined) patch[col] = b[k];
  }
  const [row] = await db('departments').where({ id }).update(patch).returning('*');
  if (!row) throw notFound('Department not found.');
  await audit(req, { action: 'department.update', entityType: 'department', entityId: id, details: { fields: Object.keys(b) } });
  res.json(dto(row));
});

router.delete('/:id', requirePermission('departments.manage'), validate({ params: idParam }), async (req, res) => {
  const { id } = req.validParams;
  const dep = await listQuery().where('d.id', id).first();
  if (!dep) throw notFound('Department not found.');
  const linked = Number(dep.doctor_count) + Number(dep.staff_count) + Number(dep.ward_count);
  const inactiveDoctors = await db('doctors').where({ department_id: id }).count({ n: '*' }).first();
  if (linked > 0 || inactiveDoctors.n > 0) {
    throw conflict('This department still has doctors, staff or wards. Move them or mark the department inactive instead.');
  }
  await db('staffing_levels').where({ department_id: id }).del();
  await db('departments').where({ id }).del();
  await audit(req, { action: 'department.delete', entityType: 'department', entityId: id, details: { name: dep.name } });
  res.json({ ok: true });
});

export default router;
