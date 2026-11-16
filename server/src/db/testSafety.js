export const TEST_DATABASE_RESET_CONFIRM = 'HMS_DISPOSABLE_DATABASE_RESET';

export function parseDatabaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const url = new URL(rawUrl.trim());
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') return null;
    return {
      host: normalizeHost(url.hostname),
      port: url.port || '5432',
      database: decodeURIComponent(url.pathname.replace(/^\/+/, '')).toLowerCase(),
      username: url.username ? decodeURIComponent(url.username).toLowerCase() : '',
      password: url.password ? decodeURIComponent(url.password) : '',
    };
  } catch {
    return null;
  }
}

export function normalizeHost(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1'].includes(value) ? 'localhost' : value;
}

export function databaseIdentity(location) {
  return `${location.host}:${location.port}/${location.database} (user=${location.username || '<missing>'})`;
}

export function databaseIdentityKey(location) {
  return `${location.host}:${location.port}/${location.database}`;
}

export function credentialIdentity(location) {
  return `${location.username}:${location.password}`;
}

export function looksLikeProductionDatabase(location) {
  const combined = `${location.host}/${location.database}`;
  return /(^|[-_.])(prod|production|live|primary)([-_.]|$)/i.test(combined);
}

export function assertDisposableTestDatabase(env) {
  if (env.NODE_ENV !== 'test') throw new Error('Disposable database operations require NODE_ENV=test.');
  if (!env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required.');
  if (String(env.ALLOW_TEST_DATABASE_RESET).toLowerCase() !== 'true') throw new Error('ALLOW_TEST_DATABASE_RESET=true is required.');
  if (env.TEST_DATABASE_RESET_CONFIRM !== TEST_DATABASE_RESET_CONFIRM) {
    throw new Error(`TEST_DATABASE_RESET_CONFIRM must equal ${TEST_DATABASE_RESET_CONFIRM}.`);
  }

  const test = parseDatabaseUrl(env.TEST_DATABASE_URL);
  if (!test) throw new Error('TEST_DATABASE_URL is missing or is not a valid PostgreSQL URL.');
  if (!test.username) throw new Error('TEST_DATABASE_URL must include a username.');
  if (looksLikeProductionDatabase(test)) throw new Error(`TEST_DATABASE_URL looks like production: ${databaseIdentity(test)}.`);

  if (env.DATABASE_URL) {
    const production = parseDatabaseUrl(env.DATABASE_URL);
    if (!production) throw new Error('DATABASE_URL is present but invalid, so database identity is ambiguous.');
    if (databaseIdentityKey(test) === databaseIdentityKey(production)) {
      throw new Error('TEST_DATABASE_URL matches DATABASE_URL.');
    }
  }

  const allowedHosts = String(env.TEST_DATABASE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => normalizeHost(host.trim()))
    .filter(Boolean);
  const localHosts = ['localhost'];
  if (!localHosts.includes(test.host) && !allowedHosts.includes(test.host)) {
    throw new Error(`Remote test host is not allowlisted: ${test.host}.`);
  }

  console.log(`[test-db] Target: ${databaseIdentity(test)}`);
  return test;
}
