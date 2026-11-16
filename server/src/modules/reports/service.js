// Dashboards and reports (SRS FR-30, UC-43 Generate Financial Reports, UC-44 Financial Summaries,
// plus the operational statistics each role needs). All figures are computed live from the database.
import { db } from '../../db/knex.js';
import { addDays, todayStr } from '../../lib/dates.js';
import { env } from '../../config/env.js';
import { VERIFY_SLA_MINUTES, EXPIRY_WARNING_DAYS } from '../pharmacy/service.js';
import { connectedClientCount } from '../../services/realtime.js';

const n = (r, k = 'n') => Number(r?.[k] ?? 0);
const dayStart = (d) => `${d}T00:00:00`;

// ----------------------------------------------------------------- shared metrics
async function bedCounts() {
  const rows = await db('beds as b').join('wards as w', 'w.id', 'b.ward_id').where('w.is_active', true).groupBy('b.status').select('b.status', db.raw('count(*)::int as n'));
  const get = (s) => rows.find((r) => r.status === s)?.n ?? 0;
  return { available: get('available'), occupied: get('occupied'), maintenance: get('maintenance'), total: rows.reduce((s, r) => s + r.n, 0) };
}
async function lowStockCount() {
  const { rows } = await db.raw(`SELECT count(*)::int AS n FROM medicines m WHERE m.is_active AND COALESCE((SELECT sum(quantity) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.status = 'active' AND b.expiry_date >= ?), 0) <= m.reorder_level`, [todayStr()]);
  return rows[0].n;
}
const revenueOn = async (from, toExclusive) => n(await db('payments').where('received_at', '>=', dayStart(from)).where('received_at', '<', dayStart(toExclusive)).sum({ n: 'amount' }).first());

async function series(table, column, days, agg = 'count', valueCol = null) {
  const from = addDays(todayStr(), -(days - 1));
  const expr = agg === 'count' ? 'count(*)' : `sum(${valueCol})`;
  const isDate = column === 'appointment_date';
  const { rows } = await db.raw(`SELECT ${isDate ? column : `(${column} AT TIME ZONE ?)::date`} AS d, ${expr}::float AS v FROM ${table} WHERE ${isDate ? column : `(${column} AT TIME ZONE ?)::date`} >= ? GROUP BY 1`, isDate ? [from] : [env.HOSPITAL_TZ, env.HOSPITAL_TZ, from]);
  const map = Object.fromEntries(rows.map((r) => [typeof r.d === 'string' ? r.d : r.d.toISOString().slice(0, 10), r.v]));
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(from, i);
    return { date: d, value: Number(map[d] ?? 0) };
  });
}

// ----------------------------------------------------------------- dashboards per role
export async function dashboard(req) {
  const role = req.user.role;
  const today = todayStr();
  const tomorrow = addDays(today, 1);
  switch (role) {
    case 'admin': {
      const [patients, appts, doctors, staff, deps, beds, labs, low, revenue, cancelReqs, staffing] = await Promise.all([
        db('patients').count({ n: '*' }).first(),
        db('appointments').where({ appointment_date: today }).whereNot('status', 'rescheduled').count({ n: '*' }).first(),
        db('doctors as d').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id').where('d.is_active', true).where('u.status', 'active').count({ n: '*' }).first(),
        db('staff as s').join('users as u', 'u.id', 's.user_id').where('u.status', 'active').count({ n: '*' }).first(),
        db('departments').where({ is_active: true }).count({ n: '*' }).first(),
        bedCounts(),
        db('lab_requests').whereIn('status', ['requested', 'in_progress', 'delayed', 'completed']).count({ n: '*' }).first(),
        lowStockCount(),
        revenueOn(today, tomorrow),
        db('appointment_cancellation_requests').where({ status: 'pending' }).count({ n: '*' }).first(),
        db.raw(`SELECT count(*)::int AS n FROM staffing_levels sl WHERE sl.required_count > (SELECT count(*) FROM staff s JOIN users u ON u.id = s.user_id WHERE s.department_id = sl.department_id AND u.role_id = sl.role_id AND u.status = 'active')`),
      ]);
      return {
        role,
        stats: {
          totalPatients: n(patients), todaysAppointments: n(appts), doctors: n(doctors), staff: n(staff), departments: n(deps), availableBeds: beds.available, occupiedBeds: beds.occupied,
          pendingLabTests: n(labs), lowStockMedicines: low, todaysRevenue: revenue, pendingCancellationApprovals: n(cancelReqs), staffingShortfalls: staffing.rows[0].n,
        },
        charts: { appointments: await series('appointments', 'appointment_date', 14), revenue: await series('payments', 'received_at', 14, 'sum', 'amount') },
      };
    }
    case 'receptionist': {
      const [appts, newPatients, admissions, beds, waiting, requests, readyDischarge, list] = await Promise.all([
        db('appointments').where({ appointment_date: today }).whereIn('status', ['scheduled', 'completed', 'cancellation_requested', 'no_show']).count({ n: '*' }).first(),
        db('patients').where('created_at', '>=', dayStart(today)).count({ n: '*' }).first(),
        db('admissions').where({ status: 'active' }).count({ n: '*' }).first(),
        bedCounts(),
        db('waitlist_entries').whereIn('status', ['waiting', 'notified']).count({ n: '*' }).first(),
        db('admission_requests').where({ status: 'pending' }).count({ n: '*' }).first(),
        db('admissions').where({ status: 'active' }).whereNotNull('discharge_approved_at').count({ n: '*' }).first(),
        db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').join('doctors as d', 'd.id', 'a.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id')
          .where('a.appointment_date', today).whereIn('a.status', ['scheduled', 'cancellation_requested']).orderBy('a.start_time').limit(12)
          .select('a.id', 'a.start_time', 'a.token_number', 'a.status', 'p.patient_code', 'p.first_name', 'p.last_name', 'u.full_name as doctor_name'),
      ]);
      return {
        role,
        stats: { todaysAppointments: n(appts), newPatientsToday: n(newPatients), activeAdmissions: n(admissions), availableBeds: beds.available, occupiedBeds: beds.occupied, waitingList: n(waiting), pendingAdmissionRequests: n(requests), readyForDischarge: n(readyDischarge) },
        upcoming: list.map((a) => ({ id: a.id, time: a.start_time.slice(0, 5), token: a.token_number, status: a.status, patient: `${a.first_name} ${a.last_name}`, patientCode: a.patient_code, doctor: a.doctor_name })),
      };
    }
    case 'doctor': {
      const d = req.user.doctorId;
      const [todayList, pendingLabs, recentRx, flagged, admitted, recentPatients] = await Promise.all([
        db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').leftJoin('visits as v', 'v.appointment_id', 'a.id')
          .where({ 'a.doctor_id': d, 'a.appointment_date': today }).whereIn('a.status', ['scheduled', 'completed', 'cancellation_requested', 'no_show']).orderBy('a.start_time')
          .select('a.id', 'a.start_time', 'a.token_number', 'a.status', 'a.reason', 'p.id as patient_id', 'p.patient_code', 'p.first_name', 'p.last_name', 'v.id as visit_id', 'v.status as visit_status'),
        db('lab_requests').where({ doctor_id: d }).whereIn('status', ['requested', 'in_progress', 'delayed', 'completed']).count({ n: '*' }).first(),
        db('prescriptions as rx').join('patients as p', 'p.id', 'rx.patient_id').where('rx.doctor_id', d).orderBy('rx.created_at', 'desc').limit(5).select('rx.id', 'rx.prescription_code', 'rx.status', 'rx.created_at', 'p.first_name', 'p.last_name'),
        db('prescriptions').where({ doctor_id: d, status: 'flagged' }).count({ n: '*' }).first(),
        db('admissions as a').join('patients as p', 'p.id', 'a.patient_id').join('wards as w', 'w.id', 'a.ward_id').join('beds as b', 'b.id', 'a.bed_id').where({ 'a.attending_doctor_id': d, 'a.status': 'active' })
          .select('a.id', 'a.admitted_at', 'a.discharge_approved_at', 'p.id as patient_id', 'p.patient_code', 'p.first_name', 'p.last_name', 'w.name as ward_name', 'b.bed_number'),
        db('visits as v').join('patients as p', 'p.id', 'v.patient_id').where('v.doctor_id', d).orderBy('v.started_at', 'desc').limit(6).select('v.id', 'v.started_at', 'v.visit_type', 'p.id as patient_id', 'p.patient_code', 'p.first_name', 'p.last_name'),
      ]);
      const recentLabResults = await db('lab_requests as l').join('lab_tests as t', 't.id', 'l.lab_test_id').join('patients as p', 'p.id', 'l.patient_id').join('lab_reports as r', 'r.lab_request_id', 'l.id')
        .where('l.doctor_id', d).orderBy('r.uploaded_at', 'desc').limit(5).select('l.id', 'l.request_code', 't.name', 'r.uploaded_at', 'p.id as patient_id', 'p.first_name', 'p.last_name');
      return {
        role,
        stats: {
          todaysAppointments: todayList.length, pendingPatients: todayList.filter((a) => a.status === 'scheduled').length, completedToday: todayList.filter((a) => a.status === 'completed').length,
          pendingLabReports: n(pendingLabs), flaggedPrescriptions: n(flagged), admittedPatients: admitted.length,
        },
        todaysAppointments: todayList.map((a) => ({ id: a.id, time: a.start_time.slice(0, 5), token: a.token_number, status: a.status, reason: a.reason, visitId: a.visit_id, visitStatus: a.visit_status, patient: { id: a.patient_id, patientCode: a.patient_code, fullName: `${a.first_name} ${a.last_name}` } })),
        admitted: admitted.map((a) => ({ id: a.id, admittedAt: a.admitted_at, dischargeApproved: Boolean(a.discharge_approved_at), ward: a.ward_name, bed: a.bed_number, patient: { id: a.patient_id, patientCode: a.patient_code, fullName: `${a.first_name} ${a.last_name}` } })),
        recentPrescriptions: recentRx.map((r) => ({ id: r.id, code: r.prescription_code, status: r.status, createdAt: r.created_at, patient: `${r.first_name} ${r.last_name}` })),
        recentPatients: recentPatients.map((v) => ({ visitId: v.id, at: v.started_at, type: v.visit_type, patient: { id: v.patient_id, patientCode: v.patient_code, fullName: `${v.first_name} ${v.last_name}` } })),
        recentLabResults: recentLabResults.map((l) => ({ id: l.id, code: l.request_code, test: l.name, uploadedAt: l.uploaded_at, patient: { id: l.patient_id, fullName: `${l.first_name} ${l.last_name}` } })),
      };
    }
    case 'lab_technician': {
      const rows = await db('lab_requests').groupBy('status').select('status', db.raw('count(*)::int as n'));
      const get = (s) => rows.find((r) => r.status === s)?.n ?? 0;
      const [urgent, reportedToday, avg] = await Promise.all([
        db('lab_requests').whereIn('status', ['requested', 'in_progress', 'delayed']).whereIn('urgency', ['urgent', 'stat']).count({ n: '*' }).first(),
        db('lab_reports').where('uploaded_at', '>=', dayStart(today)).count({ n: '*' }).first(),
        db('lab_requests').whereNotNull('processing_minutes').where('completed_at', '>=', dayStart(addDays(today, -30))).avg({ n: 'processing_minutes' }).first(),
      ]);
      return { role, stats: { pending: get('requested'), inProgress: get('in_progress'), delayed: get('delayed'), awaitingUpload: get('completed'), urgentPending: n(urgent), reportedToday: n(reportedToday), avgProcessingMinutes: Math.round(n(avg)) }, charts: { reports: await series('lab_reports', 'uploaded_at', 14) } };
    }
    case 'pharmacist': {
      const soon = addDays(today, EXPIRY_WARNING_DAYS);
      const [pending, overdue, verified, meds, low, expiring, expired, alerts] = await Promise.all([
        db('prescriptions').where({ status: 'pending' }).count({ n: '*' }).first(),
        db('prescriptions').where({ status: 'pending' }).where('sent_to_pharmacy_at', '<', new Date(Date.now() - VERIFY_SLA_MINUTES * 60000)).count({ n: '*' }).first(),
        db('prescriptions').whereIn('status', ['verified', 'partially_dispensed']).count({ n: '*' }).first(),
        db('medicines').where({ is_active: true }).count({ n: '*' }).first(),
        lowStockCount(),
        db('medicine_batches').where({ status: 'active' }).where('quantity', '>', 0).where('expiry_date', '>=', today).where('expiry_date', '<=', soon).count({ n: '*' }).first(),
        db('medicine_batches').where({ status: 'active' }).where('quantity', '>', 0).where('expiry_date', '<', today).count({ n: '*' }).first(),
        db('stock_alerts').where({ status: 'open' }).count({ n: '*' }).first(),
      ]);
      return { role, stats: { pendingPrescriptions: n(pending), overdueVerifications: n(overdue), awaitingDispensing: n(verified), totalMedicines: n(meds), lowStock: low, expiringBatches: n(expiring), expiredBatches: n(expired), openAlerts: n(alerts) } };
    }
    case 'accountant': {
      const [revenue, pending, paid, outstanding, billedToday] = await Promise.all([
        revenueOn(today, tomorrow),
        db('bills').whereIn('status', ['unpaid', 'partially_paid']).count({ n: '*' }).first(),
        db('bills').where({ status: 'paid' }).count({ n: '*' }).first(),
        db('bills').where('balance', '>', 0).sum({ n: 'balance' }).first(),
        db('bills').where('generated_at', '>=', dayStart(today)).sum({ n: 'subtotal' }).first(),
      ]);
      const awaiting = await db('admissions').where({ status: 'active' }).whereNotNull('discharge_approved_at').count({ n: '*' }).first();
      return { role, stats: { todaysRevenue: revenue, pendingPayments: n(pending), paidBills: n(paid), outstandingAmount: n(outstanding), billedToday: n(billedToday), awaitingFinalBill: n(awaiting) }, charts: { revenue: await series('payments', 'received_at', 14, 'sum', 'amount') }, currency: env.CURRENCY };
    }
    case 'system_admin': {
      const [lastBackup, lastHealth, sessions, failedDeliveries, dbSize] = await Promise.all([
        db('backups').orderBy('started_at', 'desc').first(),
        db('health_checks').orderBy('checked_at', 'desc').first(),
        db('sessions').whereNull('revoked_at').where('last_activity_at', '>', new Date(Date.now() - env.SESSION_IDLE_MINUTES * 60000)).count({ n: '*' }).first(),
        db('notification_deliveries').where({ status: 'failed' }).where('created_at', '>', new Date(Date.now() - 86400000)).count({ n: '*' }).first(),
        db.raw('SELECT pg_database_size(current_database())::bigint AS n'),
      ]);
      return {
        role,
        stats: { activeSessions: n(sessions), liveConnections: connectedClientCount(), failedNotifications24h: n(failedDeliveries), databaseSizeBytes: Number(dbSize.rows[0].n) },
        lastBackup: lastBackup ? { status: lastBackup.status, at: lastBackup.completed_at ?? lastBackup.started_at, type: lastBackup.backup_type, sizeBytes: lastBackup.size_bytes } : null,
        lastHealth: lastHealth ? { status: lastHealth.overall_status, at: lastHealth.checked_at } : null,
      };
    }
    default:
      return { role, stats: {} };
  }
}

// ----------------------------------------------------------------- operational reports
export async function operationalReport({ from, to }) {
  const toEx = addDays(to, 1);
  const [patientsByStatus, newPatients, apptByStatus, workload, wards, labByTest, labAvg, topMeds, lowStock, beds] = await Promise.all([
    db('patients').groupBy('status').select('status', db.raw('count(*)::int as n')),
    db('patients').where('created_at', '>=', dayStart(from)).where('created_at', '<', dayStart(toEx)).count({ n: '*' }).first(),
    db('appointments').whereBetween('appointment_date', [from, to]).groupBy('status').select('status', db.raw('count(*)::int as n')),
    db('doctors as d').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id').where('d.is_active', true).select(
      'd.id', 'u.full_name', 'd.specialization',
      db.raw("(SELECT count(*) FROM appointments a WHERE a.doctor_id = d.id AND a.appointment_date BETWEEN ? AND ? AND a.status NOT IN ('cancelled','rescheduled'))::int AS appointments", [from, to]),
      db.raw("(SELECT count(*) FROM appointments a WHERE a.doctor_id = d.id AND a.appointment_date BETWEEN ? AND ? AND a.status = 'completed')::int AS completed", [from, to]),
      db.raw('(SELECT count(*) FROM visits v WHERE v.doctor_id = d.id AND v.started_at >= ? AND v.started_at < ?)::int AS visits', [dayStart(from), dayStart(toEx)]),
      db.raw('(SELECT count(*) FROM prescriptions p WHERE p.doctor_id = d.id AND p.created_at >= ? AND p.created_at < ?)::int AS prescriptions', [dayStart(from), dayStart(toEx)]),
      db.raw("(SELECT count(*) FROM admissions ad WHERE ad.attending_doctor_id = d.id AND ad.status = 'active')::int AS inpatients"),
    ).orderBy('u.full_name'),
    db('wards as w').where('w.is_active', true).select('w.id', 'w.name', db.raw('(SELECT count(*) FROM beds b WHERE b.ward_id = w.id)::int AS total'), db.raw("(SELECT count(*) FROM beds b WHERE b.ward_id = w.id AND b.status = 'occupied')::int AS occupied"), db.raw("(SELECT count(*) FROM beds b WHERE b.ward_id = w.id AND b.status = 'available')::int AS available")).orderBy('w.name'),
    db('lab_requests as l').join('lab_tests as t', 't.id', 'l.lab_test_id').where('l.created_at', '>=', dayStart(from)).where('l.created_at', '<', dayStart(toEx)).groupBy('t.name').select('t.name', db.raw('count(*)::int as n'), db.raw("count(*) FILTER (WHERE l.status = 'reported')::int as reported")).orderBy('n', 'desc'),
    db('lab_requests').whereNotNull('processing_minutes').where('completed_at', '>=', dayStart(from)).where('completed_at', '<', dayStart(toEx)).avg({ n: 'processing_minutes' }).first(),
    db('dispensing_items as di').join('dispensings as ds', 'ds.id', 'di.dispensing_id').join('medicines as m', 'm.id', 'di.medicine_id').where('ds.dispensed_at', '>=', dayStart(from)).where('ds.dispensed_at', '<', dayStart(toEx))
      .groupBy('m.name', 'm.strength').select('m.name', 'm.strength', db.raw('sum(di.quantity)::int as qty')).orderBy('qty', 'desc').limit(10),
    lowStockCount(),
    bedCounts(),
  ]);
  return {
    period: { from, to },
    patients: { byStatus: patientsByStatus, newInPeriod: n(newPatients) },
    appointments: { byStatus: apptByStatus, total: apptByStatus.reduce((s, r) => s + r.n, 0) },
    doctorWorkload: workload.map((w) => ({ doctorId: w.id, doctor: w.full_name, specialization: w.specialization, appointments: w.appointments, completed: w.completed, visits: w.visits, prescriptions: w.prescriptions, inpatients: w.inpatients })),
    wardOccupancy: wards.map((w) => ({ ...w, occupancyPercent: w.total ? Math.round((w.occupied / w.total) * 100) : 0 })),
    beds,
    laboratory: { byTest: labByTest, avgProcessingMinutes: Math.round(n(labAvg)) },
    pharmacy: { topDispensed: topMeds, lowStockMedicines: lowStock },
  };
}

// ----------------------------------------------------------------- financial
export async function financialSummary() {
  const today = todayStr();
  const monthStart = `${today.slice(0, 8)}01`;
  const [billed, collected, outstanding, todayRev, monthRev, byCategory, byMethod, counts] = await Promise.all([
    db('bills').sum({ subtotal: 'subtotal', insurance: 'insurance_amount', payable: 'total_payable' }).first(),
    db('payments').sum({ n: 'amount' }).first(),
    db('bills').where('balance', '>', 0).sum({ n: 'balance' }).count({ c: '*' }).first(),
    revenueOn(today, addDays(today, 1)),
    db('payments').where('received_at', '>=', dayStart(monthStart)).sum({ n: 'amount' }).first(),
    db('bill_items').groupBy('category').select('category', db.raw('sum(amount)::float as amount')),
    db('payments').groupBy('method').select('method', db.raw('sum(amount)::float as amount'), db.raw('count(*)::int as n')),
    db('bills').groupBy('status').select('status', db.raw('count(*)::int as n')),
  ]);
  const hasData = Number(billed.subtotal ?? 0) > 0 || Number(collected.n ?? 0) > 0;
  return {
    hasData, currency: env.CURRENCY, generatedAt: new Date(),
    totalBilled: Number(billed.subtotal ?? 0), totalInsurance: Number(billed.insurance ?? 0), totalPayable: Number(billed.payable ?? 0),
    totalRevenue: Number(collected.n ?? 0), outstanding: Number(outstanding.n ?? 0), outstandingBills: Number(outstanding.c ?? 0),
    todaysRevenue: todayRev, monthRevenue: Number(monthRev.n ?? 0), byCategory, byMethod, billsByStatus: counts,
  };
}

const PERIOD_SQL = { daily: 'day', weekly: 'week', monthly: 'month' };

/** UC-43: daily / weekly / monthly report for a date range. */
export async function financialReport({ period, from, to }) {
  const unit = PERIOD_SQL[period];
  const toEx = addDays(to, 1);
  const tz = env.HOSPITAL_TZ;
  const bucket = (col) => `to_char(date_trunc('${unit}', (${col} AT TIME ZONE '${tz}')), 'YYYY-MM-DD')`;
  const [billedRows, paidRows, byMethod, byCategory, insurance] = await Promise.all([
    db.raw(`SELECT ${bucket('generated_at')} AS bucket, count(*)::int AS bills, sum(subtotal)::float AS billed, sum(insurance_amount)::float AS insurance FROM bills WHERE generated_at >= ? AND generated_at < ? GROUP BY 1 ORDER BY 1`, [dayStart(from), dayStart(toEx)]),
    db.raw(`SELECT ${bucket('received_at')} AS bucket, count(*)::int AS payments, sum(amount)::float AS collected FROM payments WHERE received_at >= ? AND received_at < ? GROUP BY 1 ORDER BY 1`, [dayStart(from), dayStart(toEx)]),
    db('payments').where('received_at', '>=', dayStart(from)).where('received_at', '<', dayStart(toEx)).groupBy('method').select('method', db.raw('sum(amount)::float as amount'), db.raw('count(*)::int as n')),
    db('bill_items as i').join('bills as b', 'b.id', 'i.bill_id').where('b.generated_at', '>=', dayStart(from)).where('b.generated_at', '<', dayStart(toEx)).groupBy('i.category').select('i.category', db.raw('sum(i.amount)::float as amount')),
    db('bills as b').join('patient_insurance as pi', 'pi.id', 'b.patient_insurance_id').join('insurance_providers as ip', 'ip.id', 'pi.provider_id').where('b.generated_at', '>=', dayStart(from)).where('b.generated_at', '<', dayStart(toEx)).groupBy('ip.name').select('ip.name', db.raw('sum(b.insurance_amount)::float as amount'), db.raw('count(*)::int as n')),
  ]);
  const buckets = [...new Set([...billedRows.rows.map((r) => r.bucket), ...paidRows.rows.map((r) => r.bucket)])].sort();
  const rows = buckets.map((bk) => {
    const b = billedRows.rows.find((r) => r.bucket === bk) ?? {};
    const p = paidRows.rows.find((r) => r.bucket === bk) ?? {};
    return { period: bk, bills: b.bills ?? 0, billed: b.billed ?? 0, insurance: b.insurance ?? 0, payments: p.payments ?? 0, collected: p.collected ?? 0 };
  });
  const totals = rows.reduce((t, r) => ({ bills: t.bills + r.bills, billed: t.billed + r.billed, insurance: t.insurance + r.insurance, payments: t.payments + r.payments, collected: t.collected + r.collected }), { bills: 0, billed: 0, insurance: 0, payments: 0, collected: 0 });
  const outstanding = await db('bills').where('generated_at', '<', dayStart(toEx)).where('balance', '>', 0).sum({ n: 'balance' }).first();
  return {
    period, from, to, currency: env.CURRENCY, hospital: env.HOSPITAL_NAME, generatedAt: new Date(),
    hasData: rows.length > 0, message: rows.length ? null : 'No financial data is available for the selected period.',
    rows, totals, byMethod, byCategory, insurance, outstandingAtEnd: Number(outstanding.n ?? 0),
  };
}
