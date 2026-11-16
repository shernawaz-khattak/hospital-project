// Demo organisation: departments, staff accounts for every role, doctors and schedules.
// All names are fictional. Demo password for every seeded account: see DEMO_PASSWORD.
import bcrypt from 'bcryptjs';
import { addDays, todayStr } from '../../lib/dates.js';

export const DEMO_PASSWORD = 'Demo@1234';

export const DEPARTMENTS = [
  ['General Medicine', 'GEN', 'Block A, Ground floor'],
  ['Cardiology', 'CARD', 'Block B, 1st floor'],
  ['Pediatrics', 'PED', 'Block A, 2nd floor'],
  ['Orthopedics', 'ORTH', 'Block C, 1st floor'],
  ['Gynecology & Obstetrics', 'GYN', 'Block B, 2nd floor'],
  ['Emergency', 'ER', 'Main entrance'],
  ['Pathology Laboratory', 'LAB', 'Block A, Basement'],
  ['Pharmacy', 'PHAR', 'Block A, Ground floor'],
  ['Front Desk', 'FD', 'Main lobby'],
  ['Accounts', 'ACC', 'Admin block'],
  ['Administration', 'ADM', 'Admin block'],
  ['Information Technology', 'IT', 'Admin block'],
];

// [username, full name, role, department code, designation, email]
export const STAFF = [
  ['admin', 'Hina Qureshi', 'admin', 'ADM', 'Hospital Administrator', 'admin@hms.example'],
  ['sysadmin', 'Kamran Ali', 'system_admin', 'IT', 'System Administrator', 'sysadmin@hms.example'],
  ['reception', 'Nadia Iqbal', 'receptionist', 'FD', 'Senior Receptionist', 'reception@hms.example'],
  ['reception2', 'Omar Farooq', 'receptionist', 'FD', 'Receptionist', 'reception2@hms.example'],
  ['nurse', 'Areeba Hassan', 'nurse', 'GYN', 'Senior Nurse', 'nurse@hms.example'],
  ['nurse2', 'Usman Iqbal', 'nurse', 'ER', 'Staff Nurse', 'nurse2@hms.example'],
  ['labtech', 'Imran Shah', 'lab_technician', 'LAB', 'Laboratory Technologist', 'labtech@hms.example'],
  ['pharmacist', 'Zainab Akhtar', 'pharmacist', 'PHAR', 'Chief Pharmacist', 'pharmacist@hms.example'],
  ['accountant', 'Faisal Mehmood', 'accountant', 'ACC', 'Accounts Officer', 'accountant@hms.example'],
];

// [username, full name, doctor code, specialization, dept code, fee, slot, license, qualification]
export const DOCTORS = [
  ['dr.ahmed', 'Dr. Ahmed Raza', 'DOC-001', 'General Physician', 'GEN', 1500, 15, 'PMC-10234-P', 'MBBS, FCPS (Medicine)'],
  ['dr.sara', 'Dr. Sara Khan', 'DOC-002', 'Cardiologist', 'CARD', 3000, 20, 'PMC-11873-P', 'MBBS, FCPS (Cardiology)'],
  ['dr.bilal', 'Dr. Bilal Hussain', 'DOC-003', 'Pediatrician', 'PED', 2000, 15, 'PMC-12991-P', 'MBBS, DCH, FCPS (Peds)'],
  ['dr.ayesha', 'Dr. Ayesha Malik', 'DOC-004', 'Gynecologist', 'GYN', 2500, 20, 'PMC-13450-P', 'MBBS, FCPS (Obs & Gyn)'],
  ['dr.usman', 'Dr. Usman Tariq', 'DOC-005', 'Orthopedic Surgeon', 'ORTH', 2500, 20, 'PMC-14102-P', 'MBBS, FCPS (Ortho)'],
  ['dr.fatima', 'Dr. Fatima Noor', 'DOC-006', 'Emergency Physician', 'ER', 1800, 15, 'PMC-15377-P', 'MBBS, MCPS (Emergency)'],
];

// Weekly blocks: Mon–Sat mornings for everyone, some afternoons.
const SCHEDULE = {
  'dr.ahmed': [[1, '09:00', '13:00'], [2, '09:00', '13:00'], [3, '09:00', '13:00'], [4, '09:00', '13:00'], [5, '09:00', '12:00'], [6, '10:00', '13:00'], [1, '14:00', '17:00'], [3, '14:00', '17:00']],
  'dr.sara': [[1, '10:00', '14:00'], [3, '10:00', '14:00'], [5, '10:00', '13:00'], [2, '15:00', '18:00'], [4, '15:00', '18:00']],
  'dr.bilal': [[1, '09:00', '12:00'], [2, '09:00', '12:00'], [3, '09:00', '12:00'], [4, '09:00', '12:00'], [6, '09:00', '12:00']],
  'dr.ayesha': [[2, '10:00', '14:00'], [4, '10:00', '14:00'], [6, '10:00', '13:00'], [3, '15:00', '18:00']],
  'dr.usman': [[1, '11:00', '15:00'], [3, '11:00', '15:00'], [5, '11:00', '15:00']],
  'dr.fatima': [[0, '09:00', '17:00'], [1, '09:00', '17:00'], [2, '09:00', '17:00'], [3, '09:00', '17:00'], [4, '09:00', '17:00'], [5, '09:00', '17:00'], [6, '09:00', '17:00']],
};

export async function seedOrganization(knex) {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const roles = Object.fromEntries((await knex('roles')).map((r) => [r.code, r.id]));
  const deps = {};
  for (const [name, code, location] of DEPARTMENTS) {
    const [row] = await knex('departments').insert({ name, code, location, description: `${name} department` }).returning('*');
    deps[code] = row.id;
  }

  let emp = 1;
  const users = {};
  const joined = addDays(todayStr(), -400);
  for (const [username, fullName, role, dep, designation, email] of STAFF) {
    const [u] = await knex('users').insert({ username, full_name: fullName, email, phone: `0300-55500${String(emp).padStart(2, '0')}`, role_id: roles[role], password_hash: hash, password_changed_at: new Date() }).returning('*');
    await knex('staff').insert({ user_id: u.id, employee_code: `EMP-${String(emp++).padStart(4, '0')}`, department_id: deps[dep], designation, date_joined: joined });
    users[username] = u;
  }

  const doctors = {};
  for (const [username, fullName, code, spec, dep, fee, slot, license, qual] of DOCTORS) {
    const [u] = await knex('users').insert({ username, full_name: fullName, email: `${username.replace('.', '')}@hms.example`, phone: `0321-44400${String(emp).padStart(2, '0')}`, role_id: roles.doctor, password_hash: hash, password_changed_at: new Date() }).returning('*');
    const [s] = await knex('staff').insert({ user_id: u.id, employee_code: `EMP-${String(emp++).padStart(4, '0')}`, department_id: deps[dep], designation: `Consultant ${spec}`, date_joined: joined }).returning('*');
    const [d] = await knex('doctors').insert({ staff_id: s.id, doctor_code: code, specialization: spec, qualification: qual, license_number: license, department_id: deps[dep], consultation_fee: fee, slot_minutes: slot }).returning('*');
    await knex('doctor_schedules').insert(SCHEDULE[username].map(([weekday, start, end]) => ({ doctor_id: d.id, weekday, start_time: start, end_time: end })));
    users[username] = u;
    doctors[username] = d;
  }

  // Staffing levels (UC-10)
  const levels = [
    ['GEN', 'doctor', 3], ['CARD', 'doctor', 2], ['PED', 'doctor', 2], ['ORTH', 'doctor', 2], ['GYN', 'doctor', 2], ['ER', 'doctor', 4],
    ['FD', 'receptionist', 3], ['LAB', 'lab_technician', 3], ['PHAR', 'pharmacist', 2], ['ACC', 'accountant', 2], ['IT', 'system_admin', 1], ['ADM', 'admin', 1],
    ['GYN', 'nurse', 4], ['ER', 'nurse', 6],
  ];
  for (const [dep, role, n] of levels) {
    await knex('staffing_levels').insert({ department_id: deps[dep], role_id: roles[role], required_count: n, updated_by: users.admin.id, reviewed_at: new Date(Date.now() - (role === 'doctor' && dep === 'ORTH' ? 45 : 5) * 86400000) });
  }
  return { deps, users, doctors, roles };
}
