// Create the first production administrator from Render's one-time environment values.
// Demo fixtures are deliberately not used in production.
import bcrypt from 'bcryptjs';
import { db, closeDb } from '../src/db/knex.js';
import { env, isProd } from '../src/config/env.js';
import { seedRbac } from '../src/db/seed/rbac.js';
import { todayStr } from '../src/lib/dates.js';

const required = ['BOOTSTRAP_ADMIN_USERNAME', 'BOOTSTRAP_ADMIN_NAME', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD'];

async function bootstrapAdmin() {
  if (!isProd) throw new Error('The production administrator bootstrap can only run in production.');

  let adminRole = await db('roles').where({ code: 'admin' }).first();
  if (!adminRole) {
    await seedRbac(db);
    adminRole = await db('roles').where({ code: 'admin' }).first();
  }

  const existingAdmin = await db('users as u')
    .join('roles as r', 'r.id', 'u.role_id')
    .where('r.code', 'admin')
    .whereNull('u.deleted_at')
    .first('u.id');
  if (existingAdmin) {
    console.info('Production administrator already exists; bootstrap skipped.');
    return;
  }

  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length) {
    throw new Error(`No production administrator exists. Configure ${missing.join(', ')} to create one.`);
  }

  const username = process.env.BOOTSTRAP_ADMIN_USERNAME.trim();
  const fullName = process.env.BOOTSTRAP_ADMIN_NAME.trim();
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw new Error('BOOTSTRAP_ADMIN_USERNAME must be 3–40 letters, numbers, dots, underscores, or hyphens.');
  if (fullName.length < 2 || fullName.length > 200) throw new Error('BOOTSTRAP_ADMIN_NAME must be 2–200 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email address.');
  if (password.length < 8 || password.length > 128 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be 8–128 characters and include uppercase, lowercase, and numeric characters.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.transaction(async (trx) => {
    const alreadyCreated = await trx('users as u')
      .join('roles as r', 'r.id', 'u.role_id')
      .where('r.code', 'admin')
      .whereNull('u.deleted_at')
      .forUpdate('u')
      .first('u.id');
    if (alreadyCreated) return;

    const [user] = await trx('users').insert({
      username,
      full_name: fullName,
      email,
      role_id: adminRole.id,
      password_hash: passwordHash,
      must_change_password: false,
      password_changed_at: new Date(),
    }).returning(['id']);
    await trx('staff').insert({
      user_id: user.id,
      employee_code: 'EMP-ADMIN-001',
      designation: 'Hospital Administrator',
      date_joined: todayStr(),
    });
  });
  console.info('Initial production administrator created. Remove BOOTSTRAP_ADMIN_* values from the Render service after successful startup.');
}

bootstrapAdmin().catch((error) => {
  console.error('Production administrator bootstrap failed:', error.message);
  process.exitCode = 1;
}).finally(closeDb);
