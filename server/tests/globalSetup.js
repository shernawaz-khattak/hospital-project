// Prepares a dedicated disposable test database before integration tests.
import 'dotenv/config';
import { assertDisposableTestDatabase } from '../src/db/testSafety.js';

export default async function setup() {
  process.env.NODE_ENV = 'test';
  assertDisposableTestDatabase(process.env);

  const { db, closeDb } = await import('../src/db/knex.js');
  await db.migrate.rollback(undefined, true);
  await db.migrate.latest();
  await closeDb();
}
