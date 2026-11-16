// Field-level encryption for sensitive patient data (SRS NFR-03).
// AES-256-GCM gives confidentiality + integrity; a separate HMAC key produces a
// deterministic "blind index" so encrypted values (e.g. national ID) can still be
// checked for duplicates without decrypting every row.
import crypto from 'node:crypto';
import { env, isProd, isTest } from '../config/env.js';

function loadKey(hex, label) {
  if (hex) {
    const value = String(hex).trim();
    const isHex = /^[0-9a-f]{64}$/i.test(value);
    const buf = isHex ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
    const canonicalBase64 = buf.toString('base64').replace(/=+$/, '');
    if (buf.length !== 32 || (!isHex && canonicalBase64 !== value.replace(/=+$/, ''))) {
      throw new Error(`${label} must encode exactly 32 bytes as 64 hexadecimal characters or valid base64.`);
    }
    return buf;
  }
  if (isProd) throw new Error(`${label} is required in production.`);
  if (!isTest) console.warn(`[security] ${label} is not set: using a fixed DEVELOPMENT key. Never use this configuration with real patient data.`);
  // Deterministic development key so seeded demo data stays readable across restarts.
  return crypto.createHash('sha256').update(`hms-development-${label}`).digest();
}

const ENC_KEY = loadKey(env.DATA_ENCRYPTION_KEY, 'DATA_ENCRYPTION_KEY');
const IDX_KEY = loadKey(env.BLIND_INDEX_KEY, 'BLIND_INDEX_KEY');
const VERSION = 'v1';

export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(payload) {
  if (!payload) return null;
  const [version, ivB64, tagB64, dataB64] = String(payload).split(':');
  if (version !== VERSION) throw new Error('Unsupported ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function blindIndex(value) {
  if (!value) return null;
  const normalised = String(value).replace(/[\s-]/g, '').toUpperCase();
  return crypto.createHmac('sha256', IDX_KEY).update(normalised).digest('hex');
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function generateTempPassword() {
  // Readable but strong: 4 groups, mixed classes, satisfies the password policy.
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (s) => s[crypto.randomInt(s.length)];
  const parts = [pick(upper), pick(lower), pick(lower), pick(digits), pick(digits)];
  for (let i = 0; i < 7; i++) parts.push(pick(upper + lower + digits));
  return `${parts.join('')}!`;
}
