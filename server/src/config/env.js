// Centralised, validated configuration. Every environment variable the server
// reads is declared here so it is documented in one place (see docs/ENVIRONMENT.md).
import 'dotenv/config';
import { z } from 'zod';

const bool = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOSPITAL_NAME: z.string().default('City General Hospital'),
  HOSPITAL_TZ: z.string().default('Asia/Karachi'),
  CURRENCY: z.string().default('PKR'),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGIN: z.string().optional(),

  TEST_DATABASE_ALLOWED_HOSTS: z.string().optional(),
  ALLOW_TEST_DATABASE_RESET: bool(false),
  TEST_DATABASE_RESET_CONFIRM: z.string().optional(),
  DATABASE_URL: z.string().url().optional(),
  TEST_DATABASE_URL: z.string().url().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),

  // 32-byte keys, hex encoded. Development defaults are generated from a fixed
  // string so the demo works out of the box; production refuses to start without real keys.
  DATA_ENCRYPTION_KEY: z.string().optional(),
  BLIND_INDEX_KEY: z.string().optional(),

  SESSION_IDLE_MINUTES: z.coerce.number().positive().default(10),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().positive().default(12),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(100),
  RESET_TOKEN_HOURS: z.coerce.number().positive().max(24).default(24),
  COOKIE_SECURE: bool(false),
  TRUST_PROXY: bool(false),

  HTTPS_KEY_PATH: z.string().optional(),
  HTTPS_CERT_PATH: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('HMS <no-reply@hospital.local>'),
  SMTP_SECURE: bool(false),

  UPLOAD_DIR: z.string().default('./storage/uploads'),
  BACKUP_DIR: z.string().default('./storage/backups'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  PG_DUMP_PATH: z.string().default('pg_dump'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),

  STORAGE_PROVIDER: z.enum(['local', 'r2']).default('local'),
  R2_ACCOUNT_ID: z.string().trim().optional(),
  R2_ACCESS_KEY_ID: z.string().trim().optional(),
  R2_SECRET_ACCESS_KEY: z.string().trim().optional(),
  R2_BUCKET_UPLOADS: z.string().trim().optional(),
  R2_BUCKET_BACKUPS: z.string().trim().optional(),
  R2_ENDPOINT: z.string().trim().optional(),
  R2_REGION: z.string().trim().min(1).default('auto'),

  ENABLE_SCHEDULER: bool(true),
  BACKUP_CRON: z.string().default('0 0 * * *'),
  HEALTH_CRON: z.string().default('0 * * * *'),
});

const productionStorageProvider = process.env.STORAGE_PROVIDER?.trim();
const isProductionEnvironment = process.env.NODE_ENV === 'production';
if (isProductionEnvironment && (!productionStorageProvider || productionStorageProvider === 'local')) {
  console.error('Production requires STORAGE_PROVIDER=r2; local storage is not permitted.');
  process.exit(1);
}

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

if (isProd && !env.DATABASE_URL) {
  console.error('DATABASE_URL is required in production.');
  process.exit(1);
}
if (isTest && !env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL is required in test environments.');
  process.exit(1);
}

// The hospital operates in a single local timezone; appointment dates/times are wall-clock
// values in this zone.
process.env.TZ = env.HOSPITAL_TZ;

if (isProd && (!env.DATA_ENCRYPTION_KEY || !env.BLIND_INDEX_KEY)) {
  console.error('DATA_ENCRYPTION_KEY and BLIND_INDEX_KEY must be set in production.');
  process.exit(1);
}

if (env.STORAGE_PROVIDER === 'r2') {
  const requiredR2 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_UPLOADS', 'R2_BUCKET_BACKUPS', 'R2_ENDPOINT'];
  const missing = requiredR2.filter((key) => !env[key]);
  if (missing.length) {
    console.error(`R2 storage selected but missing required configuration: ${missing.join(', ')}`);
    process.exit(1);
  }
  let protocol;
  try {
    protocol = new URL(env.R2_ENDPOINT).protocol;
  } catch {
    protocol = '';
  }
  if (protocol !== 'https:') {
    console.error('R2_ENDPOINT must be a valid HTTPS URL.');
    process.exit(1);
  }
  try {
    const endpointUrl = new URL(env.R2_ENDPOINT);
    if (endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash) {
      console.error('R2_ENDPOINT must not contain credentials or URL query/fragment data.');
      process.exit(1);
    }
    if (env.R2_ACCOUNT_ID && !endpointUrl.hostname.endsWith('.r2.cloudflarestorage.com')) {
      console.error('R2_ENDPOINT hostname is not a supported Cloudflare R2 endpoint.');
      process.exit(1);
    }
    const expectedHost = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    if (env.R2_ACCOUNT_ID && endpointUrl.hostname !== expectedHost) {
      console.error('R2_ENDPOINT does not match R2_ACCOUNT_ID.');
      process.exit(1);
    }
  } catch {
    console.error('R2_ENDPOINT is not a valid HTTPS URL.');
    process.exit(1);
  }
  for (const key of ['R2_BUCKET_UPLOADS', 'R2_BUCKET_BACKUPS']) {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,62}[A-Za-z0-9]$/.test(env[key]) || env[key].includes('..')) {
      console.error(`${key} is invalid.`);
      process.exit(1);
    }
  }
}
