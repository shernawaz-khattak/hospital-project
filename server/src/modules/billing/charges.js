// Billable services for a patient (SRS UC-39: consultation, lab, medicine and room charges
// listed separately). Every service can be billed only once (unique index on bill_items).
import { db } from '../../db/knex.js';
import { addDays, daysInclusive, toDateStr, todayStr } from '../../lib/dates.js';
import { round2 } from '../../lib/money.js';

/** Room charges for one admission from `fromDate` to `toDate` inclusive, split by ward (transfers). */
export async function roomSegments(admission, fromDate, toDate, conn = db) {
  if (fromDate > toDate) return [];
  const transfers = await conn('bed_transfers').where({ admission_id: admission.id }).orderBy('transferred_at');
  // Ward occupied at the end of each calendar day.
  const timeline = [{ at: new Date(admission.admitted_at), wardId: transfers[0]?.from_ward_id ?? admission.ward_id }];
  for (const t of transfers) timeline.push({ at: new Date(t.transferred_at), wardId: t.to_ward_id });
  const wards = Object.fromEntries((await conn('wards').whereIn('id', [...new Set(timeline.map((t) => t.wardId))])).map((w) => [w.id, w]));

  const segments = [];
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    const endOfDay = new Date(`${d}T23:59:59`);
    const cutoff = admission.discharged_at && toDateStr(new Date(admission.discharged_at)) === d ? new Date(admission.discharged_at) : endOfDay;
    const wardId = [...timeline].reverse().find((t) => t.at <= cutoff)?.wardId ?? timeline[0].wardId;
    const last = segments.at(-1);
    if (last && last.wardId === wardId) {
      last.periodEnd = d;
      last.days += 1;
    } else {
      segments.push({ wardId, wardName: wards[wardId].name, rate: wards[wardId].daily_rate, periodStart: d, periodEnd: d, days: 1 });
    }
  }
  return segments;
}

/**
 * Returns { items, warnings } — unbilled services for the patient.
 * items: [{ category, description, quantity, unitPrice, amount, sourceType, sourceId, serviceDate, periodStart?, periodEnd? }]
 */
export async function getUnbilledServices(patientId, conn = db) {
  const items = [];
  const warnings = [];

  // Consultations: completed appointments
  const appts = await conn('appointments as a')
    .join('doctors as d', 'd.id', 'a.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id')
    .leftJoin('bill_items as bi', function j() { this.on('bi.source_id', 'a.id').andOnVal('bi.source_type', '=', 'appointment'); })
    .where({ 'a.patient_id': patientId, 'a.status': 'completed' }).whereNull('bi.id')
    .select('a.id', 'a.appointment_date', 'a.appointment_code', 'd.consultation_fee', 'u.full_name as doctor_name', 'd.specialization');
  for (const a of appts) {
    items.push({ category: 'consultation', description: `Consultation — ${a.doctor_name} (${a.specialization}), ${a.appointment_code}`, quantity: 1, unitPrice: a.consultation_fee, amount: a.consultation_fee, sourceType: 'appointment', sourceId: a.id, serviceDate: a.appointment_date });
  }
  // Walk-in / emergency consultations (visits without an appointment)
  const visits = await conn('visits as v')
    .join('doctors as d', 'd.id', 'v.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id')
    .leftJoin('bill_items as bi', function j() { this.on('bi.source_id', 'v.id').andOnVal('bi.source_type', '=', 'visit'); })
    .where('v.patient_id', patientId).whereNull('v.appointment_id').whereIn('v.visit_type', ['opd', 'emergency']).whereNull('bi.id')
    .select('v.id', 'v.started_at', 'v.visit_code', 'v.visit_type', 'd.consultation_fee', 'u.full_name as doctor_name');
  for (const v of visits) {
    items.push({ category: 'consultation', description: `${v.visit_type === 'emergency' ? 'Emergency' : 'Walk-in'} consultation — ${v.doctor_name}, ${v.visit_code}`, quantity: 1, unitPrice: v.consultation_fee, amount: v.consultation_fee, sourceType: 'visit', sourceId: v.id, serviceDate: toDateStr(new Date(v.started_at)) });
  }

  // Laboratory: completed or reported tests
  const labs = await conn('lab_requests as l').join('lab_tests as t', 't.id', 'l.lab_test_id')
    .leftJoin('bill_items as bi', function j() { this.on('bi.source_id', 'l.id').andOnVal('bi.source_type', '=', 'lab_request'); })
    .where('l.patient_id', patientId).whereIn('l.status', ['completed', 'reported']).whereNull('bi.id')
    .select('l.id', 'l.request_code', 'l.completed_at', 't.name', 't.price');
  for (const l of labs) {
    items.push({ category: 'lab', description: `${l.name} (${l.request_code})`, quantity: 1, unitPrice: l.price, amount: l.price, sourceType: 'lab_request', sourceId: l.id, serviceDate: toDateStr(new Date(l.completed_at)) });
  }
  const pendingLabs = await conn('lab_requests').where({ patient_id: patientId }).whereIn('status', ['requested', 'in_progress', 'delayed']).count({ n: '*' }).first();
  if (pendingLabs.n > 0) warnings.push(`${pendingLabs.n} lab test(s) are still pending and are not included yet.`);

  // Medicines: dispensed items
  const meds = await conn('dispensing_items as di').join('dispensings as ds', 'ds.id', 'di.dispensing_id').join('prescriptions as rx', 'rx.id', 'ds.prescription_id').join('medicines as m', 'm.id', 'di.medicine_id')
    .leftJoin('bill_items as bi', function j() { this.on('bi.source_id', 'di.id').andOnVal('bi.source_type', '=', 'dispensing_item'); })
    .where('rx.patient_id', patientId).whereNull('bi.id')
    .select('di.id', 'di.quantity', 'di.unit_price', 'm.name', 'm.strength', 'rx.prescription_code', 'ds.dispensed_at');
  for (const m of meds) {
    items.push({ category: 'medicine', description: `${m.name} ${m.strength} (${m.prescription_code})`, quantity: m.quantity, unitPrice: m.unit_price, amount: round2(m.quantity * m.unit_price), sourceType: 'dispensing_item', sourceId: m.id, serviceDate: toDateStr(new Date(m.dispensed_at)) });
  }
  const pendingRx = await conn('prescriptions').where({ patient_id: patientId }).whereIn('status', ['pending', 'verified', 'flagged']).count({ n: '*' }).first();
  if (pendingRx.n > 0) warnings.push(`${pendingRx.n} prescription(s) have not been dispensed yet.`);

  // Room charges
  const admissions = await conn('admissions').where({ patient_id: patientId });
  for (const ad of admissions) {
    const start = ad.room_billed_until ? addDays(ad.room_billed_until, 1) : toDateStr(new Date(ad.admitted_at));
    const end = ad.status === 'active' ? todayStr() : toDateStr(new Date(ad.discharged_at));
    for (const seg of await roomSegments(ad, start, end, conn)) {
      items.push({ category: 'room', description: `Room charges — ${seg.wardName} (${seg.periodStart} to ${seg.periodEnd})`, quantity: seg.days, unitPrice: seg.rate, amount: round2(seg.days * seg.rate), sourceType: 'admission', sourceId: ad.id, serviceDate: seg.periodEnd, periodStart: seg.periodStart, periodEnd: seg.periodEnd, admissionId: ad.id });
    }
    if (ad.status === 'active') warnings.push(`Patient is currently admitted; room charges are calculated up to today (${todayStr()}).`);
  }

  const stale = await conn('appointments').where({ patient_id: patientId, status: 'scheduled' }).where('appointment_date', '<', todayStr()).count({ n: '*' }).first();
  if (stale.n > 0) warnings.push(`${stale.n} past appointment(s) have not been marked completed or no-show.`);

  return { items, warnings };
}

export const daysBetween = daysInclusive;

export async function outstandingBalance(patientId, conn = db) {
  const r = await conn('bills').where({ patient_id: patientId }).where('balance', '>', 0).sum({ total: 'balance' }).count({ n: '*' }).first();
  return { amount: Number(r.total ?? 0), bills: Number(r.n ?? 0) };
}
