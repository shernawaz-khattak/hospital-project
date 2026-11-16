import { PERMISSIONS, ROLES, DEFAULT_ROLE_PERMISSIONS } from '../../auth/permissions.js';

/** Idempotent: inserts/updates roles and permissions and resets role defaults. */
export async function seedRbac(knex, { resetMatrix = true } = {}) {
  for (const [code, r] of Object.entries(ROLES)) {
    await knex('roles').insert({ code, name: r.name, description: r.description, is_staff: r.isStaff }).onConflict('code').merge(['name', 'description', 'is_staff']);
  }
  for (const [code, [module, description]] of Object.entries(PERMISSIONS)) {
    await knex('permissions').insert({ code, module, description }).onConflict('code').merge(['module', 'description']);
  }
  if (!resetMatrix) return;
  const roles = await knex('roles');
  const perms = await knex('permissions');
  for (const role of roles) {
    await knex('role_permissions').where({ role_id: role.id }).del();
    const codes = DEFAULT_ROLE_PERMISSIONS[role.code] ?? [];
    const rows = codes.map((c) => ({ role_id: role.id, permission_id: perms.find((p) => p.code === c).id }));
    if (rows.length) await knex('role_permissions').insert(rows);
  }
}
