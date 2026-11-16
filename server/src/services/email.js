// Email transport abstraction.
//  - SMTP configured  -> real delivery through nodemailer   (delivery status 'delivered')
//  - not configured, non-production -> development outbox table (status 'captured':
//    the message is stored locally and was NOT delivered to a mailbox)
//  - not configured, production -> no transport            (status 'skipped')
import nodemailer from 'nodemailer';
import { env, isProd } from '../config/env.js';
import { db } from '../db/knex.js';

let transporter = null;
if (env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
}

export const emailMode = () => (transporter ? 'smtp' : isProd ? 'disabled' : 'dev-outbox');

// Test hook: lets the test-suite simulate a failing mail server to exercise retries.
let failureInjector = null;
export function __setEmailFailureInjector(fn) {
  failureInjector = fn;
}

/** @returns {Promise<'delivered'|'captured'|'skipped'>} throws on transport failure */
export async function sendEmail({ to, subject, text }) {
  if (failureInjector) failureInjector({ to, subject });
  if (transporter) {
    await transporter.sendMail({ from: env.SMTP_FROM, to, subject, text });
    return 'delivered';
  }
  if (!isProd) {
    await db('outbound_emails').insert({ to_address: to, subject, body_text: text });
    return 'captured';
  }
  return 'skipped';
}
