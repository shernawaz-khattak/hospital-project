import { describe, expect, it } from 'vitest';
import {
  assertDisposableTestDatabase,
  databaseIdentityKey,
  credentialIdentity,
  parseDatabaseUrl,
  TEST_DATABASE_RESET_CONFIRM,
} from '../src/db/testSafety.js';

const safeEnv = () => ({
  NODE_ENV: 'test',
  TEST_DATABASE_URL: 'postgresql://hms_test_user@localhost:5432/hms_integration_test',
  DATABASE_URL: 'postgresql://hms_app@localhost:5432/hms',
  ALLOW_TEST_DATABASE_RESET: 'true',
  TEST_DATABASE_RESET_CONFIRM,
});

describe('disposable database safety', () => {
  it('compares host, port and database without credentials', () => {
    const first = parseDatabaseUrl('postgresql://same@localhost:5432/hms_test');
    const second = parseDatabaseUrl('postgresql://same@localhost:5433/hms_test');
    expect(databaseIdentityKey(first)).not.toBe(databaseIdentityKey(second));
  });

  it('rejects the same database with different usernames', () => {
    const env = safeEnv();
    env.DATABASE_URL = 'postgresql://admin@localhost:5432/hms';
    env.TEST_DATABASE_URL = 'postgresql://tester@localhost:5432/hms';
    expect(() => assertDisposableTestDatabase(env)).toThrow(/matches DATABASE_URL/);
  });

  it('rejects the same database with different passwords', () => {
    const env = safeEnv();
    env.DATABASE_URL = 'postgresql://admin:old@localhost:5432/hms';
    env.TEST_DATABASE_URL = 'postgresql://admin:new@localhost:5432/hms';
    expect(() => assertDisposableTestDatabase(env)).toThrow(/matches DATABASE_URL/);
  });

  it('rejects the same database with different usernames and passwords', () => {
    const env = safeEnv();
    env.DATABASE_URL = 'postgresql://admin:old@localhost:5432/hms';
    env.TEST_DATABASE_URL = 'postgresql://tester:new@localhost:5432/hms';
    expect(() => assertDisposableTestDatabase(env)).toThrow(/matches DATABASE_URL/);
  });

  it('allows different database names on the same server', () => {
    expect(databaseIdentityKey(parseDatabaseUrl('postgresql://same@localhost:5432/hms'))).not.toBe(
      databaseIdentityKey(parseDatabaseUrl('postgresql://same@localhost:5432/hms_test')),
    );
  });

  it('distinguishes ports', () => {
    expect(databaseIdentityKey(parseDatabaseUrl('postgresql://same@localhost:5432/hms'))).not.toBe(
      databaseIdentityKey(parseDatabaseUrl('postgresql://same@localhost:5433/hms')),
    );
  });

  it('normalizes localhost and 127.0.0.1 as the same target', () => {
    expect(databaseIdentityKey(parseDatabaseUrl('postgresql://same@localhost:5432/hms'))).toBe(
      databaseIdentityKey(parseDatabaseUrl('postgresql://same@127.0.0.1:5432/hms')),
    );
  });

  it('normalizes localhost and IPv6 loopback as the same target', () => {
    expect(databaseIdentityKey(parseDatabaseUrl('postgresql://same@localhost:5432/hms'))).toBe(
      databaseIdentityKey(parseDatabaseUrl('postgresql://same@[::1]:5432/hms')),
    );
  });

  it('keeps credentials separate when targets match', () => {
    const first = parseDatabaseUrl('postgresql://admin:old@localhost:5432/hms');
    const second = parseDatabaseUrl('postgresql://tester:new@localhost:5432/hms');
    expect(databaseIdentityKey(first)).toBe(databaseIdentityKey(second));
    expect(credentialIdentity(first)).not.toBe(credentialIdentity(second));
  });

  it('accepts an explicitly disposable database configuration', () => {
    expect(() => assertDisposableTestDatabase(safeEnv())).not.toThrow();
  });

  it('rejects development mode', () => {
    expect(() => assertDisposableTestDatabase({ ...safeEnv(), NODE_ENV: 'development' })).toThrow(/NODE_ENV=test/);
  });

  it('rejects missing reset confirmation', () => {
    expect(() => assertDisposableTestDatabase({ ...safeEnv(), TEST_DATABASE_RESET_CONFIRM: '' })).toThrow(/TEST_DATABASE_RESET_CONFIRM/);
  });

  it('rejects an identical database identity', () => {
    const env = safeEnv();
    env.DATABASE_URL = env.TEST_DATABASE_URL;
    expect(() => assertDisposableTestDatabase(env)).toThrow(/matches DATABASE_URL/);
  });

  it('rejects production-looking names', () => {
    expect(() => assertDisposableTestDatabase({
      ...safeEnv(),
      TEST_DATABASE_URL: 'postgresql://hms_test_user@localhost:5432/hms_production_test',
    })).toThrow(/production/);
  });

  it('rejects ambiguous production URLs', () => {
    expect(() => assertDisposableTestDatabase({ ...safeEnv(), DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL.*invalid/);
  });

  it('requires explicit allowlisting for remote test hosts', () => {
    expect(() => assertDisposableTestDatabase({
      ...safeEnv(),
      TEST_DATABASE_URL: 'postgresql://hms_test_user@db.example.invalid:5432/hms_integration_test',
    })).toThrow(/not allowlisted/);
  });
});
