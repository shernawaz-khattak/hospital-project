// Human-readable, unique identifiers generated from Postgres sequences
// (sequence values are never reused, even if a transaction rolls back).
const PREFIX = {
  patient_code_seq: 'P',
  appointment_code_seq: 'APT',
  admission_code_seq: 'ADM',
  visit_code_seq: 'VIS',
  prescription_code_seq: 'RX',
  lab_request_code_seq: 'LAB',
  bill_number_seq: 'BIL',
  payment_number_seq: 'PAY',
  receipt_number_seq: 'RCP',
};

export async function nextCode(trx, sequence) {
  const prefix = PREFIX[sequence];
  if (!prefix) throw new Error(`Unknown sequence ${sequence}`);
  const { rows } = await trx.raw('SELECT nextval(?) AS n', [sequence]);
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(rows[0].n).padStart(6, '0')}`;
}
