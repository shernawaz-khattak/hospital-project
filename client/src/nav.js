// Navigation per permission. Each department has a wayfinding colour (see tailwind.config.js).
import {
  Activity, BadgeDollarSign, BarChart3, BedDouble, Bell, Building2, CalendarClock, ClipboardList, DatabaseBackup, FileText, FlaskConical,
  HeartPulse, LayoutDashboard, ListChecks, ListOrdered, Pill, Receipt, ScrollText, ShieldCheck, Stethoscope, UserCog, UserPlus, Users, Warehouse, AlertOctagon, CalendarX,
} from 'lucide-react';

export const NAV = [
  { group: null, items: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, way: 'home', staff: true }] },
  {
    group: 'Patients & appointments', way: 'patients',
    items: [
      { to: '/patients', label: 'Patients', icon: Users, perm: ['patients.view'], way: 'patients', hideFor: ['doctor'], end: true },
      { to: '/patients/new', label: 'Register patient', icon: UserPlus, perm: ['patients.create'], way: 'patients' },
      { to: '/appointments', label: 'Appointments', icon: CalendarClock, perm: ['appointments.manage'], way: 'appointments' },
      { to: '/waitlist', label: 'Waitlist', icon: ListOrdered, perm: ['waitlist.manage'], way: 'appointments' },
    ],
  },
  {
    group: 'Wards', way: 'wards',
    items: [
      { to: '/wards/board', label: 'Bed board', icon: BedDouble, perm: ['wards.view', 'admissions.manage'], way: 'wards' },
      { to: '/admissions', label: 'Admissions', icon: ClipboardList, perm: ['admissions.manage'], way: 'wards' },
      { to: '/wards', label: 'Wards & beds', icon: Building2, perm: ['wards.configure'], way: 'wards', end: true },
    ],
  },
  {
    group: 'Clinical care', way: 'clinical',
    items: [
      { to: '/doctor/schedule', label: 'My schedule', icon: CalendarClock, perm: ['clinical.record'], way: 'clinical' },
      { to: '/doctor/patients', label: 'My patients', icon: Stethoscope, perm: ['clinical.view'], way: 'clinical' },
      { to: '/doctor/flagged', label: 'Flagged prescriptions', icon: AlertOctagon, perm: ['prescriptions.create'], way: 'clinical' },
    ],
  },
  {
    group: 'Nursing', way: 'clinical',
    items: [
      { to: '/nursing/roster', label: 'Nurse roster', icon: CalendarClock, perm: ['nursing.roster.view', 'nursing.roster.manage'], way: 'clinical' },
    ],
  },
  {
    group: 'Laboratory', way: 'lab',
    items: [
      { to: '/lab/requests', label: 'Lab requests', icon: FlaskConical, perm: ['lab.process'], way: 'lab' },
      { to: '/lab/reports', label: 'Report history', icon: FileText, perm: ['lab.process'], way: 'lab' },
      { to: '/lab/tests', label: 'Test catalogue', icon: ListChecks, perm: ['lab.catalog'], way: 'lab' },
    ],
  },
  {
    group: 'Pharmacy', way: 'pharmacy',
    items: [
      { to: '/pharmacy/prescriptions', label: 'Prescriptions', icon: Pill, perm: ['pharmacy.verify', 'pharmacy.dispense'], way: 'pharmacy' },
      { to: '/pharmacy/inventory', label: 'Inventory', icon: Warehouse, perm: ['inventory.manage'], way: 'pharmacy' },
      { to: '/pharmacy/expiry', label: 'Expiry tracker', icon: CalendarX, perm: ['inventory.manage'], way: 'pharmacy' },
      { to: '/pharmacy/alerts', label: 'Stock alerts', icon: Bell, perm: ['inventory.manage'], way: 'pharmacy' },
    ],
  },
  {
    group: 'Finance', way: 'billing',
    items: [
      { to: '/billing', label: 'Billing', icon: BadgeDollarSign, perm: ['billing.manage'], way: 'billing', end: true },
      { to: '/billing/bills', label: 'All bills', icon: Receipt, perm: ['billing.view'], way: 'billing', hideFor: ['receptionist'] },
      { to: '/billing/insurance', label: 'Insurance providers', icon: ShieldCheck, perm: ['insurance.manage'], way: 'billing' },
      { to: '/reports/financial', label: 'Financial reports', icon: BarChart3, perm: ['reports.financial'], way: 'billing' },
    ],
  },
  {
    group: 'Administration', way: 'admin',
    items: [
      { to: '/admin/users', label: 'Users', icon: UserCog, perm: ['users.manage'], way: 'admin' },
      { to: '/admin/roles', label: 'Roles & permissions', icon: ShieldCheck, perm: ['roles.manage'], way: 'admin' },
      { to: '/admin/doctors', label: 'Doctors', icon: Stethoscope, perm: ['doctors.manage'], way: 'admin' },
      { to: '/admin/departments', label: 'Departments', icon: Building2, perm: ['departments.manage'], way: 'admin' },
      { to: '/admin/staffing', label: 'Staffing levels', icon: Users, perm: ['staffing.manage'], way: 'admin' },
      { to: '/admin/staff', label: 'Staff list', icon: ClipboardList, perm: ['staff.view'], way: 'admin' },
      { to: '/admin/nurses', label: 'Nurses', icon: Users, perm: ['staff.view'], way: 'admin' },
      { to: '/admin/cancellations', label: 'Cancellation approvals', icon: CalendarX, perm: ['appointments.approve_cancellation'], way: 'admin' },
      { to: '/reports/operational', label: 'Operational reports', icon: BarChart3, perm: ['reports.operational'], way: 'admin' },
    ],
  },
  {
    group: 'System', way: 'system',
    items: [
      { to: '/system/health', label: 'System health', icon: HeartPulse, perm: ['system.health'], way: 'system' },
      { to: '/system/backups', label: 'Backups', icon: DatabaseBackup, perm: ['system.backup'], way: 'system' },
      { to: '/system/notifications', label: 'Notification log', icon: Activity, perm: ['system.health'], way: 'system' },
      { to: '/system/audit', label: 'Audit log', icon: ScrollText, perm: ['audit.view'], way: 'system' },
    ],
  },
];

export const PORTAL_NAV = [
  { group: null, items: [
    { to: '/portal', label: 'Overview', icon: LayoutDashboard, way: 'portal', end: true },
    { to: '/portal/appointments', label: 'Appointments', icon: CalendarClock, way: 'appointments' },
    { to: '/portal/lab-reports', label: 'Lab reports', icon: FlaskConical, way: 'lab' },
    { to: '/portal/bills', label: 'Bills & payments', icon: Receipt, way: 'billing' },
    { to: '/portal/records', label: 'My health record', icon: FileText, way: 'clinical' },
  ] },
];

export function navFor(user) {
  if (!user) return [];
  if (user.role === 'patient') return PORTAL_NAV;
  const has = (perms) => !perms || perms.some((p) => user.permissions.includes(p));
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => has(i.perm) && (!i.role || [].concat(i.role).includes(user.role)) && !(i.hideFor ?? []).includes(user.role)) })).filter((g) => g.items.length);
}
