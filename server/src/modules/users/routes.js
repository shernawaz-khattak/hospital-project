import { Router } from 'express';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { pageQuery } from '../../lib/pagination.js';
import { requirePermission } from '../../middleware/auth.js';
import * as svc from './service.js';

const router = Router();
router.use(requirePermission('users.manage'));

const username = z
  .string({ required_error: 'Username is required.' })
  .trim()
  .min(3, 'Username must be at least 3 characters.')
  .max(40, 'Username must be at most 40 characters.')
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore only.');

const staffFields = {
  fullName: v.text(120, 'Full name'),
  email: v.email(),
  phone: v.optionalPhone(),
  role: z.string({ required_error: 'Role is required.' }).min(1, 'Role is required.'),
  departmentId: z.preprocess((x) => (x === '' || x === null || x === undefined ? null : x), v.id().nullable()),
  designation: v.optionalText(100),
  employeeCode: v.optionalText(30),
  dateJoined: v.optionalDate(),
};

router.get('/', validate({ query: pageQuery.extend({ search: z.string().trim().max(100).optional(), role: z.string().optional(), status: z.enum(['active', 'inactive']).optional() }) }), async (req, res) => {
  res.json(await svc.listUsers(req.validQuery));
});

router.get('/roles', async (_req, res) => res.json(await svc.listRolesWithPermissions()));

router.put(
  '/roles/:code/permissions',
  requirePermission('roles.manage'),
  validate({ body: z.object({ permissions: z.array(z.string()).max(200) }) }),
  async (req, res) => res.json(await svc.setRolePermissions(req, req.params.code, req.body.permissions)),
);

router.get('/:id', validate({ params: idParam }), async (req, res) => res.json(await svc.getUser(req.validParams.id)));

router.post('/', validate({ body: z.object({ username, ...staffFields }) }), async (req, res) => {
  res.status(201).json(await svc.createUser(req, req.body));
});

router.patch(
  '/:id',
  validate({ params: idParam, body: z.object({ ...staffFields, status: z.enum(['active', 'inactive']) }).partial() }),
  async (req, res) => res.json(await svc.updateUser(req, req.validParams.id, req.body)),
);

router.delete('/:id', validate({ params: idParam, body: z.object({ reason: v.optionalText(300) }).optional() }), async (req, res) => {
  await svc.deleteUser(req, req.validParams.id, req.body?.reason);
  res.json({ ok: true, message: 'User account archived and removed.' });
});

router.post('/:id/unlock', validate({ params: idParam }), async (req, res) => {
  await svc.unlockUser(req, req.validParams.id);
  res.json({ ok: true });
});

router.post('/:id/reset-password', validate({ params: idParam }), async (req, res) => {
  res.json(await svc.adminResetPassword(req, req.validParams.id));
});

export default router;
