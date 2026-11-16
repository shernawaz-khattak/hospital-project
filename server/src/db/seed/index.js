// Seeds a complete demo dataset. Destroys existing data in the target database first.
// Usage: npm run seed   (uses DATABASE_URL; refuses to run when NODE_ENV=production)
import { pathToFileURL } from 'node:url';
import { db, closeDb } from '../knex.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env, isProd } from '../../config/env.js';
import { seedRbac } from './rbac.js';
import { seedOrganization, DEMO_PASSWORD } from './organization.js';
import { seedCatalogs } from './catalogs.js';
import { seedPatients } from './patients.js';
import { seedActivity } from './activity.js';
import { assertDisposableTestDatabase } from '../testSafety.js';

export async function truncateAll(knex) {
  const { rows } = await knex.raw("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'knex_%'");
  // audit_logs / diagnoses are append-only: TRUNCATE bypasses row triggers by design (admin reset only).
  await knex.raw(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  for (const seq of ['patient_code_seq', 'appointment_code_seq', 'admission_code_seq', 'visit_code_seq', 'prescription_code_seq', 'lab_request_code_seq', 'bill_number_seq', 'payment_number_seq', 'receipt_number_seq']) {
    await knex.raw(`ALTER SEQUENCE ${seq} RESTART WITH 1`);
  }
}

export async function seedAll(knex, { withActivity = true } = {}) {
  assertDisposableTestDatabase(process.env);
  await truncateAll(knex);
  // Remove report files left by a previous seed (their database rows were just truncated).
  if (env.STORAGE_PROVIDER === 'local') {
    await fs.rm(path.resolve(env.UPLOAD_DIR, 'lab-reports'), { recursive: true, force: true });
  }
  await seedRbac(knex);
  const org = await seedOrganization(knex);
  const catalogs = await seedCatalogs(knex, org);
  const patients = await seedPatients(knex, org, catalogs);
  if (withActivity) await seedActivity(knex, { ...org, ...catalogs, ...patients });
  return { ...org, ...catalogs, ...patients };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (isProd || env.NODE_ENV !== 'test') {
    console.error('Refusing to seed: demo seeding is destructive and requires a disposable integration-test database.');
    process.exit(1);
  }
  seedAll(db)
    .then(() => {
      console.log(`Demo data seeded. All demo accounts use the password: ${DEMO_PASSWORD}`);
      console.log('See README.md → "Demo accounts" for the usernames.');
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
