// Fictional demo patients. National IDs use the 13-digit CNIC format but are made up.
import bcrypt from 'bcryptjs';
import { blindIndex, encrypt } from '../../lib/crypto.js';
import { nextCode } from '../../lib/codes.js';
import { addDays, todayStr } from '../../lib/dates.js';
import { DEMO_PASSWORD } from './organization.js';

// [first, last, dob, gender, blood, phone, city, allergies, history, portal?, insurance?]
const PATIENTS = [
  ['Ali', 'Hassan', '1985-03-14', 'male', 'B+', '0300-1234501', 'Islamabad', 'Penicillin', 'Type 2 diabetes (2019). Hypertension.', true, 'State Life Health'],
  ['Mariam', 'Siddiqui', '1992-07-22', 'female', 'O+', '0301-2234502', 'Rawalpindi', null, 'Asthma since childhood.', true, null],
  ['Hamza', 'Sheikh', '1978-11-02', 'male', 'A+', '0302-3234503', 'Islamabad', null, 'Coronary artery disease, stent 2022.', false, 'Jubilee Health Insurance'],
  ['Sana', 'Javed', '1999-01-30', 'female', 'AB+', '0303-4234504', 'Islamabad', 'Sulfa drugs', null, false, null],
  ['Bilal', 'Ahmed', '2018-05-12', 'male', 'O-', '0304-5234505', 'Rawalpindi', null, 'Recurrent tonsillitis.', false, null],
  ['Rabia', 'Anwar', '1988-09-09', 'female', 'B-', '0305-6234506', 'Islamabad', null, 'G2P1, currently 32 weeks pregnant.', false, 'Adamjee Medical Cover'],
  ['Tariq', 'Mehmood', '1960-12-25', 'male', 'A-', '0306-7234507', 'Islamabad', 'Aspirin', 'COPD, ex-smoker.', false, null],
  ['Ayesha', 'Rehman', '1975-04-18', 'female', 'O+', '0307-8234508', 'Murree', null, 'Hypothyroidism.', false, 'EFU Health'],
  ['Usman', 'Ghani', '1995-06-06', 'male', 'B+', '0308-9234509', 'Islamabad', null, null, false, null],
  ['Zara', 'Haider', '2015-10-10', 'female', 'A+', '0309-0234510', 'Rawalpindi', 'Peanuts', null, false, null],
  ['Imran', 'Saeed', '1970-02-28', 'male', 'AB-', '0310-1234511', 'Islamabad', null, 'Osteoarthritis right knee.', false, null],
  ['Nida', 'Farooq', '1983-08-15', 'female', 'O-', '0311-2234512', 'Islamabad', null, 'Migraine.', false, null],
  ['Faisal', 'Qureshi', '1990-12-01', 'male', 'A+', '0312-3234513', 'Taxila', null, null, false, null],
  ['Hira', 'Nadeem', '2001-03-03', 'female', 'B+', '0313-4234514', 'Islamabad', null, null, false, null],
  ['Kashif', 'Iqbal', '1968-07-07', 'male', 'O+', '0314-5234515', 'Rawalpindi', 'Codeine', 'Chronic kidney disease stage 2.', false, 'State Life Health'],
  ['Samina', 'Yousaf', '1955-05-20', 'female', 'A+', '0315-6234516', 'Islamabad', null, 'Type 2 diabetes, hypertension.', false, null],
  ['Adeel', 'Khan', '1987-09-27', 'male', 'B-', '0316-7234517', 'Islamabad', null, null, false, null],
  ['Mahnoor', 'Butt', '2020-01-15', 'female', 'O+', '0317-8234518', 'Islamabad', null, null, false, null],
  ['Waqas', 'Raza', '1993-11-11', 'male', 'AB+', '0318-9234519', 'Wah Cantt', null, 'Fracture left radius 2024.', false, null],
  ['Fiza', 'Ali', '1997-02-14', 'female', 'A-', '0319-0234520', 'Islamabad', null, null, false, null],
];

export async function seedPatients(knex, { users }, { providers }) {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const patientRole = await knex('roles').where({ code: 'patient' }).first();
  const patients = [];
  let i = 0;
  for (const [first, last, dob, gender, blood, phone, city, allergies, history, portal, insurer] of PATIENTS) {
    i += 1;
    const code = await nextCode(knex, 'patient_code_seq');
    const nationalId = `61101-${String(4000000 + i * 1371).padStart(7, '0')}-${i % 10}`;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}@mail.example`;
    let userId = null;
    if (portal) {
      const [u] = await knex('users').insert({ username: code, email, full_name: `${first} ${last}`, phone, role_id: patientRole.id, password_hash: hash, password_changed_at: new Date(), created_by: users.reception.id }).returning('*');
      userId = u.id;
    }
    const [p] = await knex('patients').insert({
      patient_code: code, user_id: userId, first_name: first, last_name: last, date_of_birth: dob, gender, blood_group: blood, phone, email, city,
      national_id_enc: encrypt(nationalId), national_id_hash: blindIndex(nationalId),
      address_enc: encrypt(`House ${10 + i}, Street ${i}, ${city}`),
      allergies_enc: encrypt(allergies), medical_history_enc: encrypt(history),
      emergency_contact_name: `${['Khalid', 'Shazia', 'Asif', 'Rubina'][i % 4]} ${last}`, emergency_contact_phone: `0333-77700${String(i).padStart(2, '0')}`, emergency_contact_relation: ['Spouse', 'Parent', 'Sibling', 'Child'][i % 4],
      created_by: users.reception.id, created_at: new Date(Date.now() - (120 - i * 4) * 86400000),
    }).returning('*');
    if (insurer) {
      const prov = providers[insurer];
      const policy = insurer.startsWith('State') ? `SL-${String(100000 + i)}` : insurer.startsWith('Jubilee') ? `JH${String(20240000 + i)}` : `POL-${1000 + i}`;
      await knex('patient_insurance').insert({
        patient_id: p.id, provider_id: prov.id, policy_number_enc: encrypt(policy), policy_number_last4: policy.slice(-4), coverage_percent: prov.default_coverage_percent,
        valid_from: addDays(todayStr(), -200), valid_until: i === 8 ? addDays(todayStr(), -5) : addDays(todayStr(), 165), // patient 8: expired policy (UC-40 2-A)
      });
    }
    patients.push(p);
  }
  return { patients };
}
