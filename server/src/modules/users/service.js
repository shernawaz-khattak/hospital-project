// User management (SRS UC-05 Add User, UC-06 Edit User, UC-07 Delete User, FR-04, FR-05).
import { db } from '../../db/knex.js';
import { transaction } from '../../db/tx.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { generateTempPassword, randomToken, sha256 } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notifications.js';
import { invalidateUserSessionCache, revokeUserSessions } from '../../auth/sessions.js';
import { closeUserStreams } from '../../services/realtime.js';
import { hashPassword } from '../auth/service.js';
import { paginate } from '../../lib/pagination.js';
import { todayStr } from '../../lib/dates.js';

// Roles that are created through their own workflow rather than the generic Add User form.
const SPECIAL_ROLES = { doctor: 'Doctors are added from Manage Doctors so their specialization and department are recorded.', patient: 'Patient portal accounts are created from the patient profile.' };

const userSelect = [
  'u.id', 'u.username', 'u.full_name', 'u.email', 'u.phone', 'u.status', 'u.locked_until', 'u.last_login_at', 'u.created_at', 'u.must_change_password',
  'r.code as role_code', 'r.name as role_name', 'st.employee_code', 'st.designation', 'st.date_joined', 'dep.id as department_id', 'dep.name as department_name',
];

const toDto = (r) => ({
  id: r.id,
  username: r.username,
  fullName: r.full_name,
  email: r.email,
  phone: r.phone,
  status: r.status,
  locked: Boolean(r.locked_until && new Date(r.locked_until) > new Date()),
  lockedUntil: r.locked_until,
  lastLoginAt: r.last_login_at,
  createdAt: r.created_at,
  mustChangePassword: r.must_change_password,
  role: r.role_code,
  roleName: r.role_name,
  employeeCode: r.employee_code,
  designation: r.designation,
  dateJoined: r.date_joined,
  departmentId: r.department_id,
  departmentName: r.department_name,
});

const baseQuery = () =>
  db('users as u')
    .join('roles as r', 'r.id', 'u.role_id')
    .leftJoin('staff as st', 'st.user_id', 'u.id')
    .leftJoin('departments as dep', 'dep.id', 'st.department_id')
    .whereNull('u.deleted_at');

export async function listUsers({ search, role, status, page, pageSize }) {
  const q = baseQuery().select(userSelect).orderBy('u.full_name');
  if (search) {
    q.where((w) => w.whereILike('u.full_name', `%${search}%`).orWhereILike('u.username', `%${search}%`).orWhereILike('u.email', `%${search}%`).orWhereILike('st.employee_code', `%${search}%`));
  }
  if (role) q.where('r.code', role);
  if (status) q.where('u.status', status);
  const result = await paginate(q, { page, pageSize });
  return { ...result, data: result.data.map(toDto) };
}

export async function getUser(id) {
  const row = await baseQuery().where('u.id', id).first(userSelect);
  if (!row) throw notFound('User not found.');
  return toDto(row);
}

async function roleByCode(code, conn = db) {
  const role = await conn('roles').where({ code }).first();
  if (!role) throw badRequest('Select a valid role.', { fields: { role: 'Select a valid role.' } });
  return role;
}

async function ensureDepartment(conn, departmentId) {
  if (!departmentId) return;
  const dep = await conn('departments').where({ id: departmentId, is_active: true }).first();
  if (!dep) throw new AppError(422, 'Select an active department.', { fields: { departmentId: 'Select an active department.' } });
}

async function nextEmployeeCode(conn) {
  const { rows } = await conn.raw("SELECT COALESCE(MAX(NULLIF(regexp_replace(employee_code, '\\D', '', 'g'), '')::int), 0) + 1 AS n FROM staff");
  return `EMP-${String(rows[0].n).padStart(4, '0')}`;
}

/** Creates the account and sends the user their username plus a set-password link. */
export async function createStaffUser(req, data, conn, { allowSpecial = false } = {}) {
  if (!allowSpecial && SPECIAL_ROLES[data.role]) throw badRequest(SPECIAL_ROLES[data.role], { fields: { role: SPECIAL_ROLES[data.role] } });
  const role = await roleByCode(data.role, conn);
  if (!role.is_staff) throw badRequest('Select a staff role.', { fields: { role: 'Select a staff role.' } });
  await ensureDepartment(conn, data.departmentId);

  const existing = await conn('users').where({ username: data.username }).whereNull('deleted_at').first();
  if (existing) throw conflict('This username is already taken. Please choose a different username.', { fields: { username: 'This username is already taken.' } });
  if (data.email && (await conn('users').where({ email: data.email }).whereNull('deleted_at').first())) {
    throw conflict('This email address is already used by another account.', { fields: { email: 'This email address is already in use.' } });
  }

  const tempPassword = generateTempPassword();
  const [user] = await conn('users')
    .insert({
      username: data.username,
      email: data.email,
      full_name: data.fullName,
      phone: data.phone,
      role_id: role.id,
      password_hash: await hashPassword(tempPassword),
      must_change_password: true,
      created_by: req.user.id,
    })
    .returning('*');
  const [staff] = await conn('staff')
    .insert({
      user_id: user.id,
      employee_code: data.employeeCode || (await nextEmployeeCode(conn)),
      department_id: data.departmentId ?? null,
      designation: data.designation ?? role.name,
      date_joined: data.dateJoined ?? todayStr(),
    })
    .returning('*');

  // Credentials: username + one-time link to choose a password (valid 24 h).
  if (user.email) {
    const token = randomToken(32);
    await conn('password_reset_tokens').insert({ user_id: user.id, token_hash: sha256(token), expires_at: new Date(Date.now() + env.RESET_TOKEN_HOURS * 3600_000) });
    await notify(conn, {
      userIds: [user.id], inApp: false, email: true, secretLink: true, eventType: 'account.created', title: 'Your HMS account',
      message: `An account has been created for you.\nUsername: ${user.username}\nRole: ${role.name}\nUse the link below to set your password (valid ${env.RESET_TOKEN_HOURS} hours). Your administrator can also give you a temporary password.`,
      link: `/reset-password/${token}`,
    });
  }
  await audit(req, { action: 'user.create', entityType: 'user', entityId: user.id, details: { username: user.username, role: role.code } }, conn);
  return { user, staff, tempPassword };
}

export async function createUser(req, data) {
  const result = await transaction((trx) => createStaffUser(req, data, trx));
  return { user: await getUser(result.user.id), tempPassword: result.tempPassword };
}

export async function updateUser(req, id, data) {
  return transaction(async (trx) => {
    const user = await trx('users as u').join('roles as r', 'r.id', 'u.role_id').where('u.id', id).whereNull('u.deleted_at').first('u.*', 'r.code as role_code');
    if (!user) throw notFound('User not found.');
    const changes = {};
    const patch = { updated_at: new Date() };
    if (data.fullName !== undefined) patch.full_name = data.fullName;
    if (data.email !== undefined) patch.email = data.email;
    if (data.phone !== undefined) patch.phone = data.phone;

    if (data.role && data.role !== user.role_code) {
      if (user.id === req.user.id) throw badRequest('You cannot change your own role.', { fields: { role: 'You cannot change your own role.' } });
      if (SPECIAL_ROLES[data.role] || user.role_code === 'doctor' || user.role_code === 'patient') {
        throw badRequest('Doctor and patient roles are managed from their own profiles and cannot be switched here.', { fields: { role: 'This role change is not allowed here.' } });
      }
      const role = await roleByCode(data.role, trx);
      patch.role_id = role.id;
      changes.role = { from: user.role_code, to: role.code }; // takes effect at next login (UC-06)
    }
    if (data.status && data.status !== user.status) {
      if (user.id === req.user.id && data.status !== 'active') throw badRequest('You cannot deactivate your own account.');
      patch.status = data.status;
      changes.status = { from: user.status, to: data.status };
    }
    await trx('users').where({ id }).update(patch);
    trx.afterCommit(() => invalidateUserSessionCache(id));

    if (data.departmentId !== undefined || data.designation !== undefined || data.employeeCode !== undefined) {
      await ensureDepartment(trx, data.departmentId);
      const staffPatch = { updated_at: new Date() };
      if (data.departmentId !== undefined) staffPatch.department_id = data.departmentId;
      if (data.designation !== undefined) staffPatch.designation = data.designation;
      if (data.employeeCode) staffPatch.employee_code = data.employeeCode;
      await trx('staff').where({ user_id: id }).update(staffPatch);
    }
    if (patch.status === 'inactive') {
      await revokeUserSessions(id, 'deactivated', trx);
      trx.afterCommit(() => closeUserStreams(id));
    }
    await audit(req, { action: changes.role ? 'user.role_change' : 'user.update', entityType: 'user', entityId: id, details: { fields: Object.keys(data), ...changes } }, trx);
    return getUserTx(trx, id);
  });
}

async function getUserTx(trx, id) {
  const row = await trx('users as u').join('roles as r', 'r.id', 'u.role_id').leftJoin('staff as st', 'st.user_id', 'u.id').leftJoin('departments as dep', 'dep.id', 'st.department_id').where('u.id', id).first(userSelect);
  return toDto(row);
}

/** UC-07: archive the account data, then remove the account so it can no longer log in. */
export async function deleteUser(req, id, reason) {
  if (Number(id) === req.user.id) {
    await audit(req, { action: 'user.delete', entityType: 'user', entityId: id, status: 'failure', details: { reason: 'self_delete' } });
    throw badRequest('You cannot delete your own account.', { code: 'SELF_DELETE' });
  }
  return transaction(async (trx) => {
    const user = await trx('users as u').join('roles as r', 'r.id', 'u.role_id').where('u.id', id).whereNull('u.deleted_at').first('u.*', 'r.code as role_code');
    if (!user) throw notFound('User not found.');
    const staff = await trx('staff').where({ user_id: id }).first();
    const doctor = staff ? await trx('doctors').where({ staff_id: staff.id }).first() : null;
    if (doctor) {
      const upcoming = await trx('appointments').where({ doctor_id: doctor.id }).whereIn('status', ['scheduled', 'cancellation_requested']).where('appointment_date', '>=', todayStr()).count({ n: '*' }).first();
      if (upcoming.n > 0) throw conflict(`This doctor has ${upcoming.n} upcoming appointment(s). Cancel or reschedule them before removing the doctor.`);
      const active = await trx('admissions').where({ attending_doctor_id: doctor.id, status: 'active' }).count({ n: '*' }).first();
      if (active.n > 0) throw conflict('This doctor is attending admitted patients. Reassign them before removing the doctor.');
    }
    const { password_hash: _ph, ...safeUser } = user;
    await trx('archived_users').insert({ original_user_id: id, snapshot: JSON.stringify({ user: safeUser, staff, doctor }), reason: reason ?? null, archived_by: req.user.id });
    await trx('users').where({ id }).update({
      status: 'deleted', deleted_at: new Date(), username: `deleted-${id}`, email: null, phone: null, password_hash: null, updated_at: new Date(),
    });
    if (doctor) await trx('doctors').where({ id: doctor.id }).update({ is_active: false, updated_at: new Date() });
    await trx('patients').where({ user_id: id }).update({ user_id: null });
    await revokeUserSessions(id, 'deleted', trx);
    trx.afterCommit(() => closeUserStreams(Number(id)));
    await audit(req, { action: 'user.delete', entityType: 'user', entityId: id, details: { username: user.username, role: user.role_code, archived: true } }, trx);
  });
}

export async function unlockUser(req, id) {
  const n = await db('users').where({ id }).whereNull('deleted_at').update({ locked_until: null, failed_login_count: 0 });
  if (!n) throw notFound('User not found.');
  await audit(req, { action: 'user.unlock', entityType: 'user', entityId: id });
}

export async function adminResetPassword(req, id) {
  const tempPassword = generateTempPassword();
  await transaction(async (trx) => {
    const n = await trx('users').where({ id }).whereNull('deleted_at').update({ password_hash: await hashPassword(tempPassword), must_change_password: true, locked_until: null, failed_login_count: 0 });
    if (!n) throw notFound('User not found.');
    await revokeUserSessions(id, 'admin_password_reset', trx);
    await audit(req, { action: 'user.password_reset_by_admin', entityType: 'user', entityId: id }, trx);
  });
  return { tempPassword };
}

// ----------------------------------------------------------------- roles & permissions
export async function listRolesWithPermissions() {
  const roles = await db('roles').orderBy('id');
  const perms = await db('permissions').orderBy(['module', 'code']);
  const links = await db('role_permissions');
  return {
    roles: roles.map((r) => ({ id: r.id, code: r.code, name: r.name, description: r.description, isStaff: r.is_staff, permissions: links.filter((l) => l.role_id === r.id).map((l) => perms.find((p) => p.id === l.permission_id)?.code).filter(Boolean) })),
    permissions: perms.map((p) => ({ code: p.code, module: p.module, description: p.description })),
  };
}

// Safeguard: the admin role must keep the ability to manage users and roles, otherwise
// nobody could ever fix the matrix again.
const LOCKED = { admin: ['users.manage', 'roles.manage'] };

export async function setRolePermissions(req, roleCode, permissionCodes) {
  return transaction(async (trx) => {
    const role = await roleByCode(roleCode, trx);
    const perms = await trx('permissions').whereIn('code', permissionCodes);
    if (perms.length !== new Set(permissionCodes).size) throw badRequest('One or more permissions are not valid.');
    for (const p of LOCKED[roleCode] ?? []) {
      if (!permissionCodes.includes(p)) throw badRequest(`The ${role.name} role must keep the "${p}" permission.`);
    }
    if (roleCode === 'patient' && perms.some((p) => p.code !== 'portal.self')) throw badRequest('Patients can only hold the patient portal permission.');
    const before = (await trx('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').where('rp.role_id', role.id).select('p.code')).map((r) => r.code);
    await trx('role_permissions').where({ role_id: role.id }).del();
    if (perms.length) await trx('role_permissions').insert(perms.map((p) => ({ role_id: role.id, permission_id: p.id })));
    const added = permissionCodes.filter((c) => !before.includes(c));
    const removed = before.filter((c) => !permissionCodes.includes(c));
    await audit(req, { action: 'role.permissions_change', entityType: 'role', entityId: role.code, details: { added, removed } }, trx);
    return { added, removed, effective: 'next_login' };
  });
}
