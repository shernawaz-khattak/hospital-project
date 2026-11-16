// Staff list (UC-11) and staffing levels (UC-10).
import { Router } from 'express';
import { db } from '../../db/knex.js';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import { AppError, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { pageQuery } from '../../lib/pagination.js';

const router = Router();

// UC-11: searchable and sortable by name, role and department.
const SORTS = { name: 'u.full_name', role: 'r.name', department: 'dep.name', joined: 'st.date_joined' };

router.get(
  '/',
  requirePermission('staff.view'),
  validate({ query: pageQuery.extend({ search: z.string().trim().max(100).optional(), role: z.string().optional(), departmentId: z.coerce.number().int().optional(), sort: z.enum(['name', 'role', 'department', 'joined']).default('name'), dir: z.enum(['asc', 'desc']).default('asc') }) }),
  async (req, res) => {
    const { search, role, departmentId, sort, dir, page, pageSize } = req.validQuery;
    const q = db('staff as st')
      .join('users as u', 'u.id', 'st.user_id')
      .join('roles as r', 'r.id', 'u.role_id')
      .leftJoin('departments as dep', 'dep.id', 'st.department_id')
      .leftJoin('doctors as d', 'd.staff_id', 'st.id')
      .whereNot('u.status', 'deleted');
    if (search) q.where((w) => w.whereILike('u.full_name', `%${search}%`).orWhereILike('st.employee_code', `%${search}%`).orWhereILike('st.designation', `%${search}%`));
    if (role) q.where('r.code', role);
    if (departmentId) q.where('st.department_id', departmentId);
    const total = await q.clone().count({ n: '*' }).first();
    const rows = await q
      .select('st.id', 'st.employee_code', 'st.designation', 'st.date_joined', 'u.id as user_id', 'u.full_name', 'u.email', 'u.phone', 'u.status', 'r.code as role', 'r.name as role_name', 'dep.name as department_name', 'd.specialization')
      .orderBy(SORTS[sort], dir)
      .orderBy('u.full_name')
      .offset((page - 1) * pageSize)
      .limit(pageSize);
    res.json({
      page, pageSize, total: Number(total.n),
      data: rows.map((r) => ({ id: r.id, userId: r.user_id, employeeCode: r.employee_code, fullName: r.full_name, email: r.email, phone: r.phone, status: r.status, role: r.role, roleName: r.role_name, departmentName: r.department_name, designation: r.designation, specialization: r.specialization, dateJoined: r.date_joined })),
    });
  },
);

// ----------------------------------------------------------------- staffing levels
router.get('/staffing-levels', requirePermission('staffing.manage', 'staff.view'), async (_req, res) => {
  const levels = await db('staffing_levels as sl')
    .join('departments as d', 'd.id', 'sl.department_id')
    .join('roles as r', 'r.id', 'sl.role_id')
    .leftJoin('users as u', 'u.id', 'sl.updated_by')
    .select('sl.*', 'd.name as department_name', 'r.code as role_code', 'r.name as role_name', 'u.full_name as updated_by_name')
    .orderBy(['d.name', 'r.name']);
  const actual = await db('staff as st')
    .join('users as u', 'u.id', 'st.user_id')
    .where('u.status', 'active')
    .groupBy('st.department_id', 'u.role_id')
    .select('st.department_id', 'u.role_id', db.raw('count(*)::int as n'));
  const staleMs = 31 * 24 * 3600_000; // UC-10: review monthly
  res.json({
    data: levels.map((l) => {
      const current = actual.find((a) => a.department_id === l.department_id && a.role_id === l.role_id)?.n ?? 0;
      return {
        id: l.id, departmentId: l.department_id, departmentName: l.department_name, roleId: l.role_id, roleCode: l.role_code, roleName: l.role_name,
        requiredCount: l.required_count, currentCount: current, shortfall: Math.max(0, l.required_count - current), notes: l.notes,
        reviewedAt: l.reviewed_at, updatedByName: l.updated_by_name, reviewDue: Date.now() - new Date(l.reviewed_at).getTime() > staleMs,
      };
    }),
  });
});

const levelBody = z.object({
  departmentId: v.id(),
  roleId: v.id(),
  requiredCount: z.coerce.number({ invalid_type_error: 'Enter a number.' }).int('Enter a whole number.').positive('Required staff must be greater than zero.').max(1000, 'That number is too large.'),
  notes: v.optionalText(300),
});

router.put('/staffing-levels', requirePermission('staffing.manage'), validate({ body: levelBody }), async (req, res) => {
  const b = req.body;
  const dep = await db('departments').where({ id: b.departmentId }).first();
  if (!dep) throw new AppError(422, 'Select a department.', { fields: { departmentId: 'Departments must be created before staffing levels are set.' } });
  const role = await db('roles').where({ id: b.roleId, is_staff: true }).first();
  if (!role) throw new AppError(422, 'Select a staff role.', { fields: { roleId: 'Select a staff role.' } });
  const [row] = await db('staffing_levels')
    .insert({ department_id: b.departmentId, role_id: b.roleId, required_count: b.requiredCount, notes: b.notes, reviewed_at: new Date(), updated_by: req.user.id })
    .onConflict(['department_id', 'role_id'])
    .merge(['required_count', 'notes', 'reviewed_at', 'updated_by'])
    .returning('*');
  await audit(req, { action: 'staffing.update', entityType: 'staffing_level', entityId: row.id, details: { department: dep.name, role: role.code, requiredCount: b.requiredCount } });
  res.json({ ok: true, id: row.id });
});

router.delete('/staffing-levels/:id', requirePermission('staffing.manage'), validate({ params: idParam }), async (req, res) => {
  const n = await db('staffing_levels').where({ id: req.validParams.id }).del();
  if (!n) throw notFound('Staffing level not found.');
  await audit(req, { action: 'staffing.delete', entityType: 'staffing_level', entityId: req.validParams.id });
  res.json({ ok: true });
});

export default router;
