// Permission catalogue and default role → permission matrix (docs/01-requirements-analysis.md §3).
// The catalogue is seeded into the `permissions` table; the admin can change the
// role matrix at runtime (FR-05). Changes apply on the user's next login (UC-06).

export const PERMISSIONS = {
  // Administration (SRS 5.3)
  'users.manage': ['admin', 'Create, edit, delete user accounts and assign roles'],
  'roles.manage': ['admin', 'Edit role permissions'],
  'doctors.manage': ['admin', 'Manage doctor profiles, specialization and schedules'],
  'departments.manage': ['admin', 'Create and manage departments'],
  'staffing.manage': ['admin', 'Define staffing levels'],
  'staff.view': ['admin', 'View staff list'],
  'appointments.approve_cancellation': ['admin', 'Approve cancellations within 1 hour of the appointment'],
  'nursing.roster.view': ['nursing', 'View the monthly nurse roster'],
  'nursing.roster.manage': ['nursing', 'Assign and save nurse duties'],

  // Patient access (SRS 5.4)
  'patients.view': ['patients', 'Search and view patient demographics'],
  'patients.create': ['patients', 'Register new patients'],
  'patients.update': ['patients', 'Update patient information'],
  'patients.portal_access': ['patients', 'Enable patient portal accounts'],
  'appointments.view': ['appointments', 'View appointments'],
  'appointments.manage': ['appointments', 'Book, cancel and reschedule appointments for any patient'],
  'waitlist.manage': ['appointments', 'Manage the appointment waitlist'],

  // Wards (SRS 5.5)
  'wards.view': ['wards', 'View wards, beds and occupancy'],
  'wards.configure': ['wards', 'Create wards and beds'],
  'admissions.manage': ['wards', 'Admit, assign beds, transfer and process discharges'],
  'admissions.request': ['wards', 'Recommend admission or transfer'],
  'discharge.approve': ['wards', 'Approve discharge (doctor) and discharge directly'],

  // Clinical care (SRS 5.6)
  'clinical.view': ['clinical', 'View patient history and medical records (care relationship)'],
  'clinical.record': ['clinical', 'Record visits, diagnoses and observations'],
  'prescriptions.create': ['clinical', 'Create digital prescriptions'],
  'lab.request': ['clinical', 'Request lab tests and specify parameters'],

  // Laboratory (SRS 5.7)
  'lab.process': ['lab', 'Process lab requests and upload reports'],
  'lab.catalog': ['lab', 'Manage the lab test catalogue'],

  // Pharmacy (SRS 5.8)
  'pharmacy.verify': ['pharmacy', 'Verify or flag prescriptions'],
  'pharmacy.dispense': ['pharmacy', 'Issue medicines'],
  'inventory.view': ['pharmacy', 'View medicine stock'],
  'inventory.manage': ['pharmacy', 'Manage inventory, restock alerts and expiry'],

  // Finance (SRS 5.9)
  'billing.view': ['billing', 'View bills and balances'],
  'billing.manage': ['billing', 'Generate bills and apply insurance'],
  'payments.record': ['billing', 'Record payments and issue receipts'],
  'insurance.manage': ['billing', 'Manage accepted insurance providers'],
  'reports.financial': ['reports', 'Financial reports and summaries'],
  'reports.operational': ['reports', 'Operational reports (patients, wards, appointments, lab, pharmacy)'],

  // System (SRS 5.10)
  'system.backup': ['system', 'Run and download database backups'],
  'storage.reconcile': ['system', 'Review and retry object-storage reconciliation'],
  'system.health': ['system', 'Run and view system health checks'],
  'audit.view': ['system', 'View the audit log'],

  // Patient self-service (SRS 5.11)
  'portal.self': ['portal', 'Patient portal: own profile, appointments, lab reports and bills'],
};

export const ROLES = {
  patient: { name: 'Patient', isStaff: false, description: 'Patient self-service portal' },
  receptionist: { name: 'Receptionist', isStaff: true, description: 'Registration, appointments and ward management' },
  nurse: { name: 'Nurse', isStaff: true, description: 'Ward care, admissions support and patient monitoring' },
  doctor: { name: 'Doctor', isStaff: true, description: 'Clinical care, prescriptions and lab requests' },
  lab_technician: { name: 'Lab Technician', isStaff: true, description: 'Processes lab tests and uploads results' },
  pharmacist: { name: 'Pharmacist', isStaff: true, description: 'Verifies prescriptions, dispenses medicine, manages inventory' },
  accountant: { name: 'Accountant', isStaff: true, description: 'Billing, payments, receipts and financial reports' },
  admin: { name: 'Admin', isStaff: true, description: 'Users, doctors, departments and staffing' },
  system_admin: { name: 'System Administrator', isStaff: true, description: 'Backups, system health and monitoring' },
};

export const DEFAULT_ROLE_PERMISSIONS = {
  patient: ['portal.self'],
  receptionist: [
    'patients.view', 'patients.create', 'patients.update', 'patients.portal_access',
    'appointments.view', 'appointments.manage', 'waitlist.manage',
    'wards.view', 'wards.configure', 'admissions.manage', 'billing.view', 'reports.operational',
  ],
  nurse: [
    'patients.view', 'appointments.view', 'wards.view', 'admissions.request',
    'clinical.view', 'clinical.record', 'nursing.roster.view',
  ],
  doctor: [
    'patients.view', 'appointments.view', 'wards.view', 'admissions.request', 'discharge.approve',
    'clinical.view', 'clinical.record', 'prescriptions.create', 'lab.request', 'inventory.view',
  ],
  lab_technician: ['lab.process', 'lab.catalog'],
  pharmacist: ['pharmacy.verify', 'pharmacy.dispense', 'inventory.view', 'inventory.manage'],
  accountant: ['patients.view', 'billing.view', 'billing.manage', 'payments.record', 'insurance.manage', 'reports.financial'],
  admin: [
    'users.manage', 'roles.manage', 'doctors.manage', 'departments.manage', 'staffing.manage', 'staff.view',
    'appointments.approve_cancellation', 'appointments.view', 'wards.view', 'wards.configure', 'lab.catalog',
    'billing.view', 'reports.financial', 'reports.operational', 'audit.view', 'nursing.roster.view', 'nursing.roster.manage',
  ],
  system_admin: ['system.backup', 'storage.reconcile', 'system.health', 'audit.view'],
};
