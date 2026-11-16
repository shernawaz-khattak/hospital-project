// Minimal structured logger. Never log passwords, tokens or decrypted patient data.
import { isTest } from '../config/env.js';

const write = (level, msg, extra) => {
  if (isTest && level !== 'error') return;
  const line = { t: new Date().toISOString(), level, msg };
  if (extra instanceof Error) line.error = { message: extra.message, stack: extra.stack, code: extra.code };
  else if (extra !== undefined) line.extra = extra;
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
};

export const logger = {
  info: (msg, extra) => write('info', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  error: (msg, extra) => write('error', msg, extra),
};
