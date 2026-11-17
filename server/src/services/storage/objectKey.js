import { randomUUID } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const REPORT_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg']);

export function patientReportKey(patientId, extension) {
  const id = String(patientId);
  const ext = String(extension || '').toLowerCase().replace(/^\./, '');
  if (!SAFE_ID.test(id) || !REPORT_EXTENSIONS.has(ext)) {
    throw new TypeError('Invalid patient report object identity.');
  }
  return `lab-reports/${id}/${randomUUID()}.${ext}`;
}

export function backupObjectKey(fileName) {
  const name = String(fileName || '');
  if (!SAFE_BACKUP_NAME.test(name) || name.includes('..')) {
    throw new TypeError('Invalid backup object name.');
  }
  return `backups/${name}`;
}
