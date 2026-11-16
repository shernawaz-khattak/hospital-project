// Reference data: insurance providers, wards & beds, medicines with batches, lab tests.
import { addDays, todayStr } from '../../lib/dates.js';

export const LAB_TESTS = [
  ['CBC', 'Complete Blood Count', 'Hematology', 'Blood (EDTA)', 1200, 6, [
    ['Hemoglobin', 'g/dL', '13.0-17.0'], ['WBC', 'x10^9/L', '4.0-11.0'], ['RBC', 'x10^12/L', '4.5-5.9'], ['Platelets', 'x10^9/L', '150-400'], ['Hematocrit', '%', '40-50'],
  ]],
  ['LFT', 'Liver Function Test', 'Biochemistry', 'Blood (serum)', 2200, 12, [
    ['ALT', 'U/L', '7-56'], ['AST', 'U/L', '10-40'], ['ALP', 'U/L', '44-147'], ['Total bilirubin', 'mg/dL', '0.1-1.2'], ['Albumin', 'g/dL', '3.5-5.0'],
  ]],
  ['RFT', 'Renal Function Test', 'Biochemistry', 'Blood (serum)', 1800, 12, [
    ['Urea', 'mg/dL', '15-45'], ['Creatinine', 'mg/dL', '0.6-1.3'], ['Sodium', 'mmol/L', '135-145'], ['Potassium', 'mmol/L', '3.5-5.1'],
  ]],
  ['LIPID', 'Lipid Profile', 'Biochemistry', 'Blood (fasting serum)', 2500, 12, [
    ['Total cholesterol', 'mg/dL', '<200'], ['LDL', 'mg/dL', '<100'], ['HDL', 'mg/dL', '>40'], ['Triglycerides', 'mg/dL', '<150'],
  ]],
  ['HBA1C', 'HbA1c', 'Biochemistry', 'Blood (EDTA)', 1600, 24, [['HbA1c', '%', '<5.7']]],
  ['FBS', 'Fasting Blood Sugar', 'Biochemistry', 'Blood (fluoride)', 400, 2, [['Glucose (fasting)', 'mg/dL', '70-99']]],
  ['UA', 'Urinalysis', 'Clinical Pathology', 'Urine', 600, 4, [['pH', '', '4.5-8.0'], ['Protein', '', 'Negative'], ['Glucose', '', 'Negative'], ['Pus cells', '/HPF', '0-5']]],
  ['TFT', 'Thyroid Function Test', 'Endocrinology', 'Blood (serum)', 3000, 24, [['TSH', 'mIU/L', '0.4-4.0'], ['Free T4', 'ng/dL', '0.8-1.8'], ['Free T3', 'pg/mL', '2.3-4.2']]],
  ['TROP', 'Troponin I', 'Cardiac markers', 'Blood (serum)', 3500, 2, [['Troponin I', 'ng/mL', '<0.04']]],
  ['XRAY-CH', 'Chest X-Ray', 'Radiology', 'Imaging', 1500, 4, [['Findings', '', 'Report']]],
  ['ECG', 'Electrocardiogram', 'Cardiology', 'Recording', 1000, 1, [['Rhythm', '', 'Sinus'], ['Rate', 'bpm', '60-100']]],
  ['DENGUE', 'Dengue NS1 Antigen', 'Serology', 'Blood (serum)', 2000, 6, [['NS1 antigen', '', 'Negative']], false],
];

// [name, generic, form, strength, category, price, reorder, batches: [batchNo, qty, expiryOffsetDays]]
export const MEDICINES = [
  ['Panadol', 'Paracetamol', 'tablet', '500 mg', 'Analgesic', 3, 200, [['PAN-2401', 1500, 420], ['PAN-2405', 400, 25]]],
  ['Calpol Syrup', 'Paracetamol', 'syrup', '120 mg/5 mL', 'Analgesic', 180, 20, [['CAL-2311', 60, 300]]],
  ['Brufen', 'Ibuprofen', 'tablet', '400 mg', 'NSAID', 8, 150, [['BRU-2402', 900, 380]]],
  ['Augmentin', 'Amoxicillin + Clavulanic acid', 'tablet', '625 mg', 'Antibiotic', 45, 100, [['AUG-2403', 320, 200], ['AUG-2312', 40, -10]]],
  ['Amoxil', 'Amoxicillin', 'capsule', '500 mg', 'Antibiotic', 18, 100, [['AMX-2404', 600, 500]]],
  ['Ciproxin', 'Ciprofloxacin', 'tablet', '500 mg', 'Antibiotic', 30, 80, [['CIP-2402', 70, 260]]],
  ['Flagyl', 'Metronidazole', 'tablet', '400 mg', 'Antibiotic', 6, 100, [['FLG-2401', 450, 18]]],
  ['Glucophage', 'Metformin', 'tablet', '500 mg', 'Antidiabetic', 7, 200, [['GLU-2403', 1200, 610]]],
  ['Amaryl', 'Glimepiride', 'tablet', '2 mg', 'Antidiabetic', 22, 80, [['AMR-2402', 260, 330]]],
  ['Norvasc', 'Amlodipine', 'tablet', '5 mg', 'Antihypertensive', 25, 120, [['NOR-2401', 540, 450]]],
  ['Lipitor', 'Atorvastatin', 'tablet', '20 mg', 'Statin', 40, 100, [['LIP-2403', 90, 390]]],
  ['Disprin CV', 'Aspirin', 'tablet', '75 mg', 'Antiplatelet', 4, 150, [['DSP-2402', 800, 520]]],
  ['Losec', 'Omeprazole', 'capsule', '20 mg', 'Proton pump inhibitor', 20, 150, [['LOS-2401', 700, 280]]],
  ['Risek', 'Omeprazole', 'capsule', '40 mg', 'Proton pump inhibitor', 32, 80, [['RSK-2402', 0, 300]]],
  ['Ventolin Inhaler', 'Salbutamol', 'inhaler', '100 mcg', 'Bronchodilator', 650, 15, [['VEN-2402', 22, 400]]],
  ['Zyrtec', 'Cetirizine', 'tablet', '10 mg', 'Antihistamine', 12, 100, [['ZYR-2403', 380, 23]]],
  ['ORS Sachet', 'Oral rehydration salts', 'other', '20.5 g', 'Electrolyte', 25, 100, [['ORS-2404', 85, 540]]],
  ['Ceftriaxone Inj', 'Ceftriaxone', 'injection', '1 g', 'Antibiotic', 350, 40, [['CEF-2403', 120, 220]]],
  ['Insulin Mixtard', 'Human insulin 70/30', 'injection', '100 IU/mL', 'Antidiabetic', 1450, 10, [['INS-2402', 8, 160]]],
  ['Folic Acid', 'Folic acid', 'tablet', '5 mg', 'Supplement', 2, 200, [['FOL-2403', 1000, 700]]],
  ['Diclofenac Gel', 'Diclofenac', 'cream', '1%', 'NSAID', 280, 20, [['DCL-2402', 45, 365]]],
  ['Ondansetron', 'Ondansetron', 'tablet', '4 mg', 'Antiemetic', 28, 60, [['OND-2401', 150, -3]]],
];

const WARDS = [
  ['General Ward A (Male)', 'general', 'GEN', 'Ground', 'male', 3000, 12],
  ['General Ward B (Female)', 'general', 'GEN', 'Ground', 'female', 3000, 12],
  ['Private Rooms', 'private', 'GEN', '3rd', 'any', 12000, 6],
  ['Cardiac Care Unit', 'icu', 'CARD', '1st', 'any', 18000, 6],
  ['Pediatric Ward', 'pediatric', 'PED', '2nd', 'any', 3500, 8],
  ['Maternity Ward', 'maternity', 'GYN', '2nd', 'female', 5000, 8],
  ['Surgical Ward', 'surgical', 'ORTH', '1st', 'any', 6000, 8],
];

export async function seedCatalogs(knex, { deps, users }) {
  const providers = {};
  for (const [name, pct, cap, pattern] of [
    ['State Life Health', 80, 200000, '^SL-[0-9]{6}$'],
    ['Jubilee Health Insurance', 70, 150000, '^JH[0-9]{8}$'],
    ['Adamjee Medical Cover', 60, null, null],
    ['EFU Health', 75, 100000, null],
  ]) {
    const [row] = await knex('insurance_providers').insert({ name, default_coverage_percent: pct, max_coverage_amount: cap, policy_number_pattern: pattern, contact_phone: '111-000-000' }).returning('*');
    providers[name] = row;
  }

  const wards = {};
  for (const [name, type, dep, floor, gender, rate, beds] of WARDS) {
    const [w] = await knex('wards').insert({ name, ward_type: type, department_id: deps[dep], floor, gender_policy: gender, daily_rate: rate }).returning('*');
    const prefix = name.split(' ').map((s) => s[0]).join('').replace(/[^A-Z]/g, '').slice(0, 3);
    const rows = [];
    for (let i = 1; i <= beds; i++) rows.push({ ward_id: w.id, bed_number: `${prefix}-${String(i).padStart(2, '0')}`, status: i === beds && type === 'general' ? 'maintenance' : 'available' });
    await knex('beds').insert(rows);
    wards[name] = w;
  }

  const tests = {};
  for (const [code, name, category, sample, price, tat, params, available = true] of LAB_TESTS) {
    const [t] = await knex('lab_tests').insert({
      code, name, category, sample_type: sample, price, turnaround_hours: tat, is_available: available,
      parameters: JSON.stringify(params.map(([p, unit, range]) => ({ name: p, unit, referenceRange: range }))),
    }).returning('*');
    tests[code] = t;
  }

  const medicines = {};
  const today = todayStr();
  for (const [name, generic, form, strength, category, price, reorder, batches] of MEDICINES) {
    const [m] = await knex('medicines').insert({ name, generic_name: generic, form, strength, category, unit_price: price, reorder_level: reorder }).returning('*');
    let stock = 0;
    for (const [batchNo, qty, offset] of batches) {
      const [b] = await knex('medicine_batches').insert({ medicine_id: m.id, batch_number: batchNo, quantity: qty, expiry_date: addDays(today, offset), supplier: 'Demo Pharma Distributors', cost_price: price * 0.7, received_by: users.pharmacist.id, received_at: new Date(Date.now() - 60 * 86400000) }).returning('*');
      stock += qty;
      if (qty > 0) {
        await knex('inventory_transactions').insert({ medicine_id: m.id, batch_id: b.id, txn_type: 'receive', quantity_change: qty, stock_after: stock, reason: 'Opening stock (demo seed)', performed_by: users.pharmacist.id, created_at: new Date(Date.now() - 60 * 86400000) });
      }
    }
    medicines[name] = m;
  }
  return { providers, wards, tests, medicines };
}
