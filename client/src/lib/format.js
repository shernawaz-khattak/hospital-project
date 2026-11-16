// Display formatting. Dates/times come from the API either as YYYY-MM-DD calendar values
// (shown as-is, in the hospital's zone) or as ISO timestamps.
let currency = 'PKR';
export const setCurrency = (c) => { currency = c || currency; };

// All clock times are shown in the hospital's timezone (from the server), not the browser's,
// so staff on any device see the same appointment and record times.
let timeZone;
export const setTimezone = (tz) => { timeZone = tz || undefined; };
function parts(value) {
  const dt = value instanceof Date ? value : new Date(value);
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(dt)) out[p.type] = p.value;
  return { y: Number(out.year), m: Number(out.month), d: Number(out.day), hh: out.hour, mm: out.minute };
}
export const hospitalHour = () => Number(parts(new Date()).hh);

export const money = (n, { symbol = true } = {}) => {
  const v = Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return symbol ? `${currency} ${v}` : v;
};
export const moneyShort = (n) => {
  const v = Number(n ?? 0);
  if (Math.abs(v) >= 1e6) return `${currency} ${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${currency} ${(v / 1e3).toFixed(1)}k`;
  return `${currency} ${v.toFixed(0)}`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function date(value) {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }
  const p = parts(value);
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}
export const time = (value) => {
  if (!value) return '—';
  if (/^\d{2}:\d{2}/.test(value)) return value.slice(0, 5);
  const p = parts(value);
  return `${p.hh}:${p.mm}`;
};
export const dateTime = (value) => (value ? `${date(value)}, ${time(value)}` : '—');
export const weekday = (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${d}T12:00:00`).getDay()];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function relative(value) {
  if (!value) return '';
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return date(value);
}

export const minutes = (m) => (m == null ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
export const bytes = (n) => (n == null ? '—' : n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export const today = () => {
  const p = parts(new Date());
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};
export const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

const ACRONYMS = { icu: 'ICU', opd: 'OPD', ipd: 'IPD', stat: 'STAT' };
export const titleCase = (s) => ACRONYMS[s] ?? String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

// Status vocabulary shared by all modules: label + tone.
const S = (label, tone) => ({ label, tone });
export const STATUS = {
  scheduled: S('Scheduled', 'info'), completed: S('Completed', 'ok'), cancelled: S('Cancelled', 'neutral'), no_show: S('No-show', 'caution'),
  cancellation_requested: S('Awaiting cancel approval', 'caution'), rescheduled: S('Rescheduled', 'neutral'),
  out_patient: S('Out-patient', 'neutral'), in_patient: S('In-patient', 'info'), discharged: S('Discharged', 'ok'), inactive: S('Inactive', 'neutral'),
  active: S('Active', 'ok'), deleted: S('Deleted', 'neutral'),
  available: S('Available', 'ok'), occupied: S('Occupied', 'info'), maintenance: S('Maintenance', 'caution'),
  pending: S('Pending', 'caution'), verified: S('Verified', 'info'), flagged: S('Flagged', 'alert'), dispensed: S('Dispensed', 'ok'), partially_dispensed: S('Partly dispensed', 'caution'),
  requested: S('Requested', 'caution'), in_progress: S('In progress', 'info'), delayed: S('Delayed', 'alert'), reported: S('Reported', 'ok'),
  unpaid: S('Unpaid', 'alert'), partially_paid: S('Partly paid', 'caution'), paid: S('Paid', 'ok'),
  waiting: S('Waiting', 'caution'), notified: S('Slot offered', 'info'), booked: S('Booked', 'ok'),
  approved: S('Approved', 'ok'), rejected: S('Rejected', 'alert'), fulfilled: S('Fulfilled', 'ok'),
  open: S('Open', 'caution'), resolved: S('Resolved', 'ok'),
  success: S('Success', 'ok'), failure: S('Failed', 'alert'), failed: S('Failed', 'alert'), denied: S('Denied', 'alert'), running: S('Running', 'info'),
  healthy: S('Healthy', 'ok'), degraded: S('Degraded', 'caution'), down: S('Down', 'alert'), ok: S('OK', 'ok'), warning: S('Warning', 'caution'), error: S('Error', 'alert'),
  delivered: S('Delivered', 'ok'), captured: S('Captured (dev outbox)', 'caution'), skipped: S('Not sent', 'neutral'),
  routine: S('Routine', 'neutral'), urgent: S('Urgent', 'caution'), stat: S('STAT', 'alert'), emergency: S('Emergency', 'alert'),
  mild: S('Mild', 'neutral'), moderate: S('Moderate', 'caution'), severe: S('Severe', 'alert'), critical: S('Critical', 'alert'),
  expired: S('Expired', 'alert'), expiring: S('Expires ≤ 30 days', 'caution'),
};
export const statusOf = (s) => STATUS[s] ?? S(titleCase(s), 'neutral');

export const ROLE_LABEL = { patient: 'Patient', receptionist: 'Receptionist', nurse: 'Nurse', doctor: 'Doctor', lab_technician: 'Lab Technician', pharmacist: 'Pharmacist', accountant: 'Accountant', admin: 'Admin', system_admin: 'System Administrator' };
